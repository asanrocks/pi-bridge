# ADR 12: Activation Lifetime and the Connection State Machine

**Status:** Proposed. Amends ADR 11 (activation lifecycle, unflushed sessions,
navigation verbs). Retains ADR 11's domain model, addresses, security rules,
and the activation reservation. Not implemented yet.

## Context

ADR 11 gave activations idle collection: when the last Connection detaches, a
GC timer starts (5 minutes; 30 for an entry-bearing unflushed session). The
implementation revealed four problems with that model.

1. **Leftover "active" sessions.** Browsing a session creates a runtime that
   then lingers as an `active` row for the grace period. `active` means
   "someone recently viewed," not "someone is viewing" — the launcher shows
   noise, and a killed runtime is invisible until the timer fires.
2. **Lifetime depends on the filesystem and on clocks.** The GC eligibility
   check runs `existsSync` (durable or empty) plus two delay constants. The
   dispose race is real: the ADR itself dedicates a paragraph to why the
   eligibility check and the disposal must share the reservation.
3. **Session switching is client-composed.** A switch is "detach, then open."
   Failure handling is client emulation: the web client optimistically commits
   the new address, then restores the old one by hand on failure, and keeps a
   candidate-mirror registry to bridge the gap. The client re-implements a
   transaction the daemon never offered.
4. **`newSession` materializes on click.** Every "New" press allocates an
   unflushed session with a UUID stem. The session list fills with rows that
   have no content, and an abandoned one holds a runtime (and non-durable
   entries) for the 30-minute cap.

One implementation defect compounds all of these: a Connection whose socket
closes while its `openSession` reservation is pending is still attached when
the reservation resolves, pinning the runtime forever. Under any grace-free
lifetime this becomes a permanent leak, so fixing it is a prerequisite of this
ADR, not an adjunct.

## Decision

Three coordinated changes, all internal to the existing wire model except for
two verb additions:

1. **Connection state machine.** The daemon tracks each Connection as
   `detached → attached(X)`, with switching to another session as one
   first-class transaction (`switch`), not detach-then-open.
2. **Refcount lifetime.** An activation lives exactly while a client is
   attached or a turn is unsettled. No timers, no filesystem checks.
3. **Drafts at first message.** `newSession` folds in the first prompt; an
   empty session is client state, not a daemon object.

## Connection state machine

Each Connection is one of:

```text
detached ──openSession(X)──► attached(X)
attached(X) ──switch(Y)──► attached(Y)
attached(X) ──detach()──► detached
```

- `openSession` is valid only when detached (cold boot, reconnect, returning
  to a URL). It resolves-or-creates as in ADR 11 and attaches.
- `switch(Y)` is valid only when attached. It is one transaction: detach from
  X, resolve-or-create Y, attach to Y — under the address reservations of both
  activations.
- `detach` unambiguously means "leaving." There is no grace period, so nothing
  about the word needs disambiguation.

### switch semantics

```ts
switch({ projectId, stem, cursor? })
  → { ok, session: SessionRef }
```

Commit: the Connection is attached to Y, its lazy subscriptions are cleared,
and the initial-sync push (replace, or cursor-aware patch carrying
`SessionRef`) is sent before the successful RPC reply. The old activation X
loses one refcount; if that drops it to zero and no turn is in flight, X
becomes kill-eligible at this boundary.

Rollback: a failed `switch` (unknown project, invalid stem, session-id
conflict, creation failure) sends `ok: false` and leaves the previous
attachment to X and the client's mirror completely untouched. No push of any
kind is sent. This is the guarantee the client currently emulates.

`switch` to the address already attached is valid and is a reattach: the
Connection re-receives a fresh initial sync (useful for cache repair), and no
refcount changes.

A `switch` away from a streaming session never aborts the turn. X keeps
running it with zero clients and stays alive until the turn settles (see
lifetime rule). This is the same behavior as a socket dying mid-turn.

### Concurrency

- Per-Connection, RPC frames are handled serially. Two navigation verbs on one
  socket must not interleave their reservations and attachments; the state
  machine makes an interleaving meaningless, and the daemon enforces it
  rather than relying on client discipline.
- Cross-Connection races keep the ADR 11 rule: resolution, creation, and
  disposal of an activation all run under its address reservation.
  `pendingActivations` still serializes concurrent opens of the same address.

## Lifetime rule

```text
persist(activation) := connectionCount > 0 || isStreaming || isCompacting
```

Nothing else. In particular:

- No GC timers, no delays, no `idleGcMs`/`unflushedIdleGcMs`.
- No filesystem in lifetime: no `existsSync` durable/empty check. The daemon
  never consults the disk to decide whether a runtime lives.
- No stickiness: "the user once worked on this session" does not persist an
  activation. A settled session is flushed and therefore durable; killing its
  runtime costs only reopen latency, and warmth is a cache policy — see
  Deferred.

The rule is enforced at two event boundaries; both re-check the predicate
under the activation reservation:

1. **Refcount→0 boundary** — last `detach`, socket close of the last attached
   Connection, or a `switch` commit that drops the old activation to zero. If
   no turn is in flight, dispose immediately.
2. **Settle boundary** — a turn ends (`isStreaming`/`isCompacting` go false)
   while the refcount is zero. Dispose at that point. Without this, the
   "socket dies mid-turn" case would leak: the refcount boundary already
   passed while the turn was in flight.

Boundary 2 gives the model its best property: a client that disconnects
mid-turn does not abort it. The paid response completes, flushes, and makes
the session durable; the activation dies when the turn settles; a reopen
shows the finished turn.

Disposal always holds the address reservation from check through completion
(the ADR 11 dispose-race invariant — now the only locking rule, since there is
no timer to race). Disposal is the normal Manager disposal path and never
deletes a session file.

### Dead-connection guard

An attach that completes after its Connection's socket has closed must not
count toward the refcount. Connection liveness is checked at attach time
(both `openSession` and `switch`); a dead Connection is not attached, and the
activation it would have pinned is evaluated as if the attach never happened.

### Accepted loss

One case loses data, by decision: a first turn that ends without producing
any assistant message (user abort, provider error) and then hits a kill
boundary. The user message was never durable — pi flushes on the first
assistant message — and dies with the runtime. This matches intent: the user
cancelled the turn that would have made the session real. It is the only
data-loss case in the model, and it replaces ADR 11's 30-minute cap, which
bounded but did not remove the same exposure.

## Drafts at first message

An empty session is client state, not a daemon object.

- The "New" action navigates to `/chat/<projectId>` and focuses the composer.
  No RPC is sent; no stem is allocated; the pending draft is invisible to
  colleagues. Draft persistence keys the pending state per project, not per
  session.
- The first send calls:

```ts
newSession({ projectId, text, images? })
  → { ok, session: SessionRef }
```

  Create and first prompt are one atomic verb. `ok` means the session was
  created, the prompt was accepted, and the Connection is attached; the
  initial-sync push precedes the reply, as with `openSession`/`switch`. The
  turn's outcome arrives through the document like any other turn. If
  creation or prompt dispatch itself fails, the activation is disposed, the
  reply is `ok: false`, and nothing is materialized — the message stays in
  the composer, and retry re-attempts creation. There is no orphan session
  holding an error.
- The client navigates to `/chat/<projectId>/<stem>` only on success.

Unflushed activations still exist — from the first prompt until the first
flush. During that window they are resolvable by `(projectId, stem)` via
`activationByAddress`, streamable, and listed with the header-creation-time
ordering. The ADR 11 machinery for this window is retained; its scope shrinks
from "until GC" to "until first settle." Multiple pending drafts are multiple
composer states; they do not exist at the daemon until sent.

## Protocol changes

```text
+ switch({ projectId, stem, cursor? })        navigation, attached only
~ newSession({ projectId, text, images? })    was ({ projectId })
~ detach()                                    same shape, immediate semantics
- openSession while attached                  was: implicit detach+open
```

`openSession` while attached returns an error (the client uses `switch`);
`switch` while detached returns an error (the client uses `openSession`). The
state machine is enforced server-side.

Everything else is unchanged: push shapes, `SessionRef` on initial sync,
compaction rules (frames carrying `session` are never compacted;
`Connection.attach` resets the codec), ADR 09 cursor semantics, `pull`,
attached-session verbs. A `sessions_changed` broadcast on activation
collection replaces the current settle-only/rename-only triggers, so other
tabs' project lists drop collected unflushed rows promptly.

### Client simplifications

- The optimistic address commit and manual restore in `openSession` are
  deleted; a failed `switch` needs no client-side repair.
- The candidate-mirror registry becomes the client's "transaction pending"
  state keyed by the in-flight verb, rather than a workaround for
  non-transactional switching.

## What gets deleted

- `gcTimers`, `armGc`/`maybeCollect` timer machinery, both GC delay constants
  and their `DaemonOptions` injection points (replaced by the two boundary
  sweeps).
- The durable/empty filesystem check in lifetime.
- The 30-minute unflushed cap, its Costs entry, and its Implementation note
  in ADR 11.
- Client-side rollback emulation and per-session draft keys for pending
  sessions.

## Explicitly deferred: warmth and reuse-by-rebind

The lifetime rule above is the *correctness* predicate — the state that cannot
be reconstructed from disk. Warmth (keeping recently-worked runtimes for fast
reopening) is a *performance* layer and is deliberately not in this ADR:

- The `switch` transaction already provides the one window that matters
  without extra machinery: X stays alive for the duration of the transaction.
- Any longer warmth needs an eviction policy (most-recently-worked per
  project, or an LRU) — a bounded cache, never a lifetime rule. Reuse by
  rebinding a Manager across sessions additionally conflicts with ADR 11's
  never-rebind invariant and ADR 10's per-Manager stamp bundle ("the host
  trigger never rebinds"), and would reopen the rebind race that invariant
  closed.
- Decision gate: measure cold `openSession` (file load, context rebuild,
  extension bind) against steady-state attach. Only if the delta is user-
  noticeable does warmth earn its complexity. If reuse-by-rebind ever lands,
  ADR 10 needs a rebind story and this ADR's lifetime rule is unchanged —
  rebind is a cache hit, not a lifetime extension.

## Testing plan

Connection state machine:

- `switch` commits: attached to Y, initial sync precedes the reply, X lost
  the refcount;
- failed `switch` rolls back: attachment to X intact, mirror untouched, no
  pushes sent;
- `switch` to the attached address reattaches with a fresh initial sync and
  no refcount change;
- `openSession` while attached and `switch` while detached are errors;
- two navigation verbs on one Connection cannot interleave (serial handling);
- `switch` away from a streaming session does not abort the turn.

Lifetime:

- last `detach` with no turn in flight disposes immediately (no delay);
- `detach` mid-turn keeps the activation until settle, then disposes — the
  settle boundary fires without any further event;
- socket death mid-turn: the turn completes and flushes; the activation dies
  at settle; reopening shows the finished turn;
- a kill-boundary check racing a concurrent `openSession` does not dispose a
  reattached activation (reservation invariant, carried from ADR 11);
- an attach completing after socket close does not pin the activation;
- a second attached Connection blocks disposal.

Drafts:

- "New" sends nothing; the project session list is unchanged;
- `newSession` with text materializes exactly one session whose first message
  is the sent text;
- failed `newSession` (prompt dispatch throws) leaves no session, no stem,
  and no runtime;
- an aborted first turn followed by detach loses the entries (documented
  accepted loss — the test asserts the loss, not a recovery);
- a colleague can open an unflushed session by stem while its first turn is
  in flight;
- activation collection broadcasts `sessions_changed` for the project.

## Consequences

### Positive

- `active` means "someone is viewing this now" — an honest launcher.
- No leftover runtimes from browsing; no timers, no clocks, no filesystem in
  lifetime; the dispose lock is the only concurrency rule.
- Switching is transactional server-side; the client deletes its rollback
  emulation and shrinks the candidate-mirror machinery.
- Drafts are invisible, so the session list contains only sessions that exist.
- Mid-turn disconnects finish the paid turn instead of aborting it.

### Costs

- Reopening a worked-on session pays cold-open latency (deferred warmth).
- The one accepted loss: aborted/errored first turns are not durable.
- Protocol v2 and the client move together (as with ADR 11).
- The daemon needs per-Connection message serialization and the settle-
  boundary sweep — the "daemon must be smart" cost, judged manageable against
  the deleted timer machinery.

## Relationship to other ADRs

- **ADR 11:** amended. Activation lifecycle (idle collection, GC timers,
  durable/empty check, 30-minute cap) is replaced by the refcount rule;
  unflushed sessions shrink to the first-turn window; the navigation verb
  list gains `switch` and a prompt-bearing `newSession`. Everything else —
  Project/Session domain, addresses, containment, reservation, wire shapes —
  is retained.
- **ADR 02 / ADR 09:** unchanged. Cursor semantics and cache identity are
  untouched; `switch` carries the cursor the way `openSession` does.
- **ADR 10:** unchanged, *because* reuse-by-rebind is deferred. If rebind
  ever lands, ADR 10's per-Manager stamp bundle needs a rebind story.
- **ADR 06 / ADR 08:** unaffected; this ADR stays within the typed domain
  protocol.

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

One implementation detail must move in lockstep: `attachConnection` already
guards a socket that closed while its `openSession`/`newSession` reservation
was pending (`conn.isDisposed` — no attach happens), but its fallback is
`armGc`, which this ADR deletes. That fallback must become the refcount→0
evaluation, or the orphaned activation leaks permanently under a grace-free
lifetime. The re-pointing is a prerequisite, not an adjunct.

## Decision

Three coordinated changes, all internal to the existing wire model — no new
verbs, three verb changes (`openSession` gains switch semantics, `newSession`
gains a required first message, `listFiles` is re-addressed to the Project):

1. **Connection state machine.** The daemon tracks each Connection as
   `detached → attached(X)`, with switching to another session as one
   first-class transaction (`openSession` while attached), not
   detach-then-open.
2. **Refcount lifetime.** An activation lives exactly while a client is
   attached or a turn is unsettled. No timers, no filesystem checks.
3. **Drafts at first message.** `newSession` folds in the first prompt; an
   empty session is client state — a *floating draft* — not a daemon object.

## Connection state machine

Each Connection is one of:

```text
detached ──openSession(X)──► attached(X)
attached(X) ──openSession(Y)──► attached(Y)
attached(X) ──detach()──► detached
```

- `openSession` is the single attach verb, valid in both states. Detached
  (cold boot, reconnect, returning to a URL), it resolves-or-creates as in
  ADR 11 and attaches. Attached, it is one transaction: detach from X,
  resolve-or-create Y, attach to Y — under the address reservations of both
  activations. One verb, not two state-dependent ones: the client is
  URL-driven and must not mirror daemon-side state (which drifts after
  reconnects and failed ops) just to pick a verb.
- `detach` unambiguously means "leaving." There is no grace period, so nothing
  about the word needs disambiguation.

### Switch semantics (`openSession` while attached)

```ts
openSession({ projectId, stem, cursor? })    // while attached
  → { ok, session: SessionRef }
```

Commit: the Connection is attached to Y, its lazy subscriptions are cleared,
and the initial-sync push (replace, or cursor-aware patch carrying
`SessionRef`) is sent before the successful RPC reply. The old activation X
loses one refcount; if that drops it to zero and no turn is in flight, X
becomes kill-eligible at this boundary.

Rollback: a failed switch (unknown project, invalid stem, session-id
conflict, creation failure) sends `ok: false` and leaves the previous
attachment to X and the client's mirror completely untouched. The no-push
guarantee is transaction-scoped: the switch itself sends no push of any
kind to any client — no initial-sync frame, and none of the
`active_sessions_changed`/`sessions_changed` broadcasts its own steps
could generate. Broadcasts from concurrent, unrelated lifecycle events (a
settle in another session, another activation's collection) still flow:
they carry true state, and suppressing them would drop real updates to
other tabs. The client rollback emulation this replaces was about the
mirror and the address, which no concurrent broadcast touches.

The ordering that makes this implementable: every fallible step — resolving
or creating Y, the session-id conflict check — runs before the first
mutation of X. Commit order is reserve Y, detach X, attach Y (initial-sync
push), reply. The commit point is the transport, not the code path: the
transaction commits when the initial-sync frame is accepted by the socket.
A socket that dies between the push and the reply leaves the daemon
attached to a dead Connection — harmless; the close handler releases it
and the boundary evaluation runs — while the client reconnects by URL, so
`send()` swallowing socket errors can only convert a committed transaction
into one the client never learned about. A synchronous throw while
attaching Y, before any frame was emitted, is the one post-detach failure:
re-attach X, then reply `ok: false`.

A created-but-not-yet-committed Y is *staged*: it is resolvable by address
(concurrent opens of the same address share it, per the ADR 11 reservation)
but is not yet part of the publicly projected activation set, and its
registration broadcasts are deferred until the transaction commits.
Publishing at registration — the ADR 11 behavior — would leak a target that
a later step can still fail out of, breaking the transaction-scoped
no-push guarantee. A staged activation that fails out is disposed silently:
it was never part of the publicly projected set, so neither its creation
nor its disposal broadcasts anything.

`openSession` for the address already attached is a reattach: the Connection
re-receives a fresh initial sync (useful for cache repair), and no refcount
changes.

Switching away from a streaming session never aborts the turn. X keeps
running it with zero clients and stays alive until the turn settles (see
lifetime rule). This is the same behavior as a socket dying mid-turn.

### Concurrency

- Per-Connection, a state-transition lane is handled serially: the navigation
  verbs (`openSession`, `newSession`, `detach`) plus the
  attached-session verbs that act on the current attachment (`prompt`,
  `abort`, `discardSteer`, `setModel`, `setThinkingLevel`, `renameSession`,
  `navigate`), plus `pull` (see below). Two state transitions on one
  socket must not interleave their reservations and attachments; the
  state machine makes an interleaving
  meaningless, and the daemon enforces it rather than relying on client
  discipline. Query verbs (`listSessions`, `listActiveSessions`,
  `getDaemonInfo`, `listFiles`, `readFile`, `gitShow`) run outside the
  lane: they are read-only against the current attachment, and a slow one
  (a timed `gitShow` spawn, a 256 KB `readFile`) must not block
  navigation. `pull` is the exception: fast (a synchronous in-memory
  read) but not read-only — it mutates the Connection's lazy-subscription
  set, which attach clears, so a pull racing a switch could install
  old-session subscriptions after the new initial sync. `readFile` and
  `gitShow` capture the attached Manager when they start and resolve
  against it, so a reply landing after a switch describes the repository
  the requester asked under. The lane holds `prompt` only until admission
  (see Reply semantics), never for a whole turn, and attached-session
  verbs act on the activation captured when the lane was entered — so an
  admitted turn and a navigation on the same socket are linearized rather
  than racing the attachment swap.
- Cross-Connection races keep the ADR 11 rule: resolution, creation, and
  disposal of an activation all run under its address reservation.
  `pendingActivations` still serializes concurrent opens of the same address.
  The switch transaction's "reservations of both activations" means reusing
  this per-address await-and-retry loop — never holding two reservations as
  locks across the transaction, which would deadlock on opposing switches
  (A: X→Y while B: Y→X).

### Reply semantics

Each verb's reply carries an explicit per-verb contract. This is what makes
the lane implementable: admission-style verbs release the lane while the
work continues; completion-style verbs are short by construction.

| Verb | `ok: true` means |
|---|---|
| `prompt` | **Admission.** The message passed preflight and was queued or started; the turn's outcome arrives through the document. |
| `abort` | The run stopped and its final patches have been emitted. |
| `openSession` | The attachment transaction committed; the initial-sync push preceded the reply. |
| `newSession` | The session was created, the first prompt was admitted, and the Connection is attached. |
| `detach` | The Connection was removed from its activation. |
| `executeBash` | The command completed. |
| `setModel` / `setThinkingLevel` / `renameSession` / `navigate` / `discardSteer` | The operation completed (synchronous throws reply `ok: false` immediately). |
| Queries (`listSessions`, `listActiveSessions`, `getDaemonInfo`, `listFiles`, `readFile`, `gitShow`) | The query completed. |
| `pull` | The query completed (lane-serialized despite query semantics — see Concurrency). |

`prompt` is admission-style, not completion-style: pi's `preflightResult`
callback fires immediately before the agent run starts, and that is the
moment the reply resolves. A preflight failure (no model, no auth, an input
extension rejecting the message) rejects before any turn state exists. The
Manager therefore gains an admission-style prompt alongside the
completion-style one (which disposal keeps using). Any future
model-consuming operation that runs outside a turn — a manual `compact`, a
summarizing `navigateTree` — needs the same admission treatment before it
may join the lane.

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
   Connection, or an `openSession` switch that drops the old activation to
   zero. If no turn is in flight, dispose immediately.
2. **Settle boundary** — a turn ends (`isStreaming`/`isCompacting` go false)
   while the refcount is zero. Dispose at that point. Without this, the
   "socket dies mid-turn" case would leak: the refcount boundary already
   passed while the turn was in flight.

   The settle signal is the existing `manager.onSettled` (fires on
   `turn_end` and `agent_settled`; `agent_settled` is pi's full-idle
   predicate — no agent run, compaction, branch summary, retry, or queued
   continuation). A premature `turn_end` is harmless because the boundary
   re-checks the predicate; `agent_settled` fires again once compaction
   ends. Within the bridge, compaction is always turn-internal
   (auto-compaction runs before the next assistant response inside a run),
   and pi's manual `compact()` has no bridge verb — but pi's extension API
   exposes `context.compact()` (fire-and-forget) and summarizing
   `navigateTree()`, and the bridge loads extensions into every runtime.
   Both are declared out of scope for bridge-loaded extensions: manual
   compaction emits no `agent_settled`, so the settle boundary never fires
   after it — a zero-refcount activation that defers during compaction
   would never be re-evaluated — and the compaction-start edge has the
   same pre-observable window as an admitted prompt. The document's
   `isCompacting` flag still holds an activation once `compaction_start`
   has been observed; the exposure is the start edge and the missing
   settle signal. The predicate re-check keeps turn-internal compaction an
   optimization, not a correctness assumption.

Boundary 2 gives the model its best property: a client that disconnects
mid-turn does not abort it. The paid response completes, flushes, and makes
the session durable; the activation dies when the turn settles; a reopen
shows the finished turn.

**Admitted-work window.** pi invokes `preflightResult(true)` before the
agent run starts, and the Document reports `isStreaming` only at the later
`agent_start` event; an admitted prompt can also complete without ever
starting a run (a handled extension command). In that window an activation
can show zero connections and no streaming flag while a just-admitted
prompt is starting — exactly the state both kill boundaries act on, and
the window applies to `prompt` on an attached session just as much as to
`newSession`'s first turn. Both boundaries therefore also treat *admitted
work* as in-flight: a prompt whose admission succeeded and whose dispatch
has not yet settled into observable state (the document streaming, or the
dispatch completed). The Manager exposes this as a single daemon-internal
boolean (admission succeeded on a pending dispatch); it never crosses the
wire and does not join the client-visible state projection. When admitted
work settles without ever producing a stream, that settle itself
triggers the refcount→0 evaluation — otherwise the activation would leak.

### User-facing session states

Attachment is daemon-internal and is not first-class wire information; it
only selects when an idle activation is collected. Clients project exactly
three states from `SessionInfo`:

```text
streaming = isStreaming                 (isCompacting folds into streaming)
idle      = active && !isStreaming      (runtime retained, attached)
inactive  = !active && !isStreaming     (no runtime; a file row)
```

A detached activation still finishing its turn projects as `streaming` —
the in-flight work is visible, the viewer count is not. `active` therefore
means "a runtime is retained", which includes disconnected in-flight work;
it does not mean "someone is viewing this now".

Disposal always holds the address reservation from check through completion
(the ADR 11 dispose-race invariant — now the only locking rule, since there is
no timer to race). Disposal is the normal Manager disposal path and never
deletes a session file.

### Dead-connection guard

An attach that completes after its Connection's socket has closed must not
count toward the refcount. Connection liveness is checked at attach time
(every attach path — `openSession` and `newSession`, either state); a dead
Connection is not attached, and the activation it would have pinned is
evaluated as if the attach never happened.

### Reservation ownership

Between reserving an activation and attaching the Connection, the activation
has no refcount and may not be streaming — exactly the state the kill
boundaries act on. The reservation owns the activation for that interval:
a kill-boundary evaluation treats a reserved-but-unattached activation as
live, and a reservation that ends without an attach (failed open, closed
socket) itself triggers the refcount→0 evaluation. The same-address
reattach is the degenerate case: it must swap the Connection's attachment
without passing through a zero-refcount state, or the activation can be
collected out from under its own reattach.

### Accepted loss

One case loses data, by decision: a first turn that ends without producing
any assistant message (user abort, provider error) and then hits a kill
boundary. The user message was never durable — pi's `_persist` flushes the
file on the first persist after an assistant entry exists, and an aborted
turn with partial assistant content still flushes, so only a turn with no
assistant output at all leaves nothing on disk — and the entries die with
the runtime. This matches intent: the user cancelled the turn that would
have made the session real. It is the only data-loss case in the model, and
it replaces ADR 11's 30-minute cap, which bounded but did not remove the
same exposure.

## Drafts at first message

An empty session is client state, not a daemon object. The web client calls
this a *floating draft* — deliberately not a "floating session", because
nothing session-shaped exists at the daemon until the first message is sent.

- The "New" action navigates to `/chat/<projectId>` and focuses the composer.
  No RPC is sent; no stem is allocated; the pending draft is invisible to
  colleagues. The composer mounts at the Project home — the same component
  as the session composer. `/launcher` keeps no composer: there is no
  Project to address a draft to.
- The floating draft is the existing composer-draft machinery re-keyed:
  stem set → the session-keyed slot (today's behavior); stem null, Project
  set → a `project:<projectId>` slot. Switching Projects must save under
  the old key before clearing and restore from the new one — the same
  stale-key race the session slot's restore already guards against, and
  tested explicitly.
- The first send calls:

```ts
newSession({ projectId, text, images?, model?, thinkingLevel? })
  → { ok, session: SessionRef }
```

  `text` is required — the server rejects a textless `newSession`, so no
  path materializes an empty session, even against a stale client. Create
  and first prompt are one atomic verb. `ok` means the session was created,
  the first prompt was admitted, and the Connection is attached; the
  initial-sync push precedes the reply, as with `openSession`. While
  attached, `newSession` is a transactional switch into the new session —
  same rule, old attachment untouched on failure. The turn's outcome
  arrives through the document like any other turn.

  The commit order dissolves the push-before-preflight problem: create the
  Manager (honoring `model`/`thinkingLevel`), admit the prompt, then attach.
  Events between admission and attach land in the canonical document before
  any Connection exists to miss them; the initial sync snapshots that
  document synchronously at attach, and everything after flows as live
  patches — no gap, no buffering. A prompt-admission failure rejects before
  any turn state exists: the staged activation is disposed, the reply is
  `ok: false`, nothing was registered or pushed — the message stays in the
  composer, and retry re-attempts creation. There is no orphan session
  holding an error.
- The client does not navigate by hand on success: the initial-sync
  `replace` push already commits the address and writes the route, so the
  URL and store update as a consequence of the server commit.
- `model`/`thinkingLevel` are optional *overrides*. When absent, the
  daemon builds the runtime with its existing resolution (settings /
  modelRuntime defaults) — exactly what pi itself would use for a new
  session in the Project cwd — so the common case sends neither, and a
  user who wants a different model sets it after attach (`setModel`; one
  click, no loss). A pre-session pick is convenience, deliberately
  deferred from the first implementation; if it lands, it is client-side
  per-Project state (a localStorage map, the addressIndex pattern), never
  daemon-side configuration: a shared, lifetime-bearing per-Project
  settings object would reintroduce the floating-session problem in
  miniature.

### Pre-send composer needs

Everything the composer wants before the first message is Project-scoped,
not instance-scoped: the model catalog (already global in `getDaemonInfo`),
per-model thinking levels, path completion, and — when they land — the
skills and prompt-template listing. `listFiles` is therefore re-addressed
to take `projectId` and resolve against the Project cwd; its attachment
requirement was incidental, just how the cwd was sourced. Skills and
templates resolve from disk against the Project cwd, so the daemon serves
them from a per-Project inert resource loader — a shadow of configuration,
never a runtime. (The daemon's current extension loading reads
`process.cwd()`; project-scoped queries require per-Project loaders.) The
only things an activation uniquely provides are the Document and turn
execution, and neither exists before the first message.

Unflushed activations still exist — from the first prompt until the first
flush. During that window they are resolvable by `(projectId, stem)` via
`activationByAddress`, streamable, and listed with the header-creation-time
ordering. The ADR 11 machinery for this window is retained; its scope shrinks
from "until GC" to "until first settle." Multiple pending drafts are multiple
composer states; they do not exist at the daemon until sent.

## Protocol changes

```text
~ openSession({ projectId, stem, cursor? })   same shape; while attached, a
                                              transactional switch (was:
                                              implicit detach+open)
~ newSession({ projectId, text, images?,      was ({ projectId }); `text` is
              model?, thinkingLevel? })       required; same transactional
                                              rule while attached
~ listFiles({ projectId, prefix })            was attachment-scoped; resolves
                                              against the Project cwd.
                                              `readFile`/`gitShow` stay
                                              attachment-scoped — their
                                              paths belong to the attached
                                              session's repository
~ detach()                                    same shape, immediate semantics
```

The state machine is enforced server-side and is invisible on the wire: one
attach verb serves both states, so the client never mirrors daemon-side
state to choose a verb. What folding costs: the traffic log no longer
distinguishes a switch from a cold open by verb — the initial-sync frame's
`SessionRef` still shows the address change.

Everything else is unchanged: push shapes, `SessionRef` on initial sync,
compaction rules (frames carrying `session` are never compacted;
`Connection.attach` resets the codec), ADR 09 cursor semantics, `pull`,
and the attached-session verbs other than the `listFiles` re-addressing
above. The settle and rename `sessions_changed` triggers
are retained — the first settle after a flush still reorders the list
(header-creation time → mtime) and surfaces file metadata — and activation
collection adds a third, so other tabs drop collected unflushed rows
promptly. The collection trigger is scoped: a durable session's collection
does not change the list (its file row persists), so only an activation
that never flushed broadcasts.

### Client simplifications

- The optimistic address commit and manual restore in `openSession` are
  deleted; a failed attach in either state needs no client-side repair.
- The candidate-mirror registry becomes the client's "transaction pending"
  state keyed by the in-flight verb, rather than a workaround for
  non-transactional switching.
- The floating draft needs no new store concept, but two real client
  changes: the composer mounts at the Project home (Project set, no stem)
  with its commit path branching to `newSession`, and the draft-persistence
  key becomes address-derived — the session-id slot while a stem is set,
  `project:<projectId>` when not — with the same save-before-clear ordering
  the session slot's restore already guards against. Every "New" control
  navigates instead of sending an RPC.

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

- The `openSession` switch transaction already provides the one window that
  matters without extra machinery: X stays alive for the duration of the
  transaction.
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

- `openSession` while attached commits: attached to Y, initial sync precedes
  the reply, X lost the refcount;
- a failed `openSession` while attached rolls back: attachment to X intact,
  mirror untouched, no switch-generated pushes sent;
- a staged activation that fails out is disposed silently (no registration
  or collection broadcast);
- `openSession` for the attached address reattaches with a fresh initial
  sync and no refcount change;
- `openSession` behaves identically from both states — no client-side state
  mirroring to pick a verb;
- two state transitions on one Connection cannot interleave (serial lane),
  and a slow query verb (`gitShow`) does not block navigation;
- a `pull` issued before a switch cannot install old-session subscriptions
  after the new initial sync (lane serialization);
- a prompt admission does not hold the lane — `openSession`/`abort` on the
  same socket proceed while the admitted turn is still streaming;
- switching away from a streaming session does not abort the turn.

Lifetime:

- last `detach` with no turn in flight disposes immediately (no delay);
- `detach` mid-turn keeps the activation until settle, then disposes — the
  settle boundary fires without any further event;
- socket death mid-turn: the turn completes and flushes; the activation dies
  at settle; reopening shows the finished turn;
- a kill-boundary check racing a concurrent `openSession` does not dispose a
  reattached activation (reservation invariant, carried from ADR 11);
- an attach completing after socket close does not pin the activation;
- socket death between prompt admission and `agent_start` does not dispose
  the activation (admitted-work window);
- a second attached Connection blocks disposal.

Drafts:

- "New" sends nothing; the project session list is unchanged;
- `newSession` without text is rejected;
- `newSession` without `model`/`thinkingLevel` builds the runtime from
  daemon defaults;
- `newSession` with text materializes exactly one session whose first message
  is the sent text;
- the `newSession` initial-sync push already reflects the first user
  message (or it arrives as the first live patch — both orderings are
  correct, none is a gap);
- failed `newSession` (prompt dispatch throws) leaves no session, no stem,
  no runtime, no registration broadcast, and no push to any connection;
- the floating draft survives a Project switch (saved under the old
  Project's key, restored from the new one's);
- `listFiles` completes paths against the Project cwd with no attachment;
- an aborted first turn followed by detach loses the entries (documented
  accepted loss — the test asserts the loss, not a recovery);
- a colleague can open an unflushed session by stem while its first turn is
  in flight;
- activation collection of an unflushed session broadcasts
  `sessions_changed` for the project; collecting a durable session does
  not (its file row is unchanged);
- the first settle after a flush still broadcasts `sessions_changed` (list
  reorders from header-creation time to mtime, metadata appears);

## Consequences

### Positive

- Three honest user-facing states — streaming, idle, inactive — with a
  detached in-flight turn still showing as streaming.
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
- The daemon needs a per-Connection state-transition lane, the
  settle-boundary sweep, and an admitted-work signal on the Manager — the
  "daemon must be smart" cost, judged manageable against the deleted timer
  machinery.
- The web client mounts the composer at the Project home and re-keys draft
  persistence by address — no new store concept, but not a free change.
- Project-scoped queries need per-Project resource loaders (the daemon's
  current extension loading reads `process.cwd()`).

## Relationship to other ADRs

- **ADR 11:** amended. Activation lifecycle (idle collection, GC timers,
  durable/empty check, 30-minute cap) is replaced by the refcount rule;
  unflushed sessions shrink to the first-turn window; the navigation
  verbs gain a prompt-bearing `newSession`, `openSession` gains
  transactional switch semantics while attached, and `listFiles` moves from
  the attached-session list to the Project-scoped query list. Everything
  else — Project/Session domain, addresses, containment, reservation —
  is retained.
- **ADR 02 / ADR 09:** unchanged. Cursor semantics and cache identity are
  untouched; the cursor travels on `openSession` in both states.
- **ADR 10:** unchanged, *because* reuse-by-rebind is deferred. If rebind
  ever lands, ADR 10's per-Manager stamp bundle needs a rebind story.
- **ADR 06 / ADR 08:** unaffected; this ADR stays within the typed domain
  protocol.

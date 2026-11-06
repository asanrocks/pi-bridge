# ADR 0022: Durable session states — the user-visible lifecycle

**Status:** Proposed. Amends ADR 12 (its "user-facing session states" projection
is superseded); leaves ADR 11's idle collection in place as resource policy.

## Context

A user runs several agents in parallel and treats sessions as a work queue:
which conversations await my input, which are running, which I parked for later,
and which are done. The bridge today derives every user-visible session fact
from *runtime retention*: `SessionInfo.active` means "an Activation exists" and
`isStreaming` means "that runtime is streaming". Three defects follow, all
visible in the current UI:

1. **Browsing creates queue entries.** Opening a session to skim it creates an
   Activation, so the session appears in the launcher's active list and the
   sidebar's pinned section — for the full idle-GC grace period — as if it were
   work in progress. The user did nothing but read.
2. **The queue evaporates on restart.** Idle collection and daemon restarts
   remove Activations, and with them every "active" row. A session that finished
   its turn and is waiting for the user is indistinguishable from last month's
   finished history: the attention state was never durable.
3. **There is no parking state.** A complicated session the user wants to
   revisit later can only be left to sink down the mtime-ordered history, with
   no way to say "not finished, but not now".

The root cause is a conflation: the Activation is an execution resource, but
the UI presents it as the session's lifecycle. ADR 12 already separates the
concerns for *lifetime* (its refcount rule keeps runtimes alive only while
attached or unsettled) but then re-derives the user-facing states from the same
retention facts (`streaming / idle / inactive`). This ADR finishes the
separation: the user-visible lifecycle becomes its own durable state, owned by
the Worker's storage, and the Activation becomes what it always should have
been — a disposable runtime.

## Decision

**Each session carries a durable, user-visible state with four values, persisted
by the Worker independently of any runtime:**

```text
inactive | notified | busy | deferred
```

- **inactive** — the default. A file row in history; nothing is owed.
- **busy** — execution is in flight: a prompt was admitted and the run has not
  fully settled.
- **notified** — the agent finished its turn and awaits input. The session
  needs the user's attention.
- **deferred** — the user parked a non-busy session. It is not finished, but it
  is not next; it sorts last in the queue.

The set of non-inactive sessions is the **work queue** (composed term: the
user's queue of sessions that owe or demand attention). The states are bound
terms at merge (glossary A); "queue" is composed, not coined.

### Transition rules

| Event | Before | After |
| --- | --- | --- |
| Prompt admission succeeds (any session, any state) | any | busy |
| Execution fully settles (see Completion below) | busy | notified |
| User defers | notified | deferred |
| User restores | deferred | notified |
| User closes (the `closeSession` verb) | any | inactive |
| Browse / open / skim / detach | any | unchanged |
| Idle collection of the Activation | any | unchanged |
| Worker restart finds a persisted `busy` | busy | notified |

Rules that make the model coherent:

- **Browsing never changes state.** Opening, reading, and detaching manipulate
  the Activation only. The catalog's live overlay keeps preview fields fresh;
  the durable state is untouched.
- **Busy covers the whole execution**, not just streaming: from admission
  through tools, retries, compaction, and queued steering, until full
  settlement. A steer admitted mid-turn keeps the session busy (it is one
  continuing execution).
- **Deferred is presentation, not a sticky mode.** A new prompt on a deferred
  session makes it busy, and its next settle makes it notified again. Defer
  only affects sorting and indicators.
- **Defer/restore is refused while busy** (the state machine owns the toggle;
  the UI hides the action instead). The toggle is legal on a dormant session —
  no runtime is needed, it is a storage write.
- **Notified means "awaits input", not "unread".** Reading a notified session
  does not clear it; only defer or close does. The queue is cleared manually —
  that is the model's point.
- **Transitions are decided inside the store, not merely written.** The state
  store's serialized queue is the single transition authority, and every
  request carries its evidence: a user toggle carries its precondition
  ("not busy"), and the queue's own evaluation checks it — not the caller,
  which may have raced an admission; a completion carries the identity of
  the execution it settles (a token minted at admission), so the settle of
  a superseded execution cannot mark notified a session that a newer prompt
  already made busy.
- **Close wins over its own completion, not over a newer prompt.** Closing a
  busy session aborts and flushes the turn; the abort's settle write and the
  close's write go through the queue, the close's enqueued only after
  collection resolved — and collection awaits disposal, which is what fires
  the settle hook — so the close's `inactive` is the last write *for that
  execution*. A prompt admitted after the close began (another tab re-opening
  the session on a fresh Activation) is a newer user intent: the close's
  write is skipped, the session stays busy, and the close reply still
  reports the disposal it performed. A close of a session in the
  admitted-but-not-yet-streaming window is covered by the same ordering
  (no settle fires; the close still writes last).

### Completion

The busy → notified transition keys on **full execution settlement**, not on
intermediate turn boundaries. The signal is pi's `agent_settled` — the
full-idle predicate (no agent run, compaction, branch summary, retry, or
queued continuation) — plus the admitted-work window ADR 12 already defines:
an admitted prompt that completes without ever starting a run (a handled
extension command) settles through its dispatch completion, not through a
stream that never existed. `turn_end` alone is **not** a completion signal; it
fires between model/tool cycles inside one execution.

Today the Manager's `onSettled` conflates `turn_end` and `agent_settled`. The
completion signal must be exposed separately before this ADR's transitions are
implemented (see Implementation notes).

Recovery (ADR 16) is execution too, on both of its paths: `recoverTurn`'s
"continue" sends a relay prompt through the ordinary prompt machinery, and
its "retry" runs pi's silent continuation — which fires no `agent_settled`
at all and is invisible to `AgentSession.isStreaming`. Every execution entry
point must report admission and full completion through the same seams: a
session mid-recovery is busy, and the continuation's compensated end is its
completion.

### Persistence and recovery

The state store is Worker-owned storage, next to the sessions it describes:

- One JSON file per Project at `<sessionDir>/.pi-bridge/states.json`, held
  under the same storage exclusion the Worker already owns for that directory
  (`storage-lock.ts`). The catalog scanner reads only `*.jsonl`, so the file is
  invisible to discovery; `normalizeStem` never resolves to it (it has no
  `.jsonl` form).
- Shape: `{ version: 1, sessions: { [sessionId]: { state, updatedAt } } }` —
  keyed by the durable session id, carrying no address. The address is
  re-derived at read time (the scan maps file → header id → state), so a
  manually moved or renamed session file keeps its state.
- Writes are serialized (one at a time, arrival order — the same discipline as
  `setPinnedModels`) and atomic (temp file + rename).
- **A missing file is the normal first state** (all inactive): state is an
  overlay on durable conversation content, never a precondition for it.
- **A present but unreadable or corrupt file is an error, not a reset.** The
  Worker quarantines it (renames it to a `.corrupt` sibling, never
  overwrites it), starts a fresh store, and surfaces the failure through
  the existing event machinery so the operator knows queue state was lost.
  Silently degrading here would make unfinished work disappear — the defect
  this ADR exists to fix.
- **Write failures split by intent.** A turn-boundary write (admission → busy,
  settle → notified) never fails or blocks the execution it reports: the
  state degrades to in-memory, the failure is surfaced, and the next
  transition retries the persist — a restart inside that window loses the
  queue entry (recovery's safe default), which the surfaced failure has
  already warned about. A user-action write (defer, restore, close) is
  durable-or-fail: the verb succeeds only after the write persisted, so a
  failed write is a retryable error, not a silently lost intent.

Recovery at Worker startup:

- Load the file. Every persisted `busy` becomes `notified` — the Worker's
  process died with the runtimes, so nothing is executing; the conversation's
  tail shows the interrupted outcome (a broken tail goes through ADR 16's
  recovery, unchanged). No persisted interruption flag: the Document already
  presents the outcome.
- A record whose session file does not exist and which has no live activation
  is dropped. This is ADR 12's accepted loss made visible: a first turn that
  never flushed has no durable conversation, so there is nothing to be
  notified about. (Persisting the busy marker *before* the first flush cannot
  save the conversation; it can only create a queue entry pointing at nothing.
  The record is written at admission like any other, and recovery prunes it.)
- Records for archived sessions are pruned by `archiveSession` (which already
  closes first) and by the same startup scan.
- Graceful shutdown settles instead of suppressing: disposal of a busy
  session finalizes the in-flight turn, which fires the same completion
  hook any abort does, and the store lets the write land — busy becomes
  notified during the shutdown drain, exactly what the next boot's rewrite
  would produce anyway. No suppression machinery is needed, and crash and
  clean shutdown converge on the same restored queue. The store's queue
  drains before Worker disposal resolves, so the write is not lost to the
  exit.

### Wire and contract changes

```text
~ SessionInfo: + state: "inactive" | "notified" | "busy" | "deferred"
               - active, isStreaming          (superseded; execution detail
                                               stays in the Document)
~ listActiveSessions (Worker) → listQueue:   the global non-inactive snapshot,
                                             ordered notified → busy → deferred,
                                             then last-activity desc
~ active_sessions_changed (push) → queue_changed: same content, new name —
                                             it is no longer an activation
                                             report
+ setSessionState { projectId, stem, state: "notified" | "deferred" }
                                             the toggle verb; refused while
                                             busy; legal on a dormant session
                                             (the Worker resolves stem →
                                             header sessionId → record)
~ closeSession: now also writes inactive and is legal on a dormant session
                (today it errors with "Session is not active"); with a live
                runtime it keeps today's collect-then-notify behavior
```

The Worker service (`worker-contract.ts`) gains `setSessionState(address,
state)` and the renamed queue listing; the Daemon forwards the verb by Project
as it does every session verb, and republishes `queue_changed` as the aggregate
of its registrations — a Worker whose link is down contributes no queue rows,
exactly as its Projects answer nothing else today.

`listSessions` pages keep their mtime ordering and carry `state` per row;
deferred and notified rows remain in history. The queue is the separate global
view: the launcher's session list and the sidebar's pinned section become the
queue (per-Project slice in the sidebar), replacing "has a live instance" as
the pinning criterion.

`@latest` (ADR 13) resolves to the most recently active session whose state
is notified or busy — deferred is excluded, because that state's own meaning
is "not next". A scope whose queue holds only deferred sessions resolves as
though the queue were empty: today's fallbacks (most recent durable session,
then the scope's home) apply unchanged. One resolution rule, no special cases
at the alias.

### UI presentation

- Queue order: **notified → busy → deferred**, each group by last activity
  descending. Notified first: it is the work waiting for *the user*; busy work
  will demote itself into notified when it lands; deferred is parked by
  decision.
- Indicators derive from `state` alone. Busy replaces the streaming pulse;
  notified and deferred get distinct marks (design.md owns the exact
  treatment; ADR 18's identity/position rules are untouched — state is a third
  dimension carried by the row's own mark column, like the existing dot).
- Defer/restore is a row-menu action on non-busy queue rows; close remains the
  existing destructive action, now also clearing queue membership.
- Multiple tabs converge through the `queue_changed` broadcast; two concurrent
  toggles are last-writer-wins through the state store's serialized queue.

## Alternatives considered

**Derive the queue from retention (status quo / ADR 12's projection).**
Rejected: it is the defect. Browsing pollutes the queue, restarts clear it,
and there is no parking state — all three follow from runtime retention being
the only signal.

**Client-side queue state (IndexedDB, like drafts and cache).** Rejected: the
queue must survive the client, be shared across tabs and clients, and be
observable by any future CLI client. It is daemon-side, Worker-persisted state
— the same reasoning that put session listing server-side.

**Persist state inside the session JSONL (a queue entry per transition).**
Rejected: the JSONL is pi's durable conversation, appended by pi's own event
loop; the bridge would need write access at turn boundaries it only observes,
and every reader (including pi itself) would have to skip bridge bookkeeping.
A sidecar file keeps ownership clean.

**A `deferred`-only flag (two-value overlay: deferred or not).** Rejected: it
fixes parking but not durability of notified/busy — restart would still lose
the "awaits input" fact, which is the parallel-work story's core.

**Make `closeSession` mean "abort the turn" (Stop) and add a separate verb for
INACTIVE.** Rejected as the primary split: Stop already exists (`abort`), and
two near-synonymous close verbs would be indistinguishable at the row menu.
Stop stays `abort` (leaves the session notified — the aborted outcome is
visible content); Close is `closeSession` (makes it inactive, aborting first
if needed). One verb per intent, no mode flag.

## Consequences

**Positive**

- Browsing is inert: the queue contains only sessions the user put there or
  execution put there, and reading never changes membership.
- The queue survives daemon restarts, Worker restarts, and crashes; a
  mid-turn kill becomes a notified row with the interrupted tail visible.
- Parallel work gets a real attention model: notified rows are the inbox,
  busy rows are in flight, deferred rows are parked — each with distinct
  presentation and deterministic order.
- The Activation becomes honestly disposable: idle collection, unflushed-GC
  timers, and future warmth policies (ADR 12's deferred work) change latency
  only, never what the user sees.

**Costs**

- A new persisted file per Project and a serialized writer to maintain; state
  writes ride turn boundaries (admission, settle, close, and the recovery
  continuation's compensated end), so the completion signal must be exact
  (the `agent_settled`-vs-`turn_end` split).
- Wire churn: `SessionInfo` loses two fields and gains one, one push is
  renamed, one verb is added, and `closeSession` changes meaning for dormant
  sessions. Daemon and web client move together, as with every protocol
  change in this package.
- The launcher/sidebar re-learn their pinning criterion (queue membership, not
  liveness), and `@latest` resolution changes source.
- The accepted loss gets a visible shape: a first turn that never flushed
  leaves no queue entry after recovery, by decision (the conversation it would
  point at does not exist).

## Implementation notes

Three preparatory changes, in order:

1. **Expose full completion separately.** The Manager's `onSettled` fires for
   both `turn_end` and `agent_settled`; add a distinct full-settlement signal
   (`agent_settled` plus the admitted-work settle ADR 12 defines, plus the
   recovery continuation's compensated end) so the busy→notified transition
   has one unambiguous trigger.
2. **Unify the first-prompt path.** `createSession`'s pre-attach
   `promptAdmitted` call and the attached `prompt` verb currently take
   different code paths; both must report admission to the state store through
   one implementation.
3. **Route recovery through the same seams.** `recoverTurn` admits execution
   on both of its paths — the relay prompt and the silent continuation,
   which fires no `agent_settled` and reports no streaming state — so both
   must report admission and completion to the state store like any other
   execution.

The state store is a new Worker-side module (sibling of `session-catalog.ts`),
not registry state: the Activation registry keeps owning runtimes and stays
state-free beyond them. Transitions hook the existing seams — the Worker's
prompt wrappers (admission), the actor's settle relay (completion), and
`closeSession`/`archiveSession` (terminal writes) — all through the store's
serialized queue.

## Testing plan

Transitions:

- admission of a prompt on each state lands busy; deferred is not sticky
  (defer → prompt → settle → notified);
- full settlement lands notified: streaming, tool execution, auto-retry,
  compaction, and a queued steer all hold busy until `agent_settled`;
- an admitted prompt that never starts a run settles to notified through the
  dispatch completion;
- defer/restore toggle on notified/deferred, refused while busy, legal on a
  dormant session; the refusal is evaluated in the store's queue, so a defer
  racing an admission loses to the newer execution;
- both recovery forms land busy at admission and notified at their
  compensated end (retry and continue); abort and close during a recovery
  continuation follow the close-wins ordering;
- browsing invariance: open, skim, detach, and idle collection leave every
  state unchanged (the queue is byte-identical after a browse);
- close of a busy session: the abort's settle write is followed by the close's
  inactive write — final state inactive, in the store and in the broadcast;
- close racing a newer prompt: a prompt admitted after the close began keeps
  the session busy; the close's inactive write is skipped while the close
  still disposes the runtime it addressed;

Persistence and recovery:

- notified/deferred/inactive survive a Worker restart (dispose + rebuild);
- a persisted busy with a live Worker execution stays busy; with execution
  gone it recovers to notified;
- a corrupt states file is quarantined, never overwritten; startup proceeds
  with a fresh store and the failure is surfaced;
- a failed turn-boundary write degrades to in-memory and the execution
  continues; a failed defer or close write fails the verb (retryable);
- graceful shutdown settles busy sessions to notified before Worker disposal
  resolves, converging with the crash path's boot rewrite;
- a busy record whose session file never flushed is pruned at startup;
- a missing states file is the normal first state — all inactive, startup
  succeeds with no error surfaced;
- archiveSession prunes the record; a manually moved session file keeps its
  state (overlay by session id).

Wire and UI:

- `listQueue` ordering (notified → busy → deferred, activity desc) and
  `queue_changed` firing on every transition and membership change;
- two tabs converge on a toggle (last-writer-wins, single broadcast);
- `@latest` resolves to the most recently active notified-or-busy session,
  and a deferred-only queue falls through to today's durable fallbacks;
- the launcher and sidebar pin by queue membership; a browsed inactive session
  never appears.

## Relationship to other ADRs

- **ADR 12 (Proposed):** amended. Its lifetime rule (refcount, admitted-work
  window, accepted loss) is retained and becomes *more* true — runtime
  lifetime is now purely a resource concern. Its "user-facing session states"
  projection (streaming/idle/inactive from retention) is superseded by this
  ADR's durable states. Its deferred warmth section is unaffected: warmth
  changes reopen latency, never the queue.
- **ADR 11 (shipped):** idle collection stays exactly as implemented — timers,
  delays, filesystem checks — but its user-visible effect disappears (the
  queue no longer tracks the registry). A future revision may then simplify
  the policy on latency grounds alone.
- **ADR 13:** the alias resolution source changes from the live-session
  snapshot to the most recently active notified-or-busy session; deferred is
  excluded and a deferred-only queue resolves as empty. Scopes and
  fallbacks are unchanged.
- **ADR 16:** unchanged; recovered broken tails are notified sessions whose
  content shows the repair, as today.
- **ADR 18:** unchanged; state is carried by the row's mark column, orthogonal
  to identity/position.

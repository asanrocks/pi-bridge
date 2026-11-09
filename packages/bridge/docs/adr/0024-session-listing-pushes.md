# ADR 0024: Throttled Queue Deltas and History Invalidation

**Status:** Implemented. Current behavior lives in
[core protocol](../core/protocol.md) ("Queue delivery"),
[host runtime](../host/runtime.md) ("Queue publication"), and
[web architecture](../web/architecture.md); this record is deleted at merge.

Builds on Session locations and running activity in
[host runtime](../host/runtime.md), and ADR 23's queue display and completion
notifications. Current delivery is specified in
[core protocol](../core/protocol.md) ("Push frames") and
[web architecture](../web/architecture.md).

## Context

Two pushes carry Session rows to every browser: `queue_changed` (every Inbox
and Later Session) and `sessions_changed` (one Project's first history page).
Both replace their entire collection. Queue callbacks include settlement,
streaming, registry, and activity changes, admission and rollback, placement,
and disposal. Multiple callbacks can report the same resulting state.

One Connection's live daemon capture contained:

| measurement | value |
| --- | --- |
| `queue_changed` | 526 frames, median 4.7 KB (~7.5 rows), 2.3 MB total |
| `sessions_changed` | 86 frames, median 6.1 KB (10 rows), 0.5 MB total |
| queue frames byte-identical to the previous frame | 278 of 526 (53%) |
| queue frames changing membership or order | 15 of 526 (3%) |
| per-row field changes | `activity` 150, `timestamp` 150, `lastActivityAt` 149, `messageCount` 148, `lastMessageText` 16, `name` 2, `location` 1 |
| address, timestamp, and first-message fields as a share of row bytes | 45% (queue), 43% (page) |

The core state to synchronize is the user's placement of Sessions in Inbox
or Later. Those Sessions are known to the Worker through the location store,
whether running or dormant. Archive is the default, has no placement record,
and is browsed through paginated queries. History does not need the same
continuous synchronization as the queue.

## Decision

Maintain and broadcast only the queue. Send a complete initial snapshot,
then changed rows and removed addresses, at most once every five seconds.
Replace history snapshots with Project-scoped invalidation notices. Keep
history as independently fetched pages.

Location remains separate from execution: Inbox and Later are user choices;
running activity is transient display metadata. The queue carries both, but
neither determines the other. The Document stream and its immediate feedback
for the attached Session are unchanged.

### One queue snapshot, then deltas

Reuse the existing `SessionAddress` and `SessionInfo` types:

```ts
type QueueChangedMessage =
  | { kind: "queue_changed"; mode: "snapshot"; revision: number;
      sessions: SessionInfo[] }
  | { kind: "queue_changed"; mode: "delta"; revision: number;
      upsert: SessionInfo[];
      remove: SessionAddress[];
      invalidateHistory: string[] }; // Project ids
```

Only Inbox and Later rows belong to this store. A complete row upsert replaces
the previous row, clearing optional fields that are absent, including
`activity`. Moving between Inbox and Later upserts one row. Moving to Archive,
moving to Trash, or losing the owning Worker removes the row. Removal means
"no longer in this queue", not "the Session no longer exists".

The client applies the entire frame atomically and sorts its rows with the
existing queue comparator. Make that pure comparator browser-safe and share
it between host and client; do not maintain separate ordering rules.
No address-list views, page references, or row-retention accounting are needed.
History rows and queue rows are separate projections. When a history result
also names a queued Session, the sidebar uses the queue row and excludes the
duplicate history row, as it does today.

`invalidateHistory` rides in the same throttled delta even when no queue row
changed. It is an accumulated set of Projects, not a snapshot of queue state.
An empty upsert/remove pair with a nonempty invalidation set is a valid frame.
If all three are empty, send nothing and do not increment the revision.

### A five-second publication limit

The Daemon keeps the latest known queue and the last published queue. Worker
events update the latest state immediately. The Daemon diffs it against the
published state only when publication is due, accumulating history
invalidations in the meantime.

Use one Daemon-wide throttle, not a separate timer per Session, Project, or
Connection. A change outside the cooldown may publish immediately. During
the cooldown, the first dirty change schedules publication at the previous
publication time plus five seconds; subsequent changes do not extend it.
Never send two delta broadcasts less than five seconds apart. An empty
scheduled diff sends nothing and does not restart the cooldown.

The delta contains each dirty row's latest value. Intermediate tool phases,
running edges, and moves that return to the previously published value may
disappear. A Session added and removed entirely between publications need
never appear. History invalidations still survive such a sequence.

This limit covers all queue changes, including user moves and Worker
withdrawal. Other tabs can therefore show an older placement or activity for
up to five seconds. RPC acknowledgements and attached Document updates remain
immediate; they do not force an early queue broadcast. No optimistic placement
mechanism is added by this record.

The initial snapshot is a per-Connection initialization, not a broadcast,
and is exempt from the cooldown. Completion events described below are also
independent of this queue publication limit.

### Ordered initialization and repair

Each Connection receives a snapshot of the **last published queue** and its
revision before receiving deltas. Do not snapshot unpublished latest rows:
the next broadcast must apply to the same baseline held by every initialized
client. Pending changes arrive at the next publication deadline.

After initial Worker seeding, capturing the snapshot, enqueueing it, and
enabling later queue delivery form one synchronous Daemon step. No await may
separate capture from enqueueing. Subsequent deltas follow on the same ordered
WebSocket. Snapshot delivery does not increment the revision.

The Daemon increments its process-local revision once per nonempty delta
broadcast. Clients apply only `current + 1`; older or duplicate deltas are
ignored. A delta before initialization or a revision gap rejects the entire
frame and reconnects. The new Connection receives a complete snapshot.
Keep the old display stale until that replacement arrives.

The receiver and outstanding history requests belong to the Connection
lifetime. Old-Connection frames and replies cannot write after reconnect.
Reconnect also invalidates history caches. No client replay buffer, replay
log, baseline RPC, or scoped snapshot merge is introduced.

`listQueue` remains available as a query, but its reply does not overwrite the
browser's synchronized queue. Browser initialization uses the ordered push.

### History is query plus invalidation

`sessions_changed` is removed. Its existing triggers—settlement, rename,
creation, Trash, and placement changes—mark the affected Project's history
dirty. Sending a notice does not scan the directory or construct a page.
These notices are accumulated in `invalidateHistory` and published through
the five-second throttle.

The browser marks cached pages for those Projects stale. Refresh a visible
expanded folder from its first page; discard its cached later pages because
their cursors may no longer describe the refreshed ordering. Closed folders
refetch when next expanded. Unloaded folders perform no work.

`listSessions`, including its first page and pagination, remains an ordinary
query returning rows and cursor metadata. History replies never update queue
rows or advance the queue revision. The Daemon materializes no history pages
and retains no history rows for broadcast.

Each client Project cache has a local invalidation counter. A fetch captures
that counter and its request owner. If an invalidation arrives while the
request runs, its reply cannot mark the cache fresh: discard it and refetch
if the folder remains visible. Reconnect or a newer request likewise rejects
an old reply. Invalidation received after a reply simply makes that page
stale again. There is no delta replay into query results.

History is eventually refreshed, independently of the queue; no atomic
cross-view snapshot is promised. Filesystem scans occur only when servicing
history queries or initializing/refreshing affected dormant queue rows.
External filesystem edits are discovered by subsequent queries; no watcher
or maintained index of all history is added.

### Completion is an event, not a sampled state transition

A strict five-second throttle can hide an entire short turn. Stop deriving
completion notifications from consecutive queue samples. Add:

```ts
interface SessionCompletedMessage {
  kind: "session_completed";
  session: SessionRef;
  name?: string;
  lastMessageText?: string;
}
```

The Worker emits this once at the existing full-execution settlement boundary
for a Session currently in Inbox or Later. Tool completion, streaming-flag
callbacks, and repeated metadata refreshes are not additional completions.
The Daemon forwards it immediately to initialized Connections. Include the
display metadata so notification text need not wait for the next queue delta,
and do not require the address to be present in the last published queue.

The client suppresses the notification for the Session it is reading,
preserving the attached-view notification path. Snapshot installation,
history results, and queue deltas never generate completion notifications.
A short turn can produce one completion event even if both sampled queue
states are idle; successive turns each produce their own event.

Archive and Trash suppress disposal-induced completion events for the
affected address while the operation runs. Other Sessions' events continue
immediately. Release suppression on success or failure; subsequent genuine
settlements must not remain suppressed. Worker withdrawal removes queue rows
at the next publication and produces no completion events.

These events are live notifications: they are neither stored nor replayed.
A reconnect snapshot does not announce work completed while disconnected.
This preserves the existing best-effort notification behavior without
requiring intermediate running states in the throttled queue.

### Ownership

**Worker.** The persisted location store owns queue membership. Keep an
address-keyed cache of queue summaries, rebuild changed live summaries from
registry metadata, and read dormant rows on registration or verbs that affect
them. Activity callbacks do not scan history or reread dormant queue files.
Settlement marks history dirty instead of refreshing a history page.
Worker changes carry complete changed rows and removals, history
invalidations, or a separate completion event. Deduplicate unchanged summaries
before sending them to the Daemon.

Worker delivery starts with a complete queue slice before incremental events.
Capturing and enqueueing that slice and enabling subsequent events are one
synchronous step on both in-process and socket adapters. A withdrawn
registration cannot deliver into its successor. This replaces the racing
`seedQueueSlice` query; no history-page initialization is needed.

**Daemon.** Keep the latest queue slice per Worker, the last published
aggregate, pending history invalidations, one revision, and one publication
timer. Aggregate the registered slices and diff by address. A single throttle
at this boundary prevents several Workers from multiplying browser broadcast
frequency; do not add a second five-second Worker throttle that doubles delay.
Route withdrawal remains immediate even though its queue removal is throttled.
New Connections receive the published baseline before joining live delivery.
Timers are cancelled and pending state discarded on disposal.

**Web.** Keep one queue map and derive the existing ordered row array from
it. History pages keep their own query caches and freshness counters.
Replace snapshot-based completion detection with handling of the explicit
completion event, retaining attached-Session suppression. The launcher,
sidebar, quick switcher, and keyboard navigation still consume queue rows.
`replace`, `patch`, `session_closed`, and `pinned_models_changed` are unchanged.

## Rejected alternatives

- **One shared row store for queue and history.** It requires materialized
  page views, cross-view retention, scoped query reconciliation, and global
  repair for data that the user browses only occasionally. Synchronize user
  placement; invalidate and query history.
- **Full snapshots with throttling alone.** Throttling bounds frequency but
  still repeats every unchanged dormant row. Complete changed-row upserts
  remove that duplication without field-level patch semantics.
- **Immediate running edges through the queue.** They preserve sampled
  completion detection but break the five-second broadcast cap. A completion
  event expresses the occurrence directly and does not carry unrelated rows.
- **Queue invalidation followed by a pull.** Every client continuously needs
  the same small queue. Include changed values in the push instead of adding
  an RPC round trip. Invalidation is appropriate for history, whose interest
  is sparse and query-driven.
- **Trailing debounce.** Continuous tool activity could defer updates
  indefinitely. A throttle publishes at the first eligible deadline.
- **Client snapshot buffering and replay.** The server already controls the
  ordered stream. Enqueue initialization before deltas and reconnect on a
  consistency failure.
- **A universal protocol covering Documents and pinned models.** Documents
  retain their attachment generations, lazy demand, and cursor-based sync.
  Pinned models change rarely. Neither benefits from the queue's throttle.

## Implementation and verification

**1. Protocol and pure queue operations.** Define snapshot/delta variants,
history invalidation ids, and the completion event. Move the existing
comparator into browser-safe core and export it through the public package
surface and browser smoke entry. Add pure reducer/diff tests for complete-row
replacement, optional-field clearing, moves, removals, ordering, and unchanged
state.

**2. Worker source.** Replace history-page pushes with invalidation and emit
changed queue summaries plus genuine completion events. Initialize each
registration with an ordered queue snapshot. Verify activity callbacks
perform no history scans or dormant-row reads, and disposal suppression is
address-scoped and released on failure.

**3. Daemon publication.** Add the single five-second throttle, latest versus
published state, accumulated invalidations, ordered Connection snapshots, and
immediate completion forwarding. Test multiple Workers, withdrawal, timer
ownership, and published-baseline consistency with a controlled clock.

**4. Web integration.** Apply queue deltas atomically, sort with the shared
comparator, invalidate/refetch visible history, and switch notifications to
completion events. Test query ownership, invalidation during pagination,
reconnect, short turns, and attached-Session suppression.

**5. Measurement and documentation.** Re-measure bytes and broadcast counts
on a tool-heavy turn with several open tabs, including history refetch traffic
and completion events. Earlier estimates for 100 ms coalescing do not validate
this five-second design. Update core protocol, host runtime, web architecture,
and web design in the implementation change. Add a bridge changelog entry
when targeting `main`; delete this ADR after implementation and verification
at merge.

### Required traces

| Trace | Required result |
| --- | --- |
| One tool-heavy Session changes continuously | Delta broadcasts are at least five seconds apart; activity cannot extend the first eligible deadline. |
| Several Workers change during one cooldown | One aggregate delta includes the latest rows and accumulated Project invalidations. |
| Repeated callbacks report identical rows | No duplicate upsert; an entirely empty publication sends nothing. |
| A row changes and returns to its published value | No row delta, but accumulated history invalidation is retained. |
| A Connection joins while latest state differs from published state | Its snapshot uses the published baseline; the next delta converges it with existing clients. |
| Initialization captures R10 immediately before publication R11 | Snapshot R10 precedes delta R11 on that socket without buffering. |
| An Inbox row moves to Later, Archive, or Trash | One upsert or removal at the next eligible deadline; no history-row retention. |
| A turn starts and finishes within five seconds | One immediate completion event even if no running row is published. |
| Two successive turns finish during one cooldown | Two completion events; at most one eligible aggregate queue publication. |
| The tab reads the Session that completes | The queue completion handler remains silent for that Session. |
| Archive or Trash disposes one Session while another finishes | Suppress only the disposal-induced completion; forward the other event. |
| Archive or Trash fails | Release notification suppression and eventually publish the actual queue state. |
| A history notice names an unloaded or closed folder | Do not fetch until it is opened. |
| A history notice arrives during a first-page or pagination fetch | The old reply cannot mark the cache fresh; refetch visible history from page one. |
| Worker withdrawal occurs during cooldown | Withdraw routes immediately; remove its queue rows on the next eligible broadcast, without completion events. |
| A revision gap or old-Connection reply arrives | Reconnect for a fresh queue snapshot; old owners cannot write, and historical completions are not replayed. |

## Tradeoffs and limits

- Other tabs' queue activity, placements, and removals may be stale for up to
  five seconds under normal scheduling. Intermediate tool names are deliberately
  omitted. Verify that this is acceptable for the sidebar and quick switcher.
- Completion events are prompt while the sampled queue can still show the
  previous activity until its next update. The event does not mutate the
  queue out of band.
- History queries still scan storage, but only interested clients issue them.
  Measure refetch frequency before adding finer invalidation or an index.
- Queue summaries retain full `SessionInfo` display fields. Measure their
  remaining cost before introducing field patches or removing label fallbacks.
- Nullary registry callbacks may still rebuild all live summaries in memory.
  Passing an address through those callbacks is a local optimization if
  profiling justifies it.
- History invalidations and completion events have different roles: one
  repairs stale query data, the other reports a live occurrence. Neither is
  another authoritative source of queue membership.

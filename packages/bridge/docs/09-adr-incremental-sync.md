# ADR 09: Incremental Sync - Client Cache and Prefix Cursor

**Status:** Decided. Implemented — core logic (ord assignment, cache
policy, initial-sync construction), host wiring (cursor-aware attach and
rebind), and web client (IndexedDB cache, write-through, candidate-mirror
switch flow). The IndexedDB adapter itself has no automated test (would need
a fake-indexeddb dev dependency); its semantics are covered by the in-memory
store tests plus the pure policy tests. Supersedes earlier drafts of
ADR 09. Amends ADR 02 with `Entry.ord` and extends ADR 06's initial-sync
behavior. ADR 08 remains the possible long-term component model; this ADR
defines the cache and cursor semantics that its Log facet can reuse.

## Context

Reconnect and session switch currently send a full `replace` snapshot. The
snapshot contains every entry skeleton and all wire-eager text. Its cost grows
with the complete session, even when the client already holds almost all of it.

The web client will keep committed entries in IndexedDB. On attach, it seeds
its in-memory mirror from that cache and asks the server only for the missing
suffix.

The model has three copies:

```
canonical Document (server, full fidelity)
        |
        | replace / patch / pull
        v
DocumentMirror (client memory)
        |
        | deterministic write-through
        v
IndexedDB cache (committed entries only)
```

The cache is a disposable derivative of server data. It can be absent,
incomplete, or behind another tab. A failed cursor check falls back to a full
snapshot, which replaces the cached session. The protocol does not defend
against an actively malicious client or arbitrary mutation of cached entry
content. Cache and session-format changes invalidate the cache by version.

## Assumptions

The design depends on four existing properties:

1. A session has one pi writer. `SessionManager` serializes appends and returns
   entries in file order.
2. WebSocket frames are reliable and ordered within one connection. A broken
   connection is replaced; frames are not resumed across sockets.
3. Initial sync is emitted before later live patches on that Connection. The
   sync emission and listener attachment contain no `await` boundary.
4. A committed entry is immutable. In-flight entries use `pending:*` ids and
   are never written to IndexedDB.

These properties make the durable conversation an append-only ordered log.
The client needs a prefix cursor, not a patch journal, CRDT, or transport
sequence number.

## The Ordering Problem

WebSocket order is not always session-file order because discovery can lag a
file write:

1. An extension calls `setLabel`; pi appends silent file entry #9.
2. The extension calls `appendEntry`; pi appends #10 and emits
   `entry_appended` with its real id.
3. The bridge sends #10 before `reconcile` discovers #9.

Both entries are committed and immutable, but the client cannot yet know that
#10 is file position 10. A cursor based on receive order could skip #9 after a
disconnect.

The server therefore assigns a file position, `ord`, only when it has the full
file-ordered entry list. A real id identifies a committed entry; `ord`
identifies a committed entry that is safe to include in the cached prefix.

## `ord`: File Position

ADR 02's `EntryBase` gains an optional wire-eager field:

```ts
interface EntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
  /** Zero-based index in SessionManager.getEntries(). */
  ord?: number;
}
```

Rules:

- `ord` is the zero-based index in `SessionManager.getEntries()`.
- Provisional entries never have `ord`.
- `entry_appended` entries do not receive `ord` immediately. A silent earlier
  write can still be undiscovered.
- `initFromEntries` assigns `ord` to every bootstrapped entry.
- `reconcile` assigns `ord` while walking the complete pi entry list. A patch
  that discovers an earlier hole also assigns positions to already-known
  later entries in the same atomic patch.
- Initial-sync construction adds `ord` to its wire projection from the
  complete pi entry list, including when a live Manager has not reached its
  next seal. It does not modify the canonical Document. The next `reconcile`
  assigns the same values canonically and may send already-attached clients
  idempotent `ord` updates.
- For one logical append-only session, an assigned `ord` does not change.
- Renderers do not use `ord`. Conversation structure and order still come
  from `parentId` walks in the viewmodel.

Implementation note (resolved): `reconcile` now walks `piEntries` by index
instead of skipping known entries, so a discovered earlier hole also assigns
positions to already-known later entries in the same atomic patch.

The cache stores only committed entries with `ord`. A committed
`entry_appended` entry can appear in the live mirror before it appears in the
cache. The next reconcile or initial sync makes it cacheable.

## Prefix Cursor

The cursor is:

```ts
interface PrefixCursor {
  sessionId: string;
  lastKnownId: string;
  entryCount: number;
}
```

`entryCount` is the cached prefix length. `lastKnownId` is the entry id at
`ord = entryCount - 1`.

The client derives the cursor from entry records every time it restores a
session. It does not persist a separate cursor record. Records must have
positions exactly `0..entryCount - 1`, with no gap or duplicate. An empty or
invalid set produces no cursor.

The server accepts the cursor when all checks pass:

```ts
cursor.sessionId === manager.liveSessionId
cursor.entryCount > 0
cursor.entryCount <= piEntries.length
piEntries[cursor.entryCount - 1].id === cursor.lastKnownId
```

The server then sends `piEntries.slice(cursor.entryCount)`. A failed or omitted
cursor produces a full `replace` snapshot.

This check is an integrity check for the normal client implementation. It
catches a wrong session, a stale prefix length, and a missing anchor. It is
not authentication and does not prove arbitrary client storage contents.

## Initial Sync

Initial sync runs for `switchInstance`, `switchSession`, `newInstance`, and
`newSession`. It uses the current full pi entry list for committed entries and
the canonical Document for status, scoped models, and provisional entries.
Every initial-sync push carries the active durable `sessionId`; normal live
patches do not need to repeat it. This gives the client the cache key before
the RPC reply, including when the server just created the session.

### Valid cursor: delta patch

The server sends one ordinary multi-op `patch` push with `sessionId` and the
following operations:

1. `add /entries/<id>` for each missing committed entry in file order,
   excluding entries the canonical Document still holds as provisionals
   (see Mid-turn pairing). Each value has its `ord` and has all lazy fields
   set to `null`.
2. `add /entries/pending:*` for each current provisional entry. These
   skeletons also have lazy fields set to `null` and are never cached.
3. `replace /status` with the complete current status.
4. `replace /scopedModels` with the complete current scoped model list.

The provisional skeletons are required during a mid-turn reconnect. Later
streaming patches target paths inside them; applying an `append` without the
skeleton would create an invalid mirror shape.

The multi-op patch resets `CompactCodec` state. The client applies it to the
cache-seeded mirror before rendering. Initial-sync frames are multi-op
patches or `replace` frames, so they can never appear as bare-string compact
frames; compact frames therefore never need to carry `sessionId`.

### No valid cursor: full replacement

The server sends one `replace` push with `sessionId`. Its Document contains:

- every committed pi entry with `ord` and lazy fields set to `null`,
  excluding entries still held as provisionals (see Mid-turn pairing);
- every current provisional entry with lazy fields set to `null`;
- complete current status and scoped models.

This snapshot is also the cache repair path. The client replaces all cached
records for that session with the snapshot's `ord`-bearing entries.

### Mid-turn pairing

Pi persists every user, assistant, and toolResult message at `message_end`,
while the canonical Document holds those entries as `pending:*` provisionals
until the turn-end reconcile seals them. A committed pi entry that still
pairs with a provisional is therefore represented by that provisional in
initial sync — sending both would double-render, and omitting the provisional
would break the later seal `move`, which relocates a provisional the mirror
must hold. Both initial-sync forms exclude such committed entries until they
are sealed. Pairing is consulted only for entries the canonical Document
does not already hold — `findProvisional` pairs an assistant piEntry with the
`pending:message` singleton by existence, not correspondence, so applying it
to known entries would drop every previously committed assistant message.
Excluded entries sit at the tail of the file, so a client's
cached prefix stays contiguous; if an interleaved committed entry (for
example a mid-turn `entry_appended`) leaves a gap in the cached ords,
`computeCursor` rejects the records and the client falls back to a full
replacement.

### Ordering

The initial-sync push is sent before the RPC reply. The reply is only an
acknowledgement and never changes the mirror.

For attach, cursor validation, sync construction, listener attachment, and
sync emission run as one synchronous operation. Later Manager patches cannot
interleave ahead of the initial sync.

For `switchSession`, opening and binding the target session can be
asynchronous. Once the Manager has rebound, each Connection's initial-sync
emission is synchronous and precedes later patches from the new session.

Connection-local lazy subscriptions are cleared on attach and session rebind.
The wants-outbox issues fresh pulls for visible lazy fields. This is a
behavior change: today the subscription set survives attach.

### Rebind window and candidate mirror

Between the client sending `switchSession` and the Manager rebinding, the
Connection is still subscribed to the old session. Session teardown can also
emit final patches. The client therefore does not replace its active mirror
when it loads the target cache.

Instead, the client loads the target cache into a candidate mirror and sends
the request with that cache's cursor. Until an initial-sync frame names the
target `sessionId`, old-session patches continue to update the active mirror
and old-session cache. The client applies the target initial sync to the
candidate mirror, then atomically promotes that mirror as the active one.
Subsequent live patches apply to the promoted mirror.

If the rebind fails (bad path, extension cancellation, or rebind error), the
server replies `ok:false` and sends no target initial sync. The client discards
the candidate; the old mirror and old cache remain valid. No rollback or
re-attachment is needed.

## RPC Changes

The cursor is an optional argument on the existing routing operations:

```ts
switchInstance(instanceId, cursor?)
switchSession(sessionPath, cursor?)
```

Initial `patch` and `replace` pushes add `sessionId` to their existing frame
shapes. Receipt of either frame sets the cache session for subsequent live
patch writes.

`PrefixCursor.sessionId` is always present when a cursor is present. The
server validates it against the session that is active after attach or rebind.

Session listing must expose the durable session identity separately from its
file path:

```ts
interface SessionInfo {
  sessionId: string;
  sessionPath: string | null;
  // existing display metadata
}
```

The client uses `sessionId` as the cache key and a non-null `sessionPath` to
request a switch. This replaces the current ambiguous `SessionInfo.id` field.
A live session that has not created its file yet has `sessionPath: null`.

`switchSession` changes the Manager's session for every attached Connection.
Only the initiating Connection has loaded the target cache and supplied its
cursor. It can receive a delta. Other attached Connections receive a full
`replace` for the new session.

`newSession` takes no cursor and sends an empty-session replacement. There is
no prior cache for a newly generated session id.

The client compares the selected `sessionId` with the active session before
loading a candidate. Selecting the active row is a no-op: it does not seed a
mirror or send `switchSession`. A live row with `sessionPath: null` is also not
a switch target. If a client still requests the current session, the server
may acknowledge the no-op without an initial-sync push.

### Touched wire shapes

- `SwitchInstanceRequest` and `SwitchSessionRequest` gain optional cursor
  fields; `SwitchSessionRequest.sessionId` is renamed `sessionPath`
  (breaking `BridgeClient.switchSession`).
- Initial `patch` and `replace` pushes carry `sessionId`.
- `SessionInfo` splits into `sessionId` plus nullable `sessionPath`; a live,
  unpersisted session has a `sessionId` and `sessionPath: null`.
- `SessionsChangedMessage.sessions` uses the same shape as `SessionInfo`.
- `parseSessionFile` reads the durable id from the session header instead of
  using the file path as the id.

## Client Restore Flow

### Reconnect to a known instance

```
1. Determine the instance's current sessionId from retained instance state.
2. Load that session's cache.
3. Seed DocumentMirror and paint cached content.
4. Open the socket and send switchInstance(instanceId, cursor?).
5. Apply the delta patch or full replacement.
```

### Cold application load

```
1. Connect and call listInstances.
2. Select an instance and read its sessionId.
3. Load and seed the matching cache.
4. Send switchInstance(instanceId, cursor?).
5. Apply the delta patch or full replacement.
```

Persisting a last-viewed session id can add an offline paint before step 1,
but it is a user-interface optimization and not part of sync correctness.

### Session switch

```
1. Ignore the selection when sessionId is already active or sessionPath is null.
2. Load the target session cache into a candidate mirror.
3. Send switchSession(sessionPath, cursor?).
4. Keep applying old-session patches to the active mirror and cache.
5. Apply the target initial sync to the candidate and promote it atomically.
6. On failure, discard the candidate and keep the active mirror.
```

The active mirror remains the single source of truth for rendering. A
candidate is not rendered before promotion. Cached status is only a paint
hint; every successful initial sync replaces status and scoped models with
current server values.

## Cache Projection and Storage

### Pure policy

`src/core/cache.ts` owns browser-safe cache decisions:

```ts
computeCursor(records) -> PrefixCursor | null
projectCacheEntry(entry) -> Entry
planCacheWrites(sessionId, before, after) -> CacheEntryRecord[]
seedDocument(records, statusHint) -> Document
```

`projectCacheEntry` removes all lazy values. Cached thinking, tool arguments,
tool result content, and tool result details are always `null`. Pull responses
are not persisted. The existing wants-outbox pulls visible values again after
restore. Optional assistant metadata (`responseModel`, `responseId`,
`errorMessage`) is normalized to `null` when absent — never `undefined` — so
the streaming skeleton and the file projection yield one deterministic entry
shape and cache records never depend on which path produced them.

`planCacheWrites` uses `applyPatch` structural sharing. It selects changed or
new entries that have `ord` and do not have a `pending:*` id, then applies
`projectCacheEntry`. Unchanged entry references produce no write. Structural
sharing only holds between same-session documents evolved via `applyPatch` —
the client therefore plans against the session's last cache-written base
(the attach seed, the candidate's pre-promotion seed, or the replace
snapshot), never against the previous session's document: cross-session
documents share no references, and planning against one rewrites the entire
new session on every switch.

The pure module is exported from `src/index.ts` and exercised by the browser
smoke entry.

### IndexedDB adapter

`web/src/infra/persist/entryCache.ts` owns browser storage:

```ts
interface CacheEntryRecord {
  sessionId: string;
  ord: number;
  entryId: string;
  entry: Entry;
}
```

The `entries` object store is keyed by `[sessionId, ord]`. An index on
`sessionId` loads or deletes one session.

Incremental patch writes use `put()`. For a fixed `(sessionId, ord)`, every
normal client produces the same immutable, lazy-stripped entry, so repeated
and concurrent writes are idempotent.

All entry writes planned from one server patch run in one IndexedDB
read-write transaction. A failed transaction leaves the previous prefix
unchanged.

A full `replace` uses one transaction to delete that session's existing entry
records and insert the replacement records. This repairs gaps and removes a
stale suffix.

The `sessions` metadata store contains:

- `sessionId`;
- cache format version;
- optional status hint;
- last-attached timestamp for future eviction.

Status hints use last-write-wins. They are never authoritative.

### Multiple tabs

Tabs share the same IndexedDB database. They write the same deterministic
entry projection at each `(sessionId, ord)`, so `put()` is safe. IndexedDB
serializes read-write transactions. A slower tab can temporarily leave the
shared cache at a shorter valid prefix, but it cannot create a different
committed value for the same session position through the normal write path.

The next patch or attach advances or repairs the cache. Cache state does not
affect the server or another tab's in-memory mirror.

## Cache Version and Eviction

The cache format version changes when the cached Entry projection or relevant
pi session format changes. A version mismatch clears the cache. This is the
chosen response to software migrations and development fixtures that rewrite
historical content.

Residual risk, accepted: if history before the cached boundary is rewritten
with the same anchor id and length (hand-edited files, fixtures), the client
keeps stale content until the cache version is bumped. The wire protocol
does not detect this.

Sessions that never persist (a new session abandoned before its first
assistant message) leave orphaned cache records. With the unbounded first
implementation they linger until a future eviction pass; acceptable.

The first implementation is unbounded. Future eviction removes complete
sessions by least-recently-attached order. It never removes individual entries
from the middle of a session because that destroys its useful prefix.

## Test Plan

Pure core tests cover:

- `initFromEntries` assigns sequential `ord` values;
- `reconcile` discovers a silent hole and assigns positions to the hole and
  already-known later entries in one patch;
- cursor computation accepts exactly `ord = 0..k` and rejects gaps,
  duplicates, empty records, and mixed sessions;
- cache planning excludes provisional and `ord`-less entries;
- cache projection always strips lazy values;
- a seal `move` persists the committed post-seal entry;
- unchanged entries retain references and are not rewritten.

Initial-sync tests cover:

- first attach sends a full snapshot with `ord`, and the next attach can use
  a cursor;
- a valid cursor receives only the committed suffix plus provisional entries,
  status, and scoped models;
- a wrong session, bad count, or bad anchor receives a full replacement;
- the label-then-extension-entry trace does not skip the silent entry;
- an `entry_appended` entry is not cached before it receives `ord`;
- mid-turn reconnect includes provisional skeletons before later appends;
- delta merge is idempotent;
- seeded cache plus delta converges to the full initial-sync projection;
- `switchSession` uses the initiator's cursor and sends full replacements to
  other attached Connections;
- selecting the active session or a live row with no path sends no
  `switchSession` request;
- a `switchSession` failure discards the candidate while the old mirror and
  cache remain unchanged;
- old-session patches during the rebind window continue to update only the
  old mirror and old cache;
- target initial sync updates the candidate before one atomic promotion;
- wire-projected `ord` is idempotent with the same later canonical assignment
  from `reconcile`;
- codec state resets on both initial-sync frame forms (multi-op patch and
  `replace`);
- `sessions_changed` and `listSessions` carry `sessionId` and nullable
  `sessionPath`, including `sessionPath: null` for the live-stub row.

Storage tests use `InMemoryEntryCacheStore` for policy and a focused IndexedDB
test for transaction behavior:

- repeated `put()` writes are idempotent;
- one patch writes all records atomically;
- a failed transaction leaves the previous prefix;
- full replacement removes stale records;
- interleaved tab writes leave a valid prefix.

## Alternatives Considered

### Cache-first paint followed by full replacement

This is simpler and provides much of the perceived-latency benefit, but every
reconnect still transfers O(session length) wire-eager text. It remains a
reasonable fallback if measurements show full snapshots are small enough.

### `lastKnownId` without `ord`

Rejected. A silent file entry can be discovered after a later emitted entry,
so receive order does not prove a file prefix.

### Receive-order sequence numbers

Rejected. They describe bridge discovery order, not durable file order.

### Full cached-id list

Correct for identity reconciliation, but sends O(session length) cursor data
on every attach. `ord` plus one anchor gives the needed prefix check in
constant wire space under this ADR's trust model.

### Prefix content hashes

Rejected for this trust model. The cache is local, disposable derived state,
not an authority or security boundary. Cache version invalidation handles
software and session-format migrations.

### Persisted cursor record

Rejected. A cursor record can advance separately from its entry writes. The
cursor is cheap to derive from records already loaded for mirror seeding.

### Server patch journal

Rejected. The committed entry list is already the durable append-only log.
Status is small enough to resend, and provisional streaming state has no
useful replay history.

## Invariants

1. Pi's file-ordered committed entry list is the ordering authority.
2. A committed entry becomes cacheable only when it has server-assigned
   `ord`.
3. Provisional entries are never cached.
4. Cached entries use one deterministic projection with all lazy fields
   `null`.
5. Cache changes from one patch are one IndexedDB transaction.
6. The cursor is derived from the contiguous cached record prefix, never from
   separate mutable metadata.
7. Initial sync precedes later live patches on each Connection.
8. During session switch, the old mirror remains active until target initial
   sync updates and atomically promotes a candidate mirror.
9. A failed cursor check sends a full replacement and replaces that session's
   cache records.
10. Status, scoped models, and provisional entries are always refreshed during
    initial sync.
11. Cache format changes invalidate the cache; the wire protocol does not
    defend arbitrary local data mutation.

## Relationship to ADR 08

ADR 08 separates an instance into Log, State, and Transient facets. This ADR
implements the same data split inside ADR 06:

- committed entries plus the prefix cursor are the Log facet;
- status and scoped models are the State facet;
- provisional skeletons and subsequent streaming patches are the Transient
  facet.

If ADR 08 is implemented, the cache projection, `ord`, prefix cursor, and
IndexedDB rules carry over. Only routing and envelope shapes change.

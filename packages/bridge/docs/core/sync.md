# Incremental Sync

Incremental sync uses the durable Session file as an ordered log. The server
assigns each committed entry an `ord`, and the web cache derives a prefix
cursor from those positions. The canonical document remains authoritative;
the cache is a disposable projection used to paint quickly and request only a
missing suffix. The Document and lazy-value rules are in
[data-model.md](data-model.md), and frame and verb details are in
[protocol.md](protocol.md).

## File position

`EntryBase.ord` is the zero-based index of an entry in the complete ordered
`SessionManager.getEntries()` result. It is a server-assigned file position,
not receive order, render order, or a transport sequence number.

`initFromEntries` assigns `ord` while bootstrapping. `reconcile` walks every
entry by index and assigns or repairs positions, including positions for
already-known later entries when it discovers an earlier hole. An
`entry_appended` event can add a committed entry before the next full ordered
walk; that entry has no `ord` until reconcile or initial-sync construction.
Provisional entries never have `ord`. A stable append-only Session does not
change the assigned position of an entry.

Initial-sync construction can add `ord` to its wire projection without
mutating the canonical document. The later reconcile patch assigns the same
value canonically. Rendering still follows `parentId` and branch structure;
`ord` exists for sync and cache safety.

This file-position rule matters because discovery order can differ from file
order. For example, a silent label entry can be persisted before an extension
entry that is emitted immediately. A cursor based on push order could treat the
later entry as a complete prefix and skip the silent one after reconnect.

## PrefixCursor

A `PrefixCursor` is:

```ts
interface PrefixCursor {
  sessionId: string;
  lastKnownId: string;
  entryCount: number;
}
```

`entryCount` says that records with `ord` 0 through `entryCount - 1` are
present. `lastKnownId` is the id at `ord = entryCount - 1`. The client never
stores separate cursor metadata: `computeCursor(records)` derives it from the
records it loaded for mirror seeding.

The records must have one `sessionId`, integer non-negative ords, no duplicate
ord, and every position from zero through the final record. Empty, gapped,
duplicated, or mixed-session records return `null`, which means full replace.

`validateCursor(piEntries, cursor, sessionId)` accepts only when:

- `cursor.sessionId` is the current durable session id;
- `entryCount` is a positive integer no greater than `piEntries.length`; and
- `piEntries[entryCount - 1].id` equals `lastKnownId`.

This catches the normal wrong-session, stale-length, and missing-anchor cases.
It is a consistency check, not authentication and not proof that a client has
not altered its local record contents.

## Initial-sync construction

`buildInitialSync(doc, piEntries, session, cursor)` emits exactly one
address-bearing frame.

With a valid cursor it emits a `patch` whose `session` is the supplied
`SessionRef`. The operations are, in order:

1. `add` each committed file entry with `ord >= cursor.entryCount`, in file
   order, with lazy fields stripped;
2. `add` all current provisional entries as lazy-stripped skeletons; and
3. `replace /status` with current status.

The status replacement is unconditional, so this patch is never a compact
single-append frame. It supplies provisional skeletons even
when the cache already contains a committed prefix, because later live
streaming patches need those paths to exist.

With no cursor or an invalid cursor it emits a `replace` whose `session` is the
same `SessionRef`. The document contains every eligible committed file entry
with its file `ord`, every current provisional entry, and current status and
scoped models. This frame is also the cache repair input.

### Mid-turn pairing

Pi can have already persisted a user, assistant, or tool-result message while
the canonical document still holds its `pending:*` provisional. During
initial sync, `collectCommitted` excludes a durable entry only when it is not
already in the document and `findProvisional` pairs it with a current
provisional. The provisional is sent instead. Sending both would render a
message twice; omitting the provisional would make the later seal `move`
invalid on the mirror.

Known committed entries are not passed through that pairing check, so a
mid-turn attach does not accidentally drop earlier assistant entries. The
excluded durable entry is admitted by the next reconcile or initial sync after
seal and then receives its `ord` and cache record.

The host attaches a Connection synchronously after cursor validation and sync
construction. Initial sync is emitted before later live patches on that
Connection. On the client, a Project/session switch can seed a candidate mirror
from cache; the candidate is promoted only when the target initial-sync frame
names the target `SessionRef`. Old-session state remains active until that
promotion, and a failed open discards the candidate.

## Cache projection policy

The pure policy lives in core. Its storage interface is `EntryCacheStore`, with
an in-memory implementation for tests and environments without browser
storage.

- `entryForCache(entry)` applies the deterministic lazy-stripped projection.
  Thinking, tool-call arguments, tool-result content, and tool-result details
  are always `null`; pull responses are never persisted.
- `planCacheWrites(sessionId, before, after)` selects changed or new committed
  entries with an `ord`, excludes every `pending:*` entry, strips lazy fields,
  and returns records ordered by `ord`. It uses structural sharing to skip
  unchanged entries. A change that only fills a lazy field produces no cache
  write because its projection is unchanged.
- `cacheRecordsOfDocument(sessionId, doc)` creates the complete ordered record
  set for replace repair, with the same committed-and-ord filter.
- `statusHintOfDocument(doc)` selects name, model, thinking level, and context
  usage as a paint hint. It is not canonical status.
- `seedDocument(records, statusHint)` reconstructs entries in ord order,
  derives leaf/name/model/thinking/stats from them, then overlays defined hint
  fields. It does not seed scoped models; initial sync supplies those.
- `computeCursor(records)` derives the prefix cursor described above.

The web connection pipeline applies `planCacheWrites` to the last
cache-written document for that `sessionId`, then writes all records implied by
one server patch. A full `replace` uses `cacheRecordsOfDocument` and repairs
the entire session, including removal of stale suffix records. This per-session
base is necessary because structural-sharing comparisons across two different
Session documents would make every entry appear changed.

## IndexedDB boundary

The policy is core-pure and browser-safe. The IndexedDB adapter is the web-side
exception at `web/src/infra/persist/entryCache.ts`; it is not part of core.
It stores entries under `[sessionId, ord]` in the `entries` object store and
stores status hints in a `sessions` object store. Incremental writes use one
read-write transaction. Replace repair deletes the session's old records and
inserts the replacement set in one transaction, so failure leaves the old
state rather than a partially repaired prefix.

The adapter loads a session's records and hint together, sorts records by
`ord`, and falls back to an in-memory store when IndexedDB is unavailable or
cannot open. A missing, failed, or invalid cache read simply omits the cursor;
the server then sends a full replacement. Cache availability never changes
server behavior or correctness.

## Cache trust, version, and retention

The cache is untrusted derived state. It can be absent, stale, incomplete,
behind another tab, or locally corrupted. It is not a security boundary and
never overrides canonical status, scoped models, or durable entries. A valid
cursor is only a normal-client consistency optimization; the server still
validates its session id, length, and anchor.

The IndexedDB schema is versioned. The current adapter opens the
`pi-bridge-cache` database at its format version and recreates both object
stores on an upgrade, which evicts all cached sessions when the projection or
storage format changes. The stored session metadata carries the format version
alongside the status hint. This is deliberate wholesale invalidation rather
than attempting to migrate entry projections.

There is no per-session or per-entry eviction policy in the adapter. Records
remain until a full replace removes that session's stale suffix, the cache
format is invalidated, storage is cleared, or a future retention policy is
introduced. An in-memory fallback is disposable and may lose all records on a
reload; that only changes a delta into a full replacement.

Across tabs, IndexedDB serializes transactions and every normal writer stores
the same deterministic lazy-stripped value at a given `(sessionId, ord)`.
A shorter valid prefix or a failed write is repaired by a later patch or full
initial sync; the server and other mirrors do not depend on the cache.

## Convergence rules

The convergence path is:

1. load records and a hint for the addressed `sessionId`;
2. derive a cursor and seed a mirror when the records form a valid prefix;
3. open the Project/stem with that cursor;
4. apply the address-bearing delta patch or replace snapshot;
5. make current server status and scoped models authoritative;
6. write committed, ord-bearing projections through the cache policy; and
7. issue fresh lazy pulls for visible fields.

A successful delta adds only the missing committed suffix plus current
provisionals and full state. A full replacement repairs the cache and mirror
from the server. A provisional never reaches cache storage, and a committed
entry without `ord` is withheld until the next complete file-order
construction. These rules make the cache a performance projection while the
server Document remains the sole synchronization authority.

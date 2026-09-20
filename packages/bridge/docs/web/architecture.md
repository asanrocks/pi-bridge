# Web Client Architecture

This document describes the current web client. It covers the mechanisms and
invariants at the boundary between the browser UI, the browser-side protocol
client, persistence, and the browser-safe `core` and `viewmodel` packages.
The vocabulary is defined by the [glossary](../glossary.md). Document and wire
semantics are specified in [core data model](../core/data-model.md), [core
protocol](../core/protocol.md), and [incremental sync](../core/sync.md).

The client is address-driven. A Project and stem identify the Session being
viewed; the durable `sessionId` identifies the cache and the current Document.
The URL is the navigation source of truth. A browser tab owns one store and one
WebSocket client, but may open different Session addresses over that
connection.

## Layers

The web source is divided by responsibility:

- `app/` owns the shell, status notification wiring, the Store provider, and
  the document-level keyboard ring. It composes the chrome and the active
  surface; it does not own feature-specific RPC or state wiring.
- `infra/net/` owns the WebSocket, BridgeClient, RPC wrappers, route-driven
  boot, push ingestion, lazy pulls, and connection recovery.
- `infra/state/` owns the single client store, its three slices, and the
  memoized store-to-ViewModel projection.
- `infra/persist/` owns browser persistence adapters and address-to-cache
  identity lookup.
- `infra/lib/` contains small browser or store-free utilities such as routes,
  unread counting, media queries, notification permission, and image
  preparation.
- `render/` contains shared rendering primitives, Markdown, code highlighting,
  icons, and shared resize/result helpers.
- `features/<area>/` owns an area and its wiring: launcher, topbar, sidebar,
  conversation, composer, history, and viewer. Components and area hooks stay
  together, so RPC and store composition belongs with the area that uses it.

`App` is chrome composition only. It installs the connection and draft guard,
creates the ViewModel, composes the TopBar, Sidebar, conversation or Launcher,
history pane, file viewer, and toast surface, and supplies the callbacks that
are genuinely shared by the keyboard ring and a feature. `useSidebarShell`
keeps Sidebar composition and its chrome handles in the sidebar area.
`ComposeDock` and `Launcher` acquire their own store and RPC dependencies.

The web application imports `src/core` and `src/viewmodel` with source-relative
paths. This is intentional: Vite can hot-reload the browser-safe source
without a package rebuild or alias layer. The web TypeScript gate supplies the
browser and JSX environment; the core and ViewModel remain browser-safe pure
code. The host-side ownership model is described in [host runtime](../host/runtime.md).

The feature components consume ViewModel data and store selectors. Conversation
turn rendering, composer behavior, pane layout, and visual tokens belong to the
companion web design document; this architecture document only states their
ownership boundaries. The theme is a visual-token concern documented there and
needs no client code at all: the dark ladder is a media-gated `:root` block
beside `@theme` in `web/src/app/index.css`, so the app simply follows the OS
preference, with no stored preference and no state.

## Client Store

`infra/state/store.ts` creates one Zustand vanilla store with
`createClientStore()`. It is the single source of truth for the web UI. The
store holds the current `Document` root, not the `DocumentMirror` object. A
push is applied to the mirror by `BridgeClient`, then the resulting root is
published through `applyReplace`; immutable root replacement gives selectors a
stable change signal.

The protocol slice contains:

- `document`, the current Document root;
- `activeSessionId`, taken from the address-bearing initial-sync frame. It is
  the durable Session cache key from ADR 09, not the URL address;
- `currentProjectId` and `currentStem`, the address currently represented by
  the tab. A null stem is the Project home and a null Project is the launcher;
- `connection`, a discriminated `ConnectionState`. Its wording and severity
  live in `infra/state/connectionStatus.ts` — the single mapping consumed by
  both down-state surfaces (the TopBar chip and the Launcher full panel), so
  no other module phrases connection state;
- `projects`, models, thinking levels, and `devMode` from daemon information;
- `activeSessions`, the global active/streaming Session snapshot; and
- `sessionPages`, lazily fetched Project history pages. Each page is
  `loading`, `error`, or `ready` with `sessions`, `hasMore`, and the compound
  `SessionListCursor` in `nextCursor`.

`clearCurrentSession` is the one teardown operation for leaving a Session. It
clears the Document, `activeSessionId`, address, session-scoped expansion and
freeze state, pull state, draft state, and the rendered-leaf override. It can
retain a Project id to land on that Project's home. Detach, a Project switch,
and a failed open use this boundary rather than partially clearing fields.

The composer slice contains `draft`, a discriminated union:

```text
idle
compose { text, images? }
edit { entryId, index, text, initialText }
```

It is the single source of truth for textarea content. `composerExpanded` is
separate visual state, so a non-empty compose draft can remain dormant while
the surface is collapsed. Draft actions promote idle state on typing or image
attachment, preserve attachments while text changes, and convert or clear
edit state only through explicit edit/commit paths. `blurDraft` reads Document
streaming and pending-steer state, which is the deliberate cross-slice seam.

The UI slice contains ephemeral view state: `focusedTurnId`, action and detail
expansion sets, `cardWrap` and `cardMarkdown`, frozen action-group and action
sets, `loadingPaths`, `pullTick`, the rendered-leaf override, history and
file-viewer state, and toast notifications. Expansion keys use the first
action's entry and block index; action keys use the entry and block index.
Manual toggles add keys to the corresponding frozen set, preventing streaming
auto-expansion from overriding user intent. A provisional-to-durable `move`
rewrites expansion, frozen, uncapped-detail, loading-path, and focused-turn
keys through `migrateExpandKeys` and `migrateFocusedTurnId`.

`renderLeafId` is the rendered-leaf override behind read-only branch peeking.
`null` follows the live leaf; a non-null value pins the projection to a
committed entry's root-to-leaf path without touching `status.leafId` — the
daemon never learns about a peek. `setRenderLeaf` accepts only committed
entries (sealed entries carry `ord`), clamping a `pending:` target to its
nearest committed ancestor, and normalizes pinning the live leaf back to
`null`. Divergence (`selectRenderDiverged`) is the mutation lock: while the
rendering leaf is pinned away from the live leaf, send, edit, and branch
navigation are blocked; the jump button is the return-to-live gesture. The
pin is session-scoped — `setActiveSessionId` clears it whenever a different
session activates (a same-id snapshot restore keeps it), so a pin can never
dangle into another session's tree and mutation-lock it.

The slices are deliberately one store rather than independent stores:
`clearCurrentSession` resets protocol, composer, and session-scoped UI state,
while `blurDraft` needs the Document status. `store.ts` stays free of React
and exposes the factory for unit tests. `store.tsx` creates the application
store context, `StoreProvider`, `useStore`, and `getStore` for imperative
connection and event paths.

## ViewModel Projection

`src/viewmodel/` is the pure projection boundary from a Document to renderable
data. `useViewModel` selects the Document, model catalog, current stem,
`pullTick`, and the UI slice's rendered-leaf override, then memoizes
`computeViewModel` using `viewModelCacheKey`. Its cache key combines the leaf
path identity, streaming text/thinking lengths, relevant status fields, the
current stem, the pull tick, and the override. The stem matters even when two
Documents are structurally equal; the pull tick matters when lazy values
arrive without a new path shape; the override matters so peek and un-peek
re-project over an unchanged Document (null and absent override share one
key — they resolve identically).

The projection first walks the effective leaf — the rendered-leaf override
when it resolves to a known entry, `status.leafId` otherwise — through
`parentId` and reverses the result into chronological order. Only that path
becomes the conversation ViewModel. It joins tool-result entries to their tool
calls, keeps lazy values nullable until pulled, and returns display
descriptors for user, assistant, system, user-bash, and git-change turns.
Consecutive assistant entries merge into one assistant turn. Text does not
split the turn; the flat
block sequence preserves text/action order for the renderer.

Assistant identity is `turnKey`, not merely `entryId`: it is the first entry id
(or an entry id plus a block suffix if a future rule starts a turn mid-entry).
The renderer, previous-ViewModel reuse map, keyboard focus, and navigation use
this key. Unchanged TurnVM and block references are reused, allowing memoized
children to skip work when an unrelated part of the projection changes.

User turns compute sibling user messages with the same `parentId`, ordered by
timestamp. `newestLeafInSubtree` chooses the newest leaf when a sibling is
selected, so branch navigation enters the sibling's latest descendant rather
than stopping at the sibling message. The history projection separately builds
the user-message tree and its `LaneLayout` for the history surface.

ADR 10 git stamps are projected as a carried state and as ordered changes:

- the latest valid stamp on the active path supplies `gitIdentity` and the
  commit subject on later user turns;
- a prompt stamp has no standalone transcript item because its state is carried
  to the next user turn;
- a boundary stamp outside an open assistant turn becomes a `GitChangeTurn`; and
- `tool_end` and `turn_end` stamps observed inside an assistant turn become
  `InlineGitStamp` values positioned after the preceding action. Renderer-side
  `segmentBlocks` and `assignGroupGitChanges` place those values with the
  action group they follow.

`segmentBlocks` groups consecutive thinking and tool blocks for rendering;
text remains a separate segment. `actionPulls` declares thinking and tool-call
fields needed by visible actions, and `resultPullPaths` declares the lazy tool
result fields needed by an expanded action. These functions are the sole
ViewModel-to-pull mapping.

## Network Layer

### Connection lifecycle

`useConnection` creates one `WebSocket` and one `BridgeClient` per connection.
The state machine is:

```text
connecting -> connected | init_failed
connected connection drop -> reconnecting -> unreachable
```

A socket being open is not enough to become connected. Initialization must
complete `getDaemonInfo` and `listActiveSessions` within 8 seconds, populate
Projects, model metadata, development mode, and the global active-session
snapshot, then open the route-driven address. Failure after the socket opens
is `init_failed` and can be retried without replacing the socket.

After a successful connection, drops count from one. Attempts below five are
`reconnecting`; attempt five and later are `unreachable`. `unreachable` still
auto-retries. The transport uses exponential backoff with a 500 ms base, a
5,000 ms cap, and up to 30% random positive jitter. Manual retry cancels the
timer, resets the attempt count, and connects immediately. A superseded or
disposed connection cannot write to the store or cache.

### Per-connection modules

`connectionTransport.ts` adapts WebSocket send/receive to the browser-safe
`BridgeTransport` and owns the backoff calculation. `connectionPipeline.ts`
receives BridgeClient pushes and is the write boundary for store, route, and
cache updates:

- live patch operations are coalesced into one store flush per animation frame
  while visible and approximately one second while hidden;
- a replace is an immediate flush barrier;
- live deltas use `planCacheWrites` against a per-session `cacheBase`, writing
  committed, ordered cache records through the IndexedDB adapter;
- a replace repairs the entire session cache, including deleting stale suffix
  records, and establishes the new cache base; and
- provisional-to-durable move operations migrate UI expansion and focus keys
  before the new Document root is published.

The pipeline handles registry pushes without touching the Document. A
`sessions_changed` push refreshes an already loaded Project page and records
address identities; it does not fetch a collapsed page. An
`active_sessions_changed` push replaces the global active-session snapshot.

An address-bearing `replace` or initial-sync `patch` establishes
`activeSessionId`, `currentProjectId`, `currentStem`, the address index entry,
and the route. A normal live patch has no SessionRef and only advances the
current mirror. The address-bearing frame is therefore the synchronization
barrier at which the target session becomes authoritative. The RPC navigation
wrapper may stage the requested address while the operation is in flight and
restores the previous address on failure; the initial-sync handler reasserts
the committed address and cache identity.

`sessionBoot.ts` implements the route-driven open used at initial connection
and reconnect. It looks up the address's remembered `sessionId`, loads its
cache records and status hint, seeds the BridgeClient mirror, derives a valid
prefix cursor, and calls `openSession`. With no usable cache it opens without a
cursor and receives a full replace. A failed open clears the session state and
writes the Project route, because the address no longer resolves or an
unflushed Session disappeared with the daemon.

`devConsole.ts` hooks browser `console.log`, `console.warn`, and
`console.error` only when daemon information reports development mode. It
relays JSON-safe arguments through the `console` RPC while preserving the
original console call.

### RPC and candidates

`useRpc` exposes typed wrappers for Session verbs (`prompt`, `abort`,
`discardSteer`, model and thinking changes, rename, and branch navigation),
address operations (`openSession`, `openProject`, `newSession`, `detach`, and
`closeSession`), Project/session listing, and Project file completion. It
centralizes failure toasts. `useBranchSelect` is the branch-target selection
matrix over `navigate`: a real branch switch when idle and following the live
leaf, a read-only rendering-leaf re-target while busy or already peeking.
`listFilesRpc` and `gitShowRpc` are small store-free helper paths for the
composer and git-change viewer.

A session switch can have old-session patches in flight until the target's
initial sync arrives. `prepareSwitch` seeds a candidate mirror when it has a
valid cache cursor. `sessionCandidate.ts` stores at most one candidate keyed
by `sessionId`; the target address-bearing patch is applied to that candidate
and then promoted atomically. The old active mirror remains in service until
promotion. A second switch is ignored while a candidate is pending, and RPC
failure discards it. This keeps old teardown patches from being applied to the
target session and makes cache write-through compare against the target seed,
not the old Document.

`sessionList.ts` converts a `listSessions` reply into a Project page and records
the address-to-session identity for each row. The first page is ten rows; the
page's compound cursor is retained for load-more requests.

### Lazy pull loop

Rendered actions enqueue `PullRequestItem` values into `pullQueue.ts` during
render. The queue schedules a microtask, and `useConnection` installs
`flushPullQueue` as its drainer. Components never call the `pull` verb
 directly. `pullLoop.ts` deduplicates requests with `planPull`, excludes fields
already loaded or in `loadingPaths`, sends one batch, ingests values into the
BridgeClient mirror, and publishes the new root.

A successful non-null value resets the retry delay to one second and bumps
`pullTick`. Null values and failures evict paths from `loadingPaths` and
schedule a retry-driven bump with a one-second doubling delay capped at 30
seconds. Reconnect replace pushes also bump `pullTick`, so visible lazy fields
register again against the repaired mirror.

## Browser Persistence

`addressIndex.ts` stores a bounded localStorage map from
`(projectId, stem)` to durable `sessionId`. The URL and Session list use the
address, while the ADR 09 cache uses the durable id. A miss is harmless: the
client opens without a cursor and receives a correct full replace.

`entryCache.ts` is the DOM-dependent IndexedDB adapter for the ADR 09 cache.
The core cache policy remains pure. Entries are stored by `[sessionId, ord]`
and status hints by `sessionId`. Delta writes are one transaction; replace
repair deletes and reinserts one Session's records in one transaction. The
adapter falls back to an in-memory cache when IndexedDB is unavailable or
fails. Cache absence, corruption, a failed read, or a failed write changes
performance only; the server Document remains authoritative.

`prepareSwitch` loads a target Session's records and status hint, derives a
contiguous prefix cursor, and seeds the candidate mirror only when that cursor
is valid. Otherwise the switch uses a full replace path.

`draftPersistence.ts` persists only compose text, not edit drafts or image
payloads. An attached Session uses `s:<sessionId>`; the Project home uses
`p:<projectId>`; the launcher has no draft scope. Restore sets the scope key
before reading storage, and an imperative subscription writes changes to that
key, avoiding stale-scope writes during navigation. A `beforeunload` handler
warns when either compose or edit text is unsent. Browser storage failure
leaves the draft in memory.

## Browser Utilities and URL Model

`routes.ts` defines the complete URL projection:

```text
/                         launcher
/$proj                    Project home
/$proj/$stem              Session, including nested stems
```

`parseRoute` decodes each URL segment once and reconstructs nested stems.
`writeRoute` encodes segments and uses `history.replaceState`, so browser
history is not a second navigation state machine. The URL is read at initial
connection and every reconnect; unknown Projects fall back to `/`. The
Project home is unattached and provides the Project-scoped first-prompt
surface. A successful address-bearing initial sync commits the open Session
address and its cache identity; a failed open lands on the Project home.

Other `infra/lib` modules have narrow boundaries:

- `unreadCounter.ts` exposes `UnreadMessageCounter`, which counts newly
  sealed, text-bearing assistant entries by Session identity, rebases on
  attach, and is independent of React. Thinking-only and tool-only entries do
  not count.
- `useMediaQuery.ts` provides reactive `matchMedia` state for responsive
  feature behavior.
- `notificationPermission.ts` caches browser notification permission and
  exposes the user-gesture request path separately from app notification
  policy.
- `imageResize.ts` validates supported image types, preserves small files,
  and uses browser bitmap/canvas APIs to resize oversized attachments before
  they enter the composer draft.

## Reconnect Invariants

Reconnect is a new transport, not a continuation of the old WebSocket. The
old pipeline is frozen before a new one is installed. Initialization refreshes
Project metadata and the global active-session snapshot, drops cached sidebar
pages, and reopens the address currently in the URL.

When an address-to-session mapping and cache prefix are available, the client
paints the cached seed immediately and sends the cursor. A valid cursor yields
a delta initial sync; an invalid or absent cursor yields a full replace. Every
replace repairs the cache from the server and removes stale suffixes. The
server's address-bearing initial-sync frame replaces the seed's status and
scoped model data and establishes the current `activeSessionId`.

Session-scoped expand and freeze state is preserved across reconnect because
reconnect does not call `clearCurrentSession`. Initial sync and pull ticks make
visible lazy fields re-register. A provisional entry that seals during or
around reconnect is handled by the same move-key migration as a live patch, so
manual expansion, frozen behavior, and keyboard focus survive the identity
change. A deliberate detach, Project switch, or failed open does clear those
session-scoped values through `clearCurrentSession`.

The correctness order is therefore: the route selects an address; the local
address index selects a possible cache identity; the cache supplies an
optional seed and cursor; the initial sync selects delta or replace; the server
Document and SessionRef become authoritative; and lazy pulls refill fields
that were intentionally omitted from the cache and wire projection.

## Related Decisions

The rationale for the client projection, selector-driven state, and layered
browser architecture was argued in ADR 07; the shipped Project/session URL
and SessionRef model in ADR 11; the cache and cursor design in ADR 09; the
git-stamp contract in ADR 10. Those ADRs are merged and deleted — git
history is the record. The three shipped client-facing slices are recorded
in [ADR 12](../adr/0012-activation-lifetime.md), which remains active.

This document is current truth; ADR citations are historical pointers, not
owners of behavior.

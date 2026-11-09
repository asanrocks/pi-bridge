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
  unread counting, media queries, notification permission, clipboard writes,
  secure-context guidance, image preparation, and the one OS-notification path
  (`userNotification.ts`).
- `render/` contains shared rendering primitives, Markdown, code highlighting,
  icons, the centered `Dialog` portal surface, the anchored `Popover` panel that
  every popover, picker, and menu composes, shared resize/result helpers, and the
  side-pane shell (`PaneShell` +
  `usePaneMode`/`usePeekDrawer`/`useEdgeReveal`) that both docked panes
  (Sidebar, HistoryPane) render into.
- `features/<area>/` owns an area and its wiring: launcher, topbar, sidebar,
  conversation, composer, history, and viewer. Components and area hooks stay
  together, so RPC and store composition belongs with the area that uses it.
  `features/viewer/` owns the repository browser (ADR 14): `FileBrowser` is the
  container (target state, tree loading, content panes), `FileTree` is
  presentational over normalized nodes, and `browserTree.ts` builds those nodes
  from either a lazy directory listing or the diff directive's changed paths.

`App` is chrome composition only. It installs the connection and draft guard,
creates the ViewModel, composes the TopBar, Sidebar, conversation or Launcher,
history pane, repository browser, and toast surface, and supplies the callbacks that
are genuinely shared by the keyboard ring and a feature. `useSidebarShell`
and `useHistoryPaneShell` keep their pane's composition and chrome handles
(mode ownership, TopBar toggle, hover signal) in its own area.
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
stable change signal. An address-bearing publication goes through
`commitObservation` instead: the address, the durable session id, the
document, and its revision land in one store write, so a subscriber can never
observe a document under an address it does not belong to (the address change
also closes the viewer portals and a session-id change clears the peek pin —
the side effects `setCurrentSession` and `setActiveSessionId` used to apply
in separate writes).

The protocol slice contains:

- `document`, the current Document root;
- `activeSessionId`, taken from the address-bearing initial-sync frame. It is
  the durable Session cache key from ADR 09, not the URL address;
- `docRevision`, the document revision, published with the document as one
  store write. The wire pipeline publishes the mirror's monotonic revision
  (advanced by wholesale replaces and same-id entry-root replacements);
  publishers outside the mirror — cache restore, cache seeding — advance the
  store's own counter, so every publication moves the revision. It covers
  content changes the structural projection key cannot see;
- `docAuthority`, the loading tri-state's source: how the published
  document relates to the rendered address. `authoritative` — confirmed by
  an address-bearing initial sync (`commitObservation`; live patches after
  it keep it — a mirror flush extends the committed document). `seeded` —
  the address's own last-known state painted from the local cache
  (`paintLocalDocument`), awaiting the initial sync. `staged` — not this
  address's document: an optimistic address change (`setCurrentSession` — a
  staged navigate keeps the previous session's document published under the
  new address) or the teardown/empty placeholder. A navigate rollback
  re-commits the previously committed view's address pair through
  `commitAddress` (with the mirror's committed root as the repainted
  document), restoring `authoritative`. The renderer derives the pending
  skeleton and the seeded continuation skeleton from it (a staged document
  renders untouched), and the projection gates the ADR 16 recovery
  derivation on `authoritative`;
- `currentProjectId` and `currentStem`, the address currently represented by
  the tab. A null stem is the Project home and a null Project is the launcher;
- `connection`, a discriminated `ConnectionState`. Its wording and severity
  live in `infra/state/connectionStatus.ts` — the single mapping consumed by
  both down-state surfaces (the TopBar chip and the Launcher full panel), so
  no other module phrases connection state;
- `projects`, models, thinking levels, and `devMode` from daemon information;
- `queue`, the global queue: every Inbox and Later Session, ordered Inbox →
  Later, then last activity descending, plus the `queueRevision` its applied
  frame carried and the `completions` log the notification hook drains; and
- `sessionPages`, lazily fetched Project history pages. Each page is
  `loading`, `error`, or `ready` with `sessions`, `hasMore`, and the compound
  `SessionListCursor` in `nextCursor`.

`clearCurrentSession` is the one teardown operation for leaving a Session. It
clears the Document, `activeSessionId`, address, session-scoped expansion and
freeze state, pull state, draft state, the rendered-leaf override, and both
fullscreen browser. It can
retain a Project id to land on that Project's home. Detach, a Project switch,
and a failed open use this boundary rather than partially clearing fields.

A session-to-session switch does not go through it (the address is committed
optimistically), so `setCurrentSession` also closes the browser when the
address actually changes — it held a path or a commit pair read from the
session being left. A same-address re-assert (the initial-sync push after an
optimistic open, a reconnect replace) keeps it open. The browser drops any
reply whose fetch started under a different address, so a slow RPC cannot land
under the new session's header. The TopBar changes badge carries the same
guard in its own state: a sample read for a different stem is hidden until the
new session's fetch lands, so a switch cannot show the previous worktree's
dirt.

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
sets, `loadingPaths`, `pullTick`, the rendered-leaf override, history, the
browser target, and toast notifications. Expansion keys use
the first action's entry and block index; action keys use the entry and block
index. Manual toggles add keys to the corresponding frozen set, preventing
streaming auto-expansion from overriding user intent. Sealing keeps an entry's
id, so expansion, frozen, loading-path, and focus keys need no migration.

`renderLeafId` is the rendered-leaf override behind read-only branch peeking.
`null` follows the live leaf; a non-null value pins the projection to a
sealed entry's root-to-leaf path without touching `status.leafId` — the
daemon never learns about a peek. `setRenderLeaf` accepts only sealed
entries (sealed entries carry `ord`), clamping an unsealed target to its
nearest sealed ancestor, and normalizes pinning the live leaf back to
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
`pullTick`, the document revision, the document-confirmation flag
(`docAuthority` — see the protocol slice), the UI slice's rendered-leaf override,
and the expanded thinking-block keys on the rendered leaf entry,
then memoizes `computeViewModel` using `viewModelCacheKey`. Its cache key
combines the leaf path identity, streaming text and expanded-thinking lengths
(collapsed thinking blocks cap at empty vs. non-empty so `thinking_delta`
frames do not invalidate the projection while collapsed), relevant
status fields, the current stem, the pull tick, the revision, the override,
the model catalog identity, and the confirmation flag. The stem matters even
when two Documents are structurally equal; the pull tick matters when lazy
values arrive without a new path shape; the revision matters because a
same-id entry-root replacement can change content the structural keys never
read; the override matters so peek and un-peek re-project over an unchanged
Document (null and absent override share one key — they resolve identically);
the catalog matters because the context percentage is computed against each
model's context window; the confirmation flag matters because it gates the
ADR 16 recovery derivation, so a provisional→confirmed flip re-projects even
when every structural input is unchanged — a cache-seeded broken tail stays
recovery-less while unconfirmed and gains its recovery row once the wire
confirms the interruption.

The projection first walks the effective leaf — the rendered-leaf override
when it resolves to a known entry, `status.leafId` otherwise — through
`parentId` and reverses the result into chronological order. Only that path
becomes the conversation ViewModel. It joins tool-result entries to their tool
calls, keeps lazy values nullable until pulled, and returns display
descriptors for user, assistant, system, user-bash, and git-change turns.
The joined tool-result descriptor carries pi's `durationMs` verbatim for the
card status line; the projection derives no tool timing of its own. It does
carry one estimate: each assistant turn's span (`turnStartedAt`, `totalMs`,
`toolMs`) and each user turn's deliberation interval (`thoughtForMs`), all
wall-clock differences over entry seals — pi records no turn total, and a
turn's details ledger needs one. The tool split subtracts the assistant-generation
windows, so parallel tools count once (the per-batch maximum), not once each.
An upstream entry type the projection cannot classify becomes an unrecognized
system turn naming the source type and carrying the raw source entry; an
extension-owned custom entry becomes an extension turn; a named
non-conversation type (a context edit, a usage record) becomes a hidden
internal entry. No path entry is dropped, and the entry-kind and turn-kind
switches are exhaustive, making a new kind a compile error rather than a
silent omission. A system-role message is a prompt-section diff, not a
conversation turn: it projects to a system-prompt turn naming the sections it
changed, with the section text lazy.
Consecutive assistant entries merge into one assistant turn. Text does not
split the turn; the flat
block sequence preserves text/action order for the renderer.

Assistant identity is `turnKey`, not merely `entryId`: it is the first entry id
(or an entry id plus a block suffix if a future rule starts a turn mid-entry).
The renderer, previous-ViewModel reuse map, keyboard focus, and navigation use
this key. Unchanged TurnVM and block references are reused, allowing memoized
children to skip work when an unrelated part of the projection changes.

A streaming block's reference still changes on every delta, so a block view
that must stay quiet takes stable scalar props — entry id, block index, flags —
and reads its live text from the store rather than receiving it in props;
`TextBlockView` and `ThinkActionView` follow that rule. A collapsed think row
selects only the thinking's first line, so once that line is complete its slice
is stable and neither later deltas nor unrelated pull completions re-render it
(the pull tick is subscribed only while the field is still null).

Renderer-side grouping carries the same identity discipline. `segmentBlocks`
and `assignGroupGitChanges` are prefix-stable — a group only gains actions at
its end and a git stamp only attaches after the action it follows — so
`AssistantTurnView` passes its previous result back in and unchanged segments,
action lists, and per-group stamp lists keep their identity. Rebuilding them
per delta would defeat every `ActionGroupView`'s memo and re-render the whole
transcript on each streaming commit.

The same discipline applies to chrome around the transcript, which is at risk
for a different reason: App hosts the projection and re-renders on every
document write, so anything it renders must bail on identical props — the
TopBar is memoized with stable callbacks (an inline arrow would defeat it),
and the shared icons are memoized over primitive props. The composer samples
its ledger through a primitive-valued selector (the cost label string) rather
than subscribing the entries object — whose identity changes per delta — with
the per-model breakdown computed only inside the transient popover that shows
it. The streaming turn's own shell (the turn view) still re-renders per delta
by design: the projection rebuilds that turn's blocks. Its groups do not — only
the group whose actions changed (the trailing one) receives new references, so
settled group headers bail.

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

The same stamp events supply the review surface's `DiffWindow`s, computed in
one pass over the path before the fold. Stamp events give every path position
a "commit in effect"; a user turn's window is its carried commit → the next
distinct commit observed later on the path (a branch-only same-commit stamp
does not end a window), and a stamp's window is the previous stamp commit →
its own commit. The live path's open-ended tail resolves to `"worktree"`; a
peeked path's open-ended tail resolves to nothing (the worktree is not the
peeked state), and a window is omitted whenever either end is unborn — no
honest pair, no diff offer.

`segmentBlocks` groups consecutive thinking and tool blocks for rendering;
text remains a separate segment. `actionPulls` declares thinking and tool-call
fields needed by visible actions, and `resultPullPaths` declares the lazy tool
result fields needed by an expanded action. These functions are the sole
ViewModel-to-pull mapping. A view subscribes to `pullTick` only while it still
owes a pull (a missing field): a settled view must not re-render when an
unrelated ingest lands, which at group level would mean every group in the
transcript. Display helpers that need no Document access live
beside the projection: the apply-patch module parses Codex-style
`apply_patch` envelopes (streaming-tolerant, no disk access) into per-file
sections for the web card, and feeds the action summary/header (`patch: <file>
+N`), the `edit` kind (mutate hue), and the group summary's file list.

## Network Layer

### Connection lifecycle

`useConnection` creates one `WebSocket` and one `BridgeClient` per connection.
The state machine is:

```text
connecting -> connected | init_failed
connected connection drop -> reconnecting -> unreachable
```

A socket being open is not enough to become connected. Initialization must
complete `getDaemonInfo` and `listQueue` within 8 seconds, populate
Projects, model metadata, development mode, and the queue, then open the
route-driven address. Failure after the socket opens
is `init_failed` and can be retried without replacing the socket.

After a successful connection, drops count from one. Attempts below five are
`reconnecting`; attempt five and later are `unreachable`. `unreachable` still
auto-retries. The transport uses exponential backoff with a 500 ms base, a
5,000 ms cap, and up to 30% random positive jitter. Manual retry cancels the
timer, resets the attempt count, and connects immediately. A superseded or
disposed connection cannot write to the store or cache.

Connection state gates capabilities, never rendering. The store's document
is always the last known state of the watched session and renders whatever
the connection says: mutation surfaces (composer, keyboard ring) and RPC
paths gate on `connected`, while the TopBar chip and the Launcher's down
states carry the wording. At mount, the local half of boot seeds the document
from the IndexedDB cache in parallel with the first connect, so a cold boot
is the same shape as a reconnect that still holds its document in memory.

### Per-connection modules

`connectionTransport.ts` adapts WebSocket send/receive to the browser-safe
`BridgeTransport` and owns the backoff calculation. `connectionPipeline.ts`
receives BridgeClient pushes and is the write boundary for store, route, and
cache updates:

- live patch operations are coalesced into one store flush per animation frame
  while visible and approximately one second while hidden — except that a
  patch touching `/status` flushes synchronously: backgrounded tabs suspend
  their timers, so a coalesced status write would only land at the resume
  flush, with a stale `document.hidden` read, losing the turn-completion
  notification that observes the streaming→idle transition at store level;
- every flush publishes the mirror's document together with its monotonic
  revision as one store write — the two values always describe the same
  mirror snapshot. The revision is advanced by a same-id entry-root
  replacement (sealing in place, an authoritative rewrite) or a wholesale
  replace, and is a declared projection input: structural identity cannot see
  that content changed, so re-projection is gated on the published revision,
  not on a side channel. Publishers outside the mirror (cache restore,
  cache seeding) call the same publication action and advance the store's
  own counter, so their same-shape replacements re-project too;
- a replace is an immediate flush barrier;
- live deltas use `planCacheWrites` against a per-session `cacheBase`, writing
  sealed, ordered cache records through the IndexedDB adapter;
- a replace repairs the entire session cache, including deleting stale suffix
  records, and establishes the new cache base; and
  before the new Document root is published.

The pipeline handles listing pushes without touching the Document. The queue
arrives as a `queue_changed` snapshot first and then as deltas: one store
write applies the dirty rows, the removals, and the Projects whose cached
history the interval invalidated (ADR 24). The store keeps the queue as one
ordered array derived from those frames, using the comparator shared with the
host, so a delta can never disagree with the order the server published. A
delta whose revision is not exactly one ahead is a lost frame: the pipeline
reports it to its owner (`PipelineOwner.onResyncNeeded`), which replaces the
socket instead of applying a delta to an untrusted base. Invalidated Project
pages are dropped from `sessionPages`, so the next unfold refetches them from
the first page; history replies and pagination never write the queue.
A `session_closed` push names an address whose live runtime ended on the
host (a move to Archive or Trash); when it names the rendered Session,
the server has already severed the attachment, so navigation clears to the
Project home through the same boundary a failed open uses — the document on
screen can never progress again, and a later command cannot reach a disposed
runtime. A close of some other Session is ignored: the list pushes cover it.

An address-bearing `replace` or initial-sync `patch` establishes
`activeSessionId`, `currentProjectId`, `currentStem`, the address index entry,
and the route — in ONE store write (`commitObservation`), together with the
document and its revision, so no subscriber can observe a new document under
an old address or the reverse. A normal live patch has no SessionRef and only
advances the current mirror (the pipeline's coalesced flush). The
address-bearing frame is therefore the synchronization barrier at which the
target session becomes authoritative — and the whole publication at that
barrier is the navigation reactor's, not the pipeline's: the pipeline drops
its coalesced old-session ops (the barrier), forwards the frame, and then
writes the cache records for the observation the reactor committed — the
delta write-through runs only under the committed session id, so a frame the
reactor ignored (superseded, abandoned, cancelled) publishes nothing and
persists nothing.

### Navigation

`navigation.ts` is the browser view actor (ADR 19): the one owner of
browser Session selection. Opening a
Session, showing a Project home, leaving to the Launcher, and resolving the
`/@latest` alias are transitions of one state machine — built on the core
reactor primitive — whose state is the committed view (`current`), at most
one in-flight session transition (`pending`), the candidate document seeded
for that transition, the most recently superseded or closed target
(`abandoned`), the cancelled transitions, and the committed attachment
generation. Observation delivery is typed — the pipeline hands over
`ViewObservationEvent` values (`viewEvents.ts`) through one seam
(`navigationObservation`), deciding nothing itself — and every observation
frame carries the attachment generation that produced it (ADR 19): the
actor records the generation of the frame that committed the view, a
re-assert or `session_closed` from any other generation never commits or
ends the view (same address or not; a null committed generation means no
observation is committed, so nothing re-asserts).

Every read and write of published state goes through the **view port**
(`viewPort.ts`, ADR 19): the port is the complete inventory of the actor's
inputs (the rendered address, the published session id, the rendered
document facts) and outputs (stage, commit, restore, clear, paint, route,
alias flag). The store, the history API, and the address index are one
adapter's mechanics behind it (`createNavigationViewPort`), injectable
through `NavigationDeps.port`; the actor's steps never touch them
directly, so the local-seed race guard and the close/rollback decisions
read one owner's publication — their own. One
authority rule governs the whole module:

> A step may read and write anything; an effect may only observe and return
> a message.

Effects fetch — the target's cached prefix, the alias target, the open RPC,
the detach RPC — and return their outcome as a completion message that
settles the caller. Every mutation of store, mirror, candidate, cache base,
route, or address happens in a step, where the epoch is available, so an
unordered effect write is unrepresentable rather than guarded against.

An opening transition is two-phase, because seeding must precede the RPC
(the server pushes the initial-sync frame before the RPC reply, and the
candidate or mirror must already hold the cached prefix when that frame
applies):

- The intent message stages the target optimistically (address, and for
  user navigation the route) and admits a value-only prepare effect that
  reads the target's cache records. The `prepared` completion seeds in the
  step: user navigation seeds a candidate document when the records yield a
  cursor and paints the cached prefix into the store (the instant switch:
  the previous conversation is replaced at once, marked `seeded`, with the
  continuation skeleton in place of any wire claim — skipped when the
  committed view is already the target, so a re-navigate cannot downgrade
  the live authoritative document to a cache snapshot); a boot (route-driven,
  reconnect, or alias resolution) seeds the live mirror and store from the
  cache. A superseded transition's prepare
  sends no RPC at all: the server serializes attachment transitions in
  arrival order, so a late RPC from an abandoned intent could attach the
  abandoned session after the successor's command ran, leaving the
  connection attached to a session the UI no longer shows. Its caller
  settles client-side (superseded — nothing ran, nothing failed), and no
  settlement will arrive for it. An RPC admitted before the supersede runs
  to completion server-side, and its sync and settlement commit nothing. A
  transition cancelled by a terminal close admits no RPC either (the
  runtime it targeted is gone).
- The address-bearing initial-sync frame returns as a `sync` message and
  commits the view as one store write (`commitObservation`): address, durable
  id, document, revision, address-index entry, route (the alias view keeps
  the alias URL). A matching delta promotes the candidate and re-bases the
  cache base on its pre-promotion document. A sync for a superseded or
  cancelled transition commits nothing — the pending-owner and intent-epoch
  comparisons, one each.
- The RPC reply returns as an `openSettled` message. It confirms (defensively
  committing the ref the server already pushed), rolls back to the last
  committed view, or lands on the Project home — but only while the
  transition is still the newest intent; a superseded transition settles its
  caller and commits nothing. A navigate's rollback also repaints the
  previous view's document (the mirror's committed root — candidates promote
  only at commit), so the instant-switch paint's snapshot does not survive
  the failed switch.
- The Project-home and Launcher transitions release the server-side
  attachment from the staged intent, not the committed view alone: a pending
  open may already have its RPC on the wire (admitted while it owned the
  view), so the server can be attached — or about to attach — to a session
  the committed view does not name. Reading only `current` left the server
  attached to the pending open's session while the UI showed the Project
  home; the detach decision reads `pending ?? current`.
- The `/@latest` resolution returns as a completion carrying the epoch of
  the intent that started it, and is checked against the current intent
  before staging anything: a lookup that lands after a newer navigation
  committed is a silent no-op — it cannot re-enter as a fresh intent and
  override the successor, and a stale "nothing to open" answer cannot clear
  a committed view.
- Creating a Session is a navigation-owned transition too (`navigationCreate`):
  it mints an `operationId`, supersedes any pending open (which settles
  superseded without sending), and sends the `newSession` RPC as an effect.
  The server carries the id onto the transition's initial-sync frame and the
  reply, so the frame commits the created address only while that creation is
  still the newest intent — a stale or cancelled creation's sync selects
  nothing, and a newer intent blocks the reply's defensive commit. The
  creation slot frees at settlement, ready for the next creation. An
  unattributed initial-sync frame (no `operationId`) can no longer select a
  new address at all: it may only re-assert the already-rendered address,
  idempotently. The host's
  `session_closed` push cancels a pending transition targeting that address
  (its caller settles, its prepare admits no RPC, its late sync and reply
  commit nothing), removes that address as a rollback target for a
  transition in flight to another session, and lands on the Project home
  when it names the rendered Session.
- `useRpc`'s address operations are thin wrappers over the transition
  messages; `useConnection`'s boot path sends them with boot semantics. The
  cache base is the actor's private state (ADR 19): the boot seeding and
  the promotion install it, and the pipeline reads and advances it through
  `cacheBaseDocFor`/`advanceCacheBase` — never the box itself.

`sessionBoot.ts` keeps the local half of boot, and it is value-only
(ADR 19): `restoreLocalSession` reads the route's remembered `sessionId`,
loads the cache records and status hint, and returns the seed — the
address, the durable id, and the quiesced document (a cached mid-flight
turn can never progress without the daemon, so streaming, compaction, and
pending steer are cleared) — writing nothing. The seed goes to the view
actor (`navigationLocalSeed`), whose `localSeed` step decides whether the
values become visible behind the store-based race guard that never lets
stale cache overwrite wire data: the guard reads exactly the invariants
navigation maintains — the address is staged before the RPC resolves, and
the durable session id lands only with the initial sync. With no
remembered id, no records, or a failed read there is no seed and the
address stays unclaimed, so the Launcher's down states show while
connecting.

`useAttentionNotifications.ts` (in `app/`) covers the other half of
completion signaling: the attached conversation drives the tab title and the
unread count, while a Session this tab is *not* reading is announced from the
`session_completed` pushes the pipeline files in the store's `completions` log.
The signal is an occurrence, not a comparison of queue snapshots: the queue is
published at most once per five seconds (ADR 24), so a short turn may never
appear as running, and completion therefore arrives as its own frame. The hook
drains the log by sequence, so a notice is announced exactly once, and it stays
silent for the attached Session. Delivery follows
what the reader can see: an
in-app toast while the page is visible, one OS notification per finished
Session while it is
hidden, posted through `infra/lib/userNotification.ts` with the Session's
address in `notification.data` and its own tag (`notificationTag`), so
simultaneous completions remain separately clickable. A click returns through
the service worker:
`web/public/sw.js` focuses the open client and posts the address, and
`infra/net/useServiceWorkerSessionOpen.ts` turns that message into the same
`openSession` intent a click in the switcher sends — the worker never writes a
route, and the navigation actor remains the single owner of browser Session
selection. With no client open, the worker opens the address's own route
directly.

`devConsole.ts` hooks browser `console.log`, `console.warn`, and
`console.error` only when daemon information reports development mode. The
hooks are installed once per page and repointed at the current client: a
reconnect re-hooks rather than nests, so each line is relayed exactly once,
through the client that owns the connection — never once per connection the
page ever had, through dead sockets. It relays JSON-safe arguments through
the `console` RPC while preserving the original console call, and restores
the original methods when the connection closes or the app unmounts.

### RPC and candidates

`useRpc` exposes typed wrappers for Session verbs (`prompt` — which carries
the send's model selection; there is no separate model verb — `abort`,
`discardSteer`, rename, and branch navigation),
address operations (`openSession`, `openProject`, `newSession`, `detach`, and
a move), Project/session listing, and Project file completion. It
centralizes failure toasts. `useBranchSelect` is the branch-target selection
matrix over `navigate`: a real branch switch when idle and following the live
leaf, a read-only rendering-leaf re-target while busy or already peeking.
`listFilesRpc`, `gitShowRpc`, `gitBaseRpc`, `gitDiffRpc`, `readFileRpc`, and
`listDirectoryRpc` are small store-free helper paths for the composer, the
git-change viewer, and the browser. The browser splits the two roles:
`gitDiffRpc` fetches the *directive* (file list, statuses, counts) and
`readFileRpc` fetches the *payload* (one path at one state) for the file pane
and for each expanded review section, which is diffed client-side by the
shared `DiffSections` renderer. `listDirectoryRpc` lazily lists one directory
per tree expansion. `gitBaseRpc` resolves a commit card's review base (its
first parent, or the empty tree for a root commit) so the browser opens a
commit against the right baseline. All four are attachment-free and absolutely
addressed; `openFileViewer` resolves a relative entry-point path against the
current Project cwd (via `infra/lib/paths.ts`) before opening the browser.

`asrCredentialsRpc` fetches the dictation credential the daemon holds. It is
store-free and not toasted: the composer disables its microphone and shows the
reason in place, because a daemon that cannot mint a token or register a device
is a capability answer. The credential is prefetched when the composer mounts
(a `getUserMedia` call reached after an RPC await has lost the gesture that
allowed it), and the ASR session itself runs from the page to the endpoint — the
bridge socket carries only the credential.

`dictationPolicy` answers the capability question instead of handling an error:
a plain-HTTP origin outranks everything, a missing connection disables starting
even with a cached credential, and a failed request keeps retrying with backoff
while the control names the failure. A minted token is refreshed shortly before
its advisory expiry, so the page never starts an utterance on a token the daemon
has already rotated. `DraftOwnership` binds one utterance to the draft it began
in: a Session or Project switch moves the ownership before cancelling, and every
later read or write from that utterance is refused, so a delayed result cannot
land at offsets that describe another document. The ASR package supplies the
rest — cancellation ends a pending settlement, the commit's own native edit is
what makes one undo remove the utterance, `onSettled` reports each ending once —
and the hook only decides what to show and when the control may start.

The dictation surface is a toolbar, and the microphone is only its disclosure:
`DictationToggle` carries `aria-expanded`/`aria-controls` and no phase state,
which is why the bridge does not use the ASR package's `bindButton` affordance
(the demo still does). `useDictation` owns the disclosure flag beside the
controller and exposes the toolbar's transport — record, keep, discard — with
the field focused after each press, because the pressed control is replaced or
removed by the phase it causes. `DictationToolbar` is phase-driven: an idle form
with record, and while an utterance runs the phase word, a 1 Hz clock write, the
meter reading `--asr-level`, and the two endings. Neither the clock nor the
level enters React state. The availability reason is a row of the same panel,
not a toast: an unavailable microphone still opens the toolbar and the row
states why. The disclosure flag lives beside the controller and is persisted
(`dictationToolbarPreference`, one `localStorage` key for both surfaces), so
showing the panel is a device preference rather than session state; and the mic
only discloses — recording starts from the toolbar's record control, whose press
is the `getUserMedia` gesture. `useDictation` also keeps the last edit the composer made and what its undo
control would take back — offered only while the field still holds that edit, and
verified again before it writes, so an edit that outran the press leaves the text
alone.

Text polish rides the same hook and the same row, because it is another
operation on the same field and needs the same three guards — `DraftOwnership`,
the edit refusal, and the toolbar. It has no controller: one `textPolish` RPC
sends the whole draft, and the answer is installed as the one region that
differs. `textPolish.ts` owns the parts that are pure — the changed span between
the two texts, the "still installed" check, and the `PolishState` the row reads —
so the rules are testable without a DOM. The undo record is a *replacement*
(`span`, `inserted`, `replaced`) rather than an insertion, which is what lets one
control serve both operations: a transcript inserted into an empty span and a
polish that replaced a region are both undone by writing `replaced` back over
`inserted`, and only after the field still holds `inserted` at that span.
Scope is deliberately the changed region: typing elsewhere does not invalidate
it, and a whole-draft rewrite therefore does not force the user to undo before
carrying on. Polish needs nothing but a connection — the daemon owns the protocol
and the identity, and no secure context is involved — so the control is offered
whenever the composer is connected, and it states every failure in the row
instead of a toast.

A session switch can have old-session patches in flight until the target's
initial sync arrives. The candidate document is the navigation reactor's
*transition state*: the `prepared` step stages it from the cache records the
prepare effect read (only for the transition that still owns the view), and
the promoting `sync` step consumes it atomically — `sessionCandidate.ts`
holds the pure promotion function, keyed by `sessionId`, with no module
state of its own. The old active mirror remains in service until promotion.
A newer transition supersedes an in-flight one through the intent-epoch
comparison; a superseded prepare seeds nothing; and settlement or a terminal
close discards the candidate. This keeps old teardown patches from being
applied to the target session and makes cache write-through compare against
the target seed, not the old Document.

`sessionList.ts` converts a `listSessions` reply into a Project page and records
the address-to-session identity for each row. The first page is ten rows; the
page's compound cursor is retained for load-more requests.

`latestSession.ts` resolves the `@latest` target inside the alias's scope: the
most recently active live Session there from the global snapshot, else the most
recent durable Session there (the Project's first `listSessions` row, or each
Project's for the root form), which the open then activates.

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

A reply is admitted only while it still describes the current view. A
reconnect replaces the global client, so a reply arriving on the old socket
is dropped — the dead client's mirror is not a publication source. A session
switch on the same socket replaces the mirror wholesale, and entry ids are
unique per session, so a reply whose entry ids are gone addressed the previous
session; writing it would auto-create the paths and fabricate those entries
inside the successor document. A reply is also a *read of the moment the
request left*, so it may only fill a field that is still unfetched, in the
entry form it was issued for: a seal replaces the streamed entry under the
same id with persisted content, and a live patch may already have delivered
newer content (streamed appends) than the reply carries. Both are older than
what the mirror holds, and nothing later would repair a value the newer
publication already superseded. Dropped replies schedule no retry: the
revision or patch that superseded them triggered its own re-projection, and
the visible fields re-register on their own.

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

`public/sw.js` is the service worker: the notification vehicle (OS-channel
`showNotification`, which displays while the browser is backgrounded on
mobile) and the offline app shell. Its fetch handler serves navigations
network-first — so a redeploy is picked up immediately, the shell being
`no-cache` — falling back to the last cached shell when the daemon is down,
and serves `/assets/*` cache-first (content-hashed, immutable). Everything
else passes through untouched; the WebSocket RPC is not a fetch at all.
Requests are discriminated by mode and URL, never by re-implementing the
server's resource-vs-address path rule — the daemon stays the single
authority for what a path means. `sw.js` itself is served `no-cache` so
worker update checks see a new version promptly. The vite dev server is
unaffected: it serves no `/assets/*` paths, and network-first navigations
pass through while it is up. Registration (`app/main.tsx`) is
secure-context-only and failure is non-fatal. The worker only helps from the
second visit onward — a first visit with the daemon down has no installed
worker and no cached shell. The fetch policy is unit-tested by executing the
shipped `sw.js` with stubbed `caches`/`fetch` (`test/suite/sw-fetch-policy.test.ts`).

Installation metadata is part of the same asset surface. `public/manifest.webmanifest`
is committed: `id` and `start_url` are `/` (the launch address is the launcher;
routes are read at boot and written with `replaceState`, so an installed window
has no browser history to lose), and `display` is `standalone`. The manifest
and `/favicon.svg` are served `no-cache` — a renamed app or a changed icon has
to land on an already-installed client — while `/icons/*` are unhashed build
output served with a day of `max-age`. The icons themselves are not committed:
`web/build-icons.ts` holds the pi mark as a 4×4 cell grid plus a `node:zlib`
PNG encoder, and the vite plugin in `web/vite.config.ts` (`iconsPlugin`) emits
`icons/*.png` and `favicon.svg` into the build root and serves them from the
dev server. Brand geometry therefore stays reviewable in code and image
libraries stay out of the dependency graph. The manifest, its icon paths, the
maskable safe circle, and Chromium's required members are asserted in
`test/suite/web-icons.test.ts`; the daemon's MIME and cache behavior for those
paths is asserted in `test/suite/http-serving.test.ts`.

Installability is a secure-context capability: with no TLS on the daemon, only
`http://localhost` (a tunnel) or a reverse proxy yields one, so a plain-HTTP
LAN origin cannot install at all — `SecureContextHint` names installation
among the withheld capabilities. `icons/` is a reserved Project id, because
every top-level name of the build root is an asset path; the daemon rejects a
colliding id at startup.

The switch's cache read is the navigation prepare effect: it loads a target
Session's records and status hint, and the `prepared` step derives the
contiguous prefix cursor and stages the candidate document from them (a
cursor that does not validate means a full replace path).

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
/@latest                  alias — cross-Project, resolved at boot, never
                          redirected (ADR 13)
/$proj/@latest            alias — that Project's newest Session, same rules
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

Aliases (ADR 13) are segments beginning with `@` — a prefix no Project id may
carry, so the namespaces cannot collide — and their position is their scope:
the root form spans Projects, a Project's last segment resolves inside that
Project. Boot resolves `@latest` to the most recently active live Session in
scope from the global active snapshot already fetched by initialization; when
none is live it falls back to the most recent durable Session in scope (the
Project's first `listSessions` row, or each Project's for the root form) and
opens it, which activates it — only when no Session exists at all does it land
on the scope's home (the Project home, or the launcher for the root form).
While the alias view
holds, navigation suppresses the route write on the initial-sync commit, so
the URL keeps the alias form and the store holds the resolved address. Any explicit navigation (open, Project switch, detach, first prompt)
clears the alias view and commits a real URL; a reload re-resolves, possibly
onto a newer session. The alias never enters the address index or the cache
key. Because the sigil owns its segment, a Session stem may not begin with
`@` at the scoped position.

Other `infra/lib` modules have narrow boundaries:

- `unreadCounter.ts` exposes `UnreadMessageCounter`, which counts newly
  sealed, text-bearing assistant entries by Session identity, rebases on
  attach, and is independent of React. Thinking-only and tool-only entries do
  not count.
- `useMediaQuery.ts` provides reactive `matchMedia` state for responsive
  feature behavior.
- `notificationPermission.ts` caches browser notification permission and
  exposes the user-gesture request path separately from app notification
  policy; an unavailable API or a denial on an insecure origin raises the
  secure-context hint.
- `clipboard.ts` is the one write path for app copy actions: it uses
  `navigator.clipboard` only, and a failure raises the secure-context hint.
  `copyWithExecCommandFallback` is scoped to the guidance dialog, whose copy
  controls must work where `navigator.clipboard` is missing; a hidden-selection
  `execCommand("copy")` carries the text there. Ordinary app copy actions never
  take that path. A success also announces "Copied to clipboard" through a
  visually hidden polite live region on both paths: the Check swap and the
  button's `aria-label` change are invisible to a screen reader, and a label
  change is not announced.
- `secureContext.ts` detects a withheld secure context
  (`window.isSecureContext === false`, i.e. a plain-HTTP intranet origin) and
  builds the browser-detected fix steps: the Firefox pref and bare hostname,
  a Chromium browser's own flags URL and the full origin, or no step for
  WebKit-based/unknown browsers (iOS builds that name Chrome or Firefox are
  normalized to WebKit). `noteSecureContextFailure` opens the shell dialog at
  most once per browser session (`sessionStorage`), never stacks while open,
  and no-ops on a secure origin. It is guidance only — nothing retries or
  routes around the browser's decision, and service-worker registration
  failure stays silent because it has no user gesture.
- `imageResize.ts` validates supported image types, preserves small files,
  and uses browser bitmap/canvas APIs to resize oversized attachments before
  they enter the composer draft.
- `zoom.ts` owns the display scale: the step ladder, the `--ui-scale`
  publication on the document element (consumed by the `--fs-*` tokens in
  `app/index.css`), the `localStorage` device preference, and the touch
  pinch/double-tap handlers installed from `main.tsx`. Geometry that is
  px-measured and text-coupled (the History row pitch and time column) reads it
  through `useZoomScale`.
- `time.ts` is the one place a time is written: `formatWhen` (the label
  ladder), `formatWhenFull` (the hover/accessible instant), and
  `formatDuration`. `useNow.ts` is the clock behind them — one module-level
  interval per page, running only while something is subscribed, resampled when
  a backgrounded tab becomes visible. The single ladder (relative → clock →
  weekday → date) is normative in the web design doc; session buckets read the
  same classifier, so a heading never contradicts a row's label.

## Reconnect Invariants

Reconnect is a new transport, not a continuation of the old WebSocket. The
old pipeline is frozen before a new one is installed. Initialization refreshes
Project metadata and drops cached sidebar pages; the queue arrives as the new
Connection's snapshot push rather than as an initialization query, so a
reconnect cannot pair a query reply with a delta it already applied. Membership
is daemon-persisted, so a daemon restart during the drop loses no queue
entries. The URL's address is then reopened.

When an address-to-session mapping and cache prefix are available, the client
paints the cached seed immediately and sends the cursor. A valid cursor yields
a delta initial sync; an invalid or absent cursor yields a full replace. Every
replace repairs the cache from the server and removes stale suffixes. The
server's address-bearing initial-sync frame replaces the seed's status and
scoped model data and establishes the current `activeSessionId`.

Session-scoped expand and freeze state is preserved across reconnect because
reconnect does not call `clearCurrentSession`. Initial sync and pull ticks make
visible lazy fields re-register. A live form that seals during or around
reconnect keeps its id, so manual expansion, frozen behavior, and keyboard
focus survive the transition unchanged. A deliberate detach, Project switch, or failed open does clear those
session-scoped values through `clearCurrentSession`.

Offline rendering is that invariant seen from boot: the document is always
last-known-state and always renderable, and a cold boot of a remembered
address is exactly a reconnect that still holds its document — the cache
supplies what memory would have. The service worker completes the picture at
the delivery layer: a reload while the daemon is down loads the cached app
shell, and the local restore renders the session from the IndexedDB cache.
The scope is session-content recovery on a direct open. The launcher,
session listing, alias resolution (`@latest` needs the daemon), and
switching to a different session all require the wire and show their down
states without it; lazy fields of cached entries render unloaded until a
reconnect's initial sync re-registers them.

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

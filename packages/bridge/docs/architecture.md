# pi-bridge architecture

This document is the high-level current-truth description of pi-bridge. It
explains the problem, the central model, the layer boundaries, and the
invariants that let a browser or another client observe and steer a pi
Session without reimplementing pi's event loop.

## 1. Problem and central insight

A pi Session is durable JSONL plus a live event loop. A client needs a stable
conversation while the Session is streaming, reconnecting, branching, and
being viewed by more than one client. Sending raw events makes every client
rebuild the same state machine and makes late join, lazy content, and partial
turns transport concerns.

pi-bridge instead synchronizes a **Document**. The host owns one canonical
Document for one live Session. pi remains the durable backing store and the
source of events; the bridge projects events and durable entries into
immutable patches. A client holds a `DocumentMirror`, applies the same patches,
and pulls only the lazy values it needs. A reconnect gets an authoritative
initial sync rather than a replay of an event history.

This separation gives each concern one owner:

- pi owns persistence, model execution, tool execution, and event ordering.
- the host owns Project routing, live Activations, the canonical Document, and
  the WebSocket protocol.
- core owns the wire-safe types and pure Document, patch, and sync functions.
- the web client owns the URL projection, cache seed, ViewModel, and rendering.

## 2. Domain model

A **Project** is static daemon configuration: one canonical, allowlisted
working directory and its pi Session storage namespace. A **Session** is one
conversation inside a Project. Its public address is `(projectId, stem)`, where
`stem` is a normalized relative path below the Project's Session directory.
The durable `sessionId` from the pi header is the cache identity, not the URL
address.

An **Activation** is the daemon-internal live runtime for exactly one Session.
It contains one Manager and one canonical Document. An Activation is never
rebound to another Session and is never sent over the wire. Several
Connections may attach to the same Activation; each Connection has at most one
attached Session. A dormant Session is represented by its file and is opened
into an Activation on demand. An idle Activation is collected when it has no
Connections and is not streaming or compacting, subject to the host's idle
collection policy.

The daemon enforces the important ownership rules at its boundaries:

- Project ids and stems are validated before filesystem resolution.
- Existing and intermediate symlinks must remain inside the Project's Session
  namespace.
- One address has at most one live Activation, including while creation or
  collection is in flight.
- A durable `sessionId` cannot be claimed by two Project/stem addresses.

The browser navigates by URL:

```text
/                              launcher and global active Sessions
/<projectId>                   Project home and floating compose draft
/<projectId>/<relative-stem>   one Session
```

The URL is the navigation source of truth. The Project home is unattached and
can admit the first prompt through `newSession`; there is no empty daemon
Session created only to hold a draft.

## 3. Layers and ownership

```text
pi runtime
  | ordered events and durable entries
  v
Manager: canonical Document for one Session
  | unfiltered patches and initial-sync frame
  v
Connection: one WebSocket, subscriptions, RPC demux, compact transport
  | replace/patch pushes, registry pushes, RPC replies
  v
BridgeClient + DocumentMirror: browser-side replica and typed RPC
  | store root, ViewModel, pull queue, URL and cache orchestration
  v
React web client: Session reading, steering, and rendering
```

The layers are logically separate even though the daemon runs them in one
Node process.

**Core and ViewModel.** `core` is pure and browser-safe. It defines the
Document and Entry types, JSON Patch plus `append`, event application,
reconciliation, mirror operations, lazy-path filtering, compact transport, and
cache/sync policy. The ViewModel is also pure and maps the active Document
branch into turns, actions, git observations, sibling navigation, and pull
requests. Neither layer knows about WebSockets, the DOM, or the filesystem.

**Host.** The Manager subscribes to pi, applies events in order, reconciles
against durable entries at settle boundaries, and sends patches to its
listeners. A Connection owns one WebSocket and one attachment. It filters
lazy paths using its own subscriptions, handles `pull`, demultiplexes typed
RPC verbs, and sends initial sync before later live patches. The Daemon owns
Projects, Activation reservations and collection, Connection registration,
Project/session queries, and HTTP serving.

**Web.** `BridgeClient` is the only browser-side wire envelope owner. Its
DocumentMirror applies `replace` and `patch` pushes with immutable structural
sharing. The web store holds the current Document root, the current
Project/stem address, Project metadata, active Session snapshots, draft and
UI state. The route-driven connection layer seeds an optional cache mirror,
opens the URL address, promotes the target after an address-bearing initial
sync, and reissues visible lazy pulls.

## 4. Data model

The canonical value is:

```text
Document {
  status: Status
  entries: Record<id, Entry>
  scopedModels: ScopedModelInfo[]
}
```

`status` contains the selected leaf, Session name, model identity, thinking
level, streaming and compaction flags, token/cost statistics, context usage,
and pending steer messages. `entries` contains the complete wire-safe union:
messages, tool results, user bash executions, compaction and branch summaries,
model and thinking-level changes, labels, Session info, and custom entries.
Committed entries are immutable. During a turn, streamed entries live beside
them under provisional ids such as `pending:message` and
`pending:<toolCallId>`.

The event path is delta-driven:

- `applyEvent(document, event)` creates provisional skeletons, updates status,
  appends streamed strings, and applies authoritative end values.
- `reconcile(document, piEntries, options)` walks the complete durable list in
  file order, discovers silent entries, repairs status, assigns `ord`, and
  seals provisional entries by moving them to durable ids.

A seal is one atomic Patch. The patch includes the move, durable metadata,
any needed lazy backfill, and related status changes. Cancellation finalizes
assistant and tool-result entries as aborted or error entries; it does not
remove a partial entry.

`ord` is the zero-based position in the complete durable Session entry list.
It is sync and cache metadata, not render order. It is assigned only when the
ordered list is available, so a provisional or newly observed entry may lack
it until reconciliation or initial-sync construction.

Laziness is a wire projection, not a canonical storage property. The canonical
Document holds real values. Thinking text, tool-call arguments, tool-result
content, and tool-result details are null only in a wire or cache projection
when they have not been pulled. Text, metadata, summaries, and Session state
are wire-eager. Git stamps are ordinary custom entries: they persist, seal,
cache, and synchronize through the same Document while remaining inert in pi
context.

## 5. Sync model

### Push and RPC channels

One WebSocket carries two typed channels. Frames with an `id` are RPC calls or
replies. Frames without an `id` are server pushes. RPC replies carry
acknowledgement, query data, or an error; Document state arrives only through
pushes.

The push contract is:

- `replace` carries a `SessionRef` and a complete wire-projected Document.
- `patch` carries ordered Patch operations. Only a cursor-aware initial-sync
  patch carries a `SessionRef`; live patches do not.
- `sessions_changed` carries the refreshed first page for one Project.
- `active_sessions_changed` carries the global active or streaming Session
  snapshot.

The host sends exactly one initial-sync frame when a Connection attaches. The
frame is sent before later live patches and before the successful navigation
reply. `openSession` resolves a Project/stem address; `newSession` admits the
first prompt before attaching. `detach` releases the Connection without
creating a new address.

### Prefix sync and cache

The durable entry list is the ordering authority. The browser cache stores only
committed, lazy-stripped entries with `ord`, keyed by durable `sessionId` and
position. It derives a `PrefixCursor` from a contiguous prefix:

```text
PrefixCursor {
  sessionId
  lastKnownId
  entryCount
}
```

The server validates the cursor against the current Session id, length, and
anchor. A valid cursor produces one address-bearing multi-operation patch for
the missing committed suffix, current provisional skeletons, full status, and
scoped models. An absent or invalid cursor produces one address-bearing
replace. Either form repairs the mirror's authority; a replace also repairs
the Session's cache records and removes stale suffixes.

A client may seed a candidate mirror while opening another address, but the
current mirror is promoted only when the initial-sync frame names the target
`SessionRef`. A failed open leaves the current mirror and route intact. Cache
absence, corruption, or a stale cursor changes performance only: the server
falls back to replace.

### Lazy pulls and transport compaction

The web ViewModel declares pending lazy paths while rendering. One pull-loop
drainer deduplicates them against the mirror and in-flight requests, sends one
batch, and ingests the values. Pulling a provisional field also subscribes the
Connection to later updates on that path; pulling a committed field is
one-shot. The Connection filters live patches per subscription and sanitizes
lazy fields embedded inside parent add/replace values, so filtered replay and
fresh wire initialization converge.

At the WebSocket boundary, `CompactCodec` may encode consecutive ordinary
single-append patches to one path as bare JSON strings. The first append primes
the path. Replace, initial-sync frames, multi-operation patches, non-append
operations, broadcasts, RPC replies, and attachment changes clear the codec
state. The decoder restores the full append operation before the mirror sees
it.

## 6. State machines

### Document lifecycle

```text
bootstrap --initFromEntries--> idle
idle --live pi event--> streaming
streaming --turn_end / agent_settled--> sealing
sealing --reconcile and seal--> idle
idle --idle Session verb--> idle
```

The event loop is serial. `applyEvent` and `reconcile` are synchronous pure
projections; the host applies each resulting Patch before dispatching the next
one. `setModel`, `setThinkingLevel`, and `renameSession` reconcile immediately
when idle. `navigate` changes `status.leafId` directly so reconciliation does
not undo a selected branch.

### Connection and Activation lifecycle

```text
Connection: connecting -> connected
            connected --socket drop--> reconnecting -> unreachable
            connected --init failure--> init_failed

Attachment: detached --openSession/newSession--> attached(Project, stem)
            attached --openSession(other address)--> attached(other address)
            attached --detach--> detached
```

Connection recovery refreshes daemon metadata and active Sessions, reads the
current URL, optionally seeds the address from IndexedDB, and resolves the
address again. An Activation may continue a turn after its last Connection
detaches. Collection happens only after the host's attachment, streaming, and
compaction conditions are checked; collection never deletes the Session file.

## 7. Invariants

These are the load-bearing rules for changes across layers:

1. **The Manager owns the canonical Document.** No other path writes that
   canonical root; pi is the durable backing store.
2. **Committed entries are immutable.** Only provisional entries change during
   streaming, and every provisional eventually seals or is finalized by pi.
3. **A Patch is the transaction boundary.** Every complete Patch leaves a
   domain-valid Document; seal moves and metadata changes are one transaction.
4. **Core and ViewModel are pure and browser-safe.** They have no filesystem,
   network, DOM, or Node runtime dependency.
5. **The pi event loop is serial.** The bridge observes event order and adds
   no competing turn lifecycle.
6. **A Manager serves exactly one Session.** An Activation is never rebound;
   Project/stem resolution and activation reservations enforce exclusivity.
7. **Lazy values exist only at the wire/cache boundary.** The canonical
   Document contains real values; null in a projection means not pulled.
8. **Cancellation finalizes.** Aborted turns produce durable or pending error
   outcomes instead of silently removing entries.
9. **The bridge observes pi's turn loop.** `prompt` uses steering semantics;
   pushes report effects and RPC replies do not carry Document state.
10. **Initial sync precedes live patches.** A valid cursor selects a delta;
    otherwise the server sends replace. The address-bearing frame establishes
    the active Session and cache identity.
11. **Reconnect replaces authority, then repulls.** No operation history is
    retained across a WebSocket; visible lazy values are requested again.
12. **The pull loop is the sole fetcher.** Components declare pending paths;
    no component calls the pull RPC directly.
13. **Filtered delivery converges.** Lazy filtering sanitizes parent values as
    well as leaf operations, so filtered replay matches a fresh projection.
14. **Wire frames have one owner.** BridgeClient and Connection construct the
    envelopes; feature code uses typed methods and push data.
15. **The URL selects navigation.** The client does not maintain a competing
    session navigation state machine; initial sync commits the resolved
    Project/stem address.
16. **The cache is disposable derived state.** Server validation and
    authoritative initial sync determine correctness, not IndexedDB contents.

## 8. Test design

Tests preserve the same boundaries used in production.

- Pure unit tests exercise `applyEvent`, `reconcile`, patch application,
  immutable mirror updates, lazy filtering, compact transport, cursor/cache
  policy, git-stamp parsing, and ViewModel/tree projection with hand-built
  inputs.
- Raw-object integration tests subscribe to Manager patch callbacks and use
  Connection/Daemon seams without requiring a real network. Initial-sync tests
  assert cursor validation, SessionRef pairing, subscription reset, and
  ordering before RPC replies.
- Fixture-resumed integration tests use the production `createManager` path
  with injected memory services and a faux provider. They drive full turns,
  parallel tools, aborts, silent entries, navigation, Project activation,
  and collection. This catches event ordering and seal interleavings that
  isolated reducers cannot.
- Web store, route, candidate-mirror, pull-loop, and cache tests remain
  browser-independent where possible. The web TypeScript gate and the curated
  browser-smoke bundle protect the core/ViewModel boundary.

The important test oracle is convergence: a mirror seeded from cache and
advanced by a valid initial-sync patch must equal the server's full initial
projection after lazy values are pulled. The same Document behavior is checked
through direct callbacks, the wire protocol, and the browser store.

## 9. Documentation map

Read the documentation in this order: [glossary](glossary.md), this overview,
[core data model](core/data-model.md), [host runtime](host/runtime.md), and
[web architecture](web/architecture.md), then the [active ADRs](adr/0008-object-kernel.md)
and [activation lifetime](adr/0012-activation-lifetime.md).

The tree has two tiers. Permanent docs outside `docs/adr/` state current
mechanisms and invariants and are refreshed in place. ADRs in `docs/adr/` are
change records moving through Proposed, Accepted, and Implemented states;
once merged, their current-truth content is folded into the permanent docs
and the file is deleted — git history is the decision record.
An ADR is a historical citation, never the owner of current behavior.

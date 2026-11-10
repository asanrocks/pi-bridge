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

Separately from runtime retention, every Session carries a durable,
user-visible **location**: Inbox (the attention list), Later (parked by
decision), or Archive (the default — browsable history). The first two are
persisted by the Worker at `<sessionDir>/.pi-bridge/locations.json`, keyed by
the session's stem — its address, so the queue's membership is the store's key
set — while Archive is the absence of a record. Sending a message places a
Session in Inbox (and a refused preflight restores the placement it replaced);
a user move decides the rest. The Inbox and Later Sessions are the queue: it
survives idle collection and daemon restarts, and browsing a Session never
changes its location.

*Running* is a runtime attribute, not a location: it is reported when an
Activation is streaming, running a tool, or compacting, and it is never stored
— so a restart has no execution state to recover, and a settlement writes
nothing. Runtime retention — whether an Activation exists, whether it is
streaming — is execution detail that stays in the Document and never appears
in a listing row as durable state.

The daemon enforces the important ownership rules at its boundaries:

- Project ids and stems are validated before filesystem resolution.
- Existing and intermediate symlinks must remain inside the Project's Session
  namespace.
- One address has at most one live Activation, including while creation or
  collection is in flight.
- A durable `sessionId` cannot be claimed by two Project/stem addresses.

The browser navigates by URL:

```text
/                              launcher and the global queue
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
Connection: one WebSocket, attachment, RPC demux
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
reconciliation, mirror operations, lazy-path filtering, and
cache/sync policy. The ViewModel is also pure and maps the active Document
branch into turns, actions, git observations, sibling navigation, and pull
requests. Neither layer knows about WebSockets, the DOM, or the filesystem.

**Host.** The Manager subscribes to pi, applies live events, and installs
persisted entries from pi's entry list through one refresh boundary; it sends
patches to its listeners. A Connection owns one WebSocket, one attachment, and
the RPC demux; it sends initial sync before later live patches and stamps every
observation frame with the attachment generation. Lazy demand and the filtering
it implies belong to the observation (the Worker), so a Connection holds no
subscription set: `pull` reads through its observation, which also decides
which later patches that stream receives. The Daemon owns Connection
registration, the browser attachment stream, delivery, HTTP serving, and two
daemon-global credential services (dictation, text polish). Everything that
executes — Projects, Session storage, the Activation registry, Manager
creation, pi runtimes, the model catalogue, settings, and the repository read
surface — belongs to the Worker behind one seam
(`src/host/worker-contract.ts`), with an authorization identity (incarnation +
generation) per registration. The contract is values and opaque ids only —
registration, Session target, observation, and frame identities — so the Worker
runs in-process, behind a Unix socket, or as a spawned child without the
Daemon branching on locality, and a command names the Activation it was
composed for.

`src/host/worker-host.ts` is the deployment seam that produces a Worker, and
`src/host/worker-protocol.ts` is the only encoding of the contract. The
`hello` push is the registration handshake and the Daemon's only source of
Project configuration: acceptance is all-or-nothing, so a duplicate id or a
collision with a reserved asset root closes the link instead of routing a
partially claimed set. Project names are claimed by the Daemon from what a
Worker advertises; a Worker never needs to know the serving surface's
namespace. A Daemon may register several Workers; the join of the
accepted registrations is its routing table, a Project id is served by exactly
one of them, and a conflicting registration fails startup rather than splitting
an address between two execution owners. A lost link withdraws only that
registration's Projects; it does not kill the Worker's runtimes or disturb the
others. Because a registration cannot outlive execution, exclusion is a
Session-directory claim (`src/host/storage-lock.ts`) held by the Worker itself,
reclaimed only under a single-winner guard, and a Worker that cannot claim its
directory refuses to serve rather than writing JSONL unsynchronized.

**Web.** `BridgeClient` is the only browser-side wire envelope owner. Its
DocumentMirror applies `replace` and `patch` pushes with immutable structural
sharing. The web store holds the current Document root, the current
Project/stem address, Project metadata, the queue, draft and
UI state. The route-driven connection layer seeds an optional cache mirror,
opens the URL address, promotes the target after an address-bearing initial
sync, and reissues visible lazy pulls.

## 4. Data model

The canonical value is:

```text
Document {
  status: Status
  entries: Record<id, Entry>
}
```

`status` contains the selected leaf, Session name, model identity, thinking
level, streaming and compaction flags, token/cost statistics, context usage,
and pending steer messages. `entries` contains the complete wire-safe union:
messages, tool results, user bash executions, compaction and branch summaries,
model and thinking-level changes, labels, Session info, and custom entries.
Sealed entries are immutable. During a turn, the live form of the item in
flight sits beside them under the id pi reserved for it, marked
`isSealed: false`.

Two inputs meet in the document:

- `applyEvent(document, event)` is the live half: it opens the in-flight form,
  updates status, appends streamed strings, and applies streamed end values.
  It never writes an entry that already sealed.
- The entry projection (`createEntryProjection`) is the authoritative half,
  and the only entry lifecycle: `refresh` installs each appended suffix entry
  under its own id — content, parent, timestamp, `isSealed: true`, and `ord` —
  including entries no event announced, and `settle` removes live forms that
  never persisted at a settle boundary.

Sealing is a replacement under an unchanged id, never a rename. Cancellation
finalizes assistant and tool-result entries as aborted or error entries; it
does not remove a persisted partial entry.

`ord` is the zero-based position in the complete persisted Session entry list.
It is sync and cache metadata, not render order, and it is assigned together
with `isSealed: true`; a live form has neither.

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

- `replace` carries a `SessionRef`, a complete wire-projected Document, and
  the attachment `generation` (ADR 19) that produced it.
- `patch` carries ordered Patch operations and the attachment `generation`.
  Only a cursor-aware initial-sync patch carries a `SessionRef`; live patches
  do not. An address-bearing frame establishes the client mirror's
  generation, and a live frame from an older attachment is dropped before
  the mirror — same address or not.
- `queue_changed` carries the queue: a `snapshot` first (every Inbox and Later
  Session, ordered Inbox → Later, each group by placement stamp descending), then
  `delta` frames of complete changed rows, removed addresses, and the Projects
  whose cached history a publication invalidated. Membership is the stored
  location, never runtime retention — an archived Session never appears, and
  idle collection never removes a row.
- `session_settled` names one execution ending, with how it ended
  (`completed`, `aborted`, or `error`) — the execution, never a pi turn
  boundary, and reported even when the reader caused the stop. It is an
  occurrence, delivered immediately, because the queue itself is published at
  most once every five seconds for execution state — a user's own placement
  publishes at a short floor instead (ADR 24). What to announce is the
  client's policy.

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
the missing persisted suffix, current live forms, full status, and
scoped models. An absent or invalid cursor produces one address-bearing
replace. Either form repairs the mirror's authority; a replace also repairs
the Session's cache records and removes stale suffixes.

A client may seed a candidate mirror while opening another address, but the
current mirror is promoted only when the initial-sync frame names the target
`SessionRef`. A failed open leaves the current mirror and route intact. Cache
absence, corruption, or a stale cursor changes performance only: the server
falls back to replace.

### Lazy pulls

The web ViewModel declares pending lazy paths while rendering. One pull-loop
drainer deduplicates them against the mirror and in-flight requests, sends one
batch, and ingests the values. Pulling an unsealed field also makes that path
the observation's live demand; pulling a committed field is one-shot. The
Worker filters live patches per observation demand and sanitizes lazy fields
embedded inside parent add/replace values, so filtered replay and fresh wire
initialization converge. The wire carries transport compaction on the live
path (`core/compact-codec.ts`): a run of patches that differs only in the
appended string sends that string alone, and the decoded frame is the
identical envelope — attachment generation included — so ownership on the
wire (ADR 19) is preserved rather than skipped.

## 6. State machines

### Document lifecycle

```text
bootstrap --initFromEntries--> idle
idle --live pi event--> streaming
streaming --turn_end / agent_settled--> sealing
sealing --refresh and seal--> idle
idle --idle Session verb--> idle
```

The event loop is serial. `applyEvent`, `refresh`, and `settle` are
synchronous pure projections; the host applies each resulting Patch before
dispatching the next one. `renameSession`, `compact`, and the model/level
carries a prompt brings refresh immediately when idle. `navigate` goes through
the same refresh boundary, so the leaf, the branch statistics, and the recovery
kind describe the selected branch.

### Connection and Activation lifecycle

```text
Connection: connecting -> connected
            connected --socket drop--> reconnecting -> unreachable
            connected --init failure--> init_failed

Attachment: detached --openSession/newSession--> attached(Project, stem)
            attached --openSession(other address)--> attached(other address)
            attached --detach--> detached
```

Connection recovery refreshes daemon metadata and the queue, reads the
current URL, optionally seeds the address from IndexedDB, and resolves the
address again. An Activation may continue a turn after its last Connection
detaches. Collection happens only after the host's attachment, streaming, and
compaction conditions are checked; collection never deletes the Session file.

## 7. Invariants

These are the load-bearing rules for changes across layers:

1. **The Manager owns the canonical Document.** No other path writes that
   canonical root; pi is the durable backing store.
2. **Sealed entries are immutable.** Only live forms change during streaming,
   and every live form either seals or is removed at a settle boundary.
3. **A Patch is the transaction boundary.** Every complete Patch leaves a
   domain-valid Document; a seal installs content and metadata in one
   transaction.
4. **Core and ViewModel are pure and browser-safe.** They have no filesystem,
   network, DOM, or Node runtime dependency.
5. **The pi event loop is serial.** The bridge observes event order and adds
   no competing turn lifecycle.
6. **A Manager serves exactly one Session.** An Activation is never rebound;
   Project/stem resolution and activation reservations enforce exclusivity.
   A Connection reaches a Session only through a target-bound command surface,
   and the Session actor owns the work admitted against that registration:
   mutations serialize in admission order, turns/aborts/reads run immediately
   but tracked, and its terminal `close` is the one disposal path —
   collection and shutdown both go through it.
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
    well as leaf operations, so filtered replay matches a fresh projection. The
    filter is the observation's: its demand is the only subscription set, and an
    initial sync clears it.
14. **Wire frames have one owner.** BridgeClient and Connection construct the
    envelopes; feature code uses typed methods and push data. Every
    observation frame carries the attachment generation that produced it —
    ownership on the wire is mandatory, and a frame from another attachment
    is dropped before the mirror and the view see it (ADR 19).
15. **The URL selects navigation.** The navigation reactor is the single
    owner of browser Session selection: it stages, commits on the
    address-bearing initial sync, and rolls back or falls back per
    transition; no other module writes the current address, the session id,
    the navigation route, or the candidate mirror. Every read and write of
    published state goes through the view port
    (`web/src/infra/net/viewPort.ts`) — the typed seam that is the actor's
    complete input/output surface — so the store, the route, and the address
    index are one adapter's mechanics (ADR 19).
16. **The cache is disposable derived state.** Server validation and
    authoritative initial sync determine correctness, not IndexedDB contents.
17. **Async work is admitted by a named owner.** Every asynchronous
    transition belongs to a LifecycleScope, a reactor, or the Session actor;
    a superseded or terminal owner ignores late completions instead of each
    call site re-checking "is this still current?", admits no new externally
    visible work once superseded (a stale completion is dropped, and a not-
    yet-sent command is never sent), and every owner drains
    before its terminal state resolves. The owner inventory below is the
    checkable form: a new asynchronous site names its owner in the same
    table, and an owner with no terminal operation is a defect, not a style
    choice.

### Async owner inventory

Each asynchronous site names the owner that admits it; each owner names its
terminal operation and its supersede rule. Effects inside a reactor are
value-only (a step may read and write anything; an effect may only observe
and return a message), so unordered writes are unrepresentable rather than
guarded against.

| Owner | Admits | Supersede rule | Terminal |
| --- | --- | --- | --- |
| Reactor (`core/reactor.ts`) | Navigation transitions, alias resolution, creation transitions | Admission is gated by intent ownership: a superseded transition sends nothing and settles its caller; a completion carries the admitting message's epoch and the step compares; a creation's initial sync carries its operation id and commits only while its creation is the newest intent | `close()` — drains messages, effects, completions |
| Session actor (`host/session-actor.ts`) | Session commands, observations, and the idle-collection decision against one registration | Commands capture the target; admission rejects once `close` began; a live capability is an attached observation and cancels idle collection | `close()` — disposes the runtime exactly once, drains tracked work, releases every observation |
| `LifecycleScope` (Connection transitions) | `openSession`/`newSession`/`detach` per socket | Arrival order; a disposed Connection refuses admission | `dispose()` — the awaited drain |
| `LifecycleScope` (settings mutations) | Worker-global `enabledModels` writes | Arrival order | Worker `dispose()` awaits `close()` |
| Worker client (`host/worker-client.ts`) | Requests, observation frames, and Worker events over one socket | A link that misses its heartbeat deadline is lost; a late reply finds no pending entry and is dropped; `unavailable` and a socket failure take the same terminal path, settling pending requests and ending observations with a `closed` frame | `dispose()` — shutdown request, heartbeat stopped, pending requests rejected, observations ended |
| Worker server (`host/worker-server.ts`) | One connection's observation table, its acquisitions, and its admitted dispatch | Admission closes synchronously at `shutdown`/withdrawal; an acquisition whose socket closed releases what it produced instead of installing it | `shutdown`/socket close — admitted work drained, observations released, event subscription removed |
| Storage lock (`host/storage-lock.ts`) | Session-directory exclusion for one Worker lifetime | Reclaimed only when a same-host owner is provably dead; a foreign-host claim is never reclaimed | `release()` — holder-only delete; the Worker releases it after disposing every runtime |
| `LifecycleScope` (git-stamp observations) | Serialized stamp observations per bind | Observation order | `GitStampExtensionBundle.end()` — called by `Manager.dispose()` *before* the runtime is disposed, so every drained observation appends to a live runtime |
| ActivationRegistry | Creation reservations, the address and durable-session-id indexes, and the collection choreography | Address-keyed reservations; the actor's phase is terminal per registration | `collect()`/`dispose()` — joinable: a second caller awaits the in-flight disposal / the memoized drain |
| Manager teardown | Runtime disposal, observation-scope drain | — | `dispose()` — idempotent and joinable; the observation scope drains before the runtime goes |
| Connection pipeline | Push ingestion, cache write-through, coalescing | `disposed` freezes writes; deltas gate on the committed session id | `cleanup()` — pending ops dropped, in-flight cache writes gated |
| Pull loop | Lazy-value pulls | Reply admitted only for unchanged seal state and unfetched fields | `cancelPullRetry()` at teardown; reconnect replaces the client |
| Worker service (`host/worker-contract.ts`) | Observations and target-addressed commands across the Daemon → Worker boundary | Address-keyed reservations; a command names its target's activation and is refused once it ended; an observation is released independently | `dispose()` — stop admission, drain observations and admitted work, dispose every runtime |

## 8. Test design

Tests preserve the same boundaries used in production.

- Pure unit tests exercise `applyEvent`, the entry projection, patch application,
  immutable mirror updates, lazy filtering, cursor/cache
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
- The cross-layer lifecycle trace (`test/suite/lifecycle-trace.test.ts`)
  drives the whole stack at once: the real Daemon over faux-provider
  Managers, a real `BridgeClient` on a real WebSocket, the real connection
  pipeline (with an injected flush scheduler), and the real navigation
  actor. Its scenarios — attach/stream/seal, a switch leaving a session
  streaming headless, close-across-navigation, reconnect through the cache
  cursor, and daemon shutdown mid-turn — assert the invariants that must
  hold across every interleaving: the mirror projects the canonical
  Document, a left-behind stream never repaints the successor, a dead
  observation delivers nothing, a close reply implies the runtime was
  disposed exactly once, and a shutdown drain settles streaming sessions
  before it resolves.

The important test oracle is convergence: a mirror seeded from cache and
advanced by a valid initial-sync patch must equal the server's full initial
projection after lazy values are pulled. The same Document behavior is checked
through direct callbacks, the wire protocol, and the browser store.

## 9. Scope and limitations

The daemon starts pi runtimes; it does not attach to an already-running pi
process by tailing its JSONL. It serves localhost; remote access uses SSH
forwarding or a tunnel, with no bridge authentication layer.

Steering is single-writer. There is no collaborative conflict resolution.
The wire has no schema version or patch sequence number: WebSocket ordering
and authoritative initial sync govern delivery, with a cursor delta or replace
on reconnect. The browser-smoke gate checks the curated browser-safe exports;
there is no corresponding Node-only import gate.

Queue changes are broadcast across tabs through `queue_changed` (a snapshot,
then throttled deltas); archived history is invalidated per Project and
refetched by whichever tab displays it, so no page is pushed to a client that
is not looking at one. Static Project configuration has no project-list push. When a live runtime is closed out from under attached
clients (a move to Archive or Trash), they are detached and receive a
`session_closed` push naming the address, so a view never stalls waiting for
a runtime that no longer exists; idle collection has no attached Connection
to notify.
The transcript supports variant paging on user messages only.

## 10. Documentation map

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

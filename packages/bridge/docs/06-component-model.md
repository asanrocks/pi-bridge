# ADR 06: Component Model — Manager, Connection, Daemon

**Status:** Accepted. Replaces ADR 05.

## Context

[ADR 02](./02-data-model.md) and [ADR 03](./03-component-architecture.md)
define a Document-centric architecture: the host holds the canonical
Document, the daemon projects it onto WebSocket connections, and clients
sync via `Init`/`Patch`/`PullRequest`/`PullResponse`. At the time, only
`prompt` existed as a client command — everything the client did was either
request the Document snapshot or request lazy content.

[The PRD (04)](./04-prd-web-ui.md) adds verbs: `abort`, `discardSteer`, `renameSession`,
`navigate`, `switchSession`, `newSession`, `setModel`, `setThinkingLevel`,
`listSessions`, `getDaemonInfo`, `listFiles`, `listInstances`, `switchInstance`, `newInstance`, `killInstance`, and the content `pull` mechanism. They fall
into four natural categories:

- **Session verbs** — modify the pi conversation (`prompt`, `abort`, `discardSteer`,
  `setModel`, `setThinkingLevel`, `renameSession`, `navigate`,
  `switchSession`, `newSession`).
- **Daemon verbs** — query global state (`listSessions`, `getDaemonInfo`, `listFiles`, `listInstances`, `console`).
- **Routing verbs** — mutate the instance registry (`switchInstance`, `newInstance`, `killInstance`).
- **Connection verbs** — manage per-client transport state (`pull`).

The current architecture has no place for these categories. The `Daemon`
class is a monolith: it duplicates the host's pi-setup logic inline, owns
everything (runtime, document, bus, WS server, sockets), and dispatches
messages through an ad-hoc `switch` on `msg.kind`. There is no per-connection
abstraction — socket state is an anonymous `{ ws, subscriptions }` record.
The `createHost` factory exists only for tests; production never calls it.

ADR 05 attempted to solve this by collapsing the wire protocol into a
multiplexed RPC+push channel with a verb registry. That solved the wire
shapes but left the server-side components unresolved — it still assumed a
monolithic daemon with a verb registry, no connection abstraction, and no
clear home for per-verb logic.

This ADR replaces ADR 05 with a component model that separates concerns by
natural ownership, accommodates M:N session-to-client routing from day one,
and formalizes the existing test seam.

## The model

### Components

```
┌──────────────────────────────────────────────────────┐
│ Daemon (singleton)                                   │
│   Creates/destroys Managers and Connections           │
│   Routes Connections to Managers                      │
│   Daemon verbs: listSessions, getDaemonInfo,        │
│   listFiles, listInstances + routing verbs           │
│                                                      │
│   ┌──────────┐    ┌──────────┐                       │
│   │ Manager  │    │ Manager  │   ... M managers      │
│   │ pi inst. │    │ pi inst. │                       │
│   │ document │    │ document │                       │
│   │ callbacks│    │ callbacks│                       │
│   └────┬─────┘    └────┬─────┘                       │
│        │patches        │patches                       │
│   ┌────┴──────┐   ┌────┴──────┐                      │
│   │Connection │   │Connection │   ... N connections  │
│   │WS         │   │WS         │                      │
│   │subs       │   │subs       │                      │
│   └───────────┘   └───────────┘                      │
└──────────────────────────────────────────────────────┘
```

**Core** — pure, browser-safe. Types, `applyEvent`, `reconcile`,
`applyPatch`, `DocumentMirror`, `filterPatchForSocket`, `projectSnapshot`.
No knowledge of pi, sockets, or Node. Unchanged from ADR 02/03.

**Manager** — owns one pi runtime (`AgentSessionRuntime`) and one canonical
Document. 1:1 with a session file on disk. Handles session-level RPC verbs.
Pushes patches and replace snapshots directly to attached Connections via
callbacks. Testable in isolation with injected fake services.

**Connection** — owns one WebSocket. Attached to one Manager. Demuxes
incoming wire frames and routes them: session verbs → Manager, daemon
verbs → Daemon, connection-local verbs → self. Receives patches from its
Manager, filters against per-connection subscriptions, and sends to the
client. Owns `pull` (reads Manager's document, mutates own subscription
set). Owns the RPC demux — the Connection is the only place that inspects
`id` on incoming frames.

**Daemon** — singleton. Owns a list of Managers (`Map<instanceId, Manager>`) and Connections. Handles
daemon-level verbs (`listSessions`, `getDaemonInfo`, `listFiles`, `listInstances`) and routing verbs (`switchInstance`, `newInstance`, `killInstance`). Routes Connections
to Managers. The Daemon holds no `Map<sessionId, Manager>` — it scans the Manager list for routing.

### Boundaries

```
pi ──events──► Manager ──onPatch/onReplace──► Connection ──wire──► web
                  ▲                    │
                  │session verbs       │pull (self-handled)
                  │                    │
                  ├────────────────────┘
                  │
                  │ (daemon verbs bypass Manager)
                  │
               Daemon ◄── Connection
```

- **pi → Manager**: `session.subscribe(AgentSessionEvent)`. Events are
  serial, in-order. The Manager calls `core.applyEvent`/`reconcile`,
  mutates the Document, invokes `onPatch`/`onReplace` callbacks.
- **Manager → Connection**: each Connection registers via
  `manager.addConnection(conn)`. The Manager pushes unfiltered Document
  changes to all attached Connections. Each Connection applies
  `filterPatchForSocket` against its own subscription set before sending
  to its client. `addConnection` triggers an immediate `replace` push to
  the new Connection (the current Document snapshot).
- **Connection → Manager**: typed method calls. The Connection demuxes the
  wire frame (checks for `id`), calls the Manager method, awaits the
  result, and sends the RPC reply on its own WebSocket. The Manager never
  sees `id` values or WebSockets.
- **Connection → Daemon**: `listSessions`, `getDaemonInfo`, `listFiles`, `listInstances`, plus routing verbs `switchInstance`/`newInstance`/`killInstance`. These bypass
  the Manager — they are global queries/mutations.
- **Connection → self**: `pull`. Reads `manager.document`, mutates own
  subscriptions, sends reply. The Manager is not involved.

### Ownership

| Component | Owns | Lifetime |
|---|---|---|
| Core | types, pure functions | static |
| Manager | `AgentSessionRuntime`, canonical Document, pi event subscription, `onPatch`/`onReplace` listener set | created by Daemon; disposed on shutdown |
| Connection | WebSocket, subscription set, RPC demux, `pull` handler | created by Daemon on WS connect; destroyed on disconnect |
| Daemon | Manager list, Connection list, session directory, model registry | process lifetime |

The Manager's lifetime is process-scoped in v1. Session switching
(`switchSession`/`newSession`) is handled internally by
`AgentSessionRuntime` — the Manager object stays alive, its internal
runtime and Document are replaced. The `AgentSessionRuntime` already
supports `switchSession(path)`, `newSession()`, and `fork(entryId)` through
its `createRuntime` factory + `rebindSession` callback mechanism.

### `Document.status` additions

`Document.status` gains a `name` field (session name):

```ts
interface Status {
  leafId: string | null;
  name: string;           // NEW — from latest SessionInfoEntry
  model: ModelRef{provider, modelId}; // disambiguates same-id models across providers
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  stats: Stats;
  contextUsage: ContextUsage | null;
  pendingSteer: string[]; // wire-eager steer queue
}
// Document also carries scopedModels: ScopedModelInfo[] (curated --models list)
```

`name` is bootstrapped from the latest `SessionInfoEntry` in
`initFromEntries` and updated by `renameSession` via `reconcile`. This
mirrors how `model` and `thinkingLevel` are derived from their respective
silent entries and kept in status for rendering convenience.

## Wire protocol: dual channel

The wire is **one WebSocket carrying two sub-channels**. The framing rule:
a frame with an `id` is an RPC (client→server call with server→client
reply); a frame without an `id` is a push notification (server→client,
unsolicited).

### Push (server → client, no `id`)

Two kinds:

| Kind | Payload | When |
|---|---|---|
| `replace` | `{ document: Document }` | Re-attachment (`switchInstance`), `switchSession`, `newSession` (fresh Connection has `attachedManager = null` — no auto-push on connect) |
| `patch` | `{ ops: PatchOp[] }` | Each `applyEvent`/`reconcile` emission from Manager |
| `sessions_changed` | `{ sessions, hasMore }` | Daemon push on `agent_settled`/`renameSession`/`switchSession`/`newSession` (other tabs refresh Instances via polling) |
| `instance_exit` | `{ instanceId }` | Only to Connections attached to the killed Manager (last frame) |

`replace` is always auto-pushed — the server sends it, the client replaces
its DocumentMirror wholesale. There is no client→server `Init` message
(removed from ADR 02). `replace` unifies three triggers: new connection,
reconnect (close + reopen), and session-switch.

#### Compact wire form (streaming-append compaction)

During streaming, the diff engine emits one single-op `append` patch per
token, all targeting the same path (e.g. `.../content/0/thinking`). The
`{"kind":"patch","ops":[{"op":"append","path":"...","value":"x"}]}` envelope
is ~100 bytes to deliver a ~7-byte token. The WS transport carries a
stateful `CompactCodec` (`src/core/document.ts`) that compacts this case to
a bare JSON string on the wire:

- **Discriminator.** `JSON.parse(data)` is either a `string` (compact) or an
  `object` (every other frame — `replace`, `patch`, `sessions_changed`,
  `instance_exit`, RPC reply). RPC replies always carry `id`, so they never
  collide.
- **Encoder** (`Connection.send`): if the frame is a single-op `append` to
  the *remembered* path, emit `JSON.stringify(value)` (bare string). If it's
  a single-op `append` to a *new* path, emit the full frame and remember the
  path (prime). Anything else emits the full frame and clears the remembered
  path.
- **Decoder** (`BridgeClient`'s `onMessage`): a bare string restores
  `{op:"append", path: rememberedPath, value: <string>}` and is applied via
  the normal `mirror.applyPatch` + `onPush` path — upper layers see a full
  `PatchMessage`, never a bare string.
- **Invariants.** The remembered path is cleared by every frame that isn't a
  single-op `append` to the same path: multi-op patches, non-append ops
  (notably `move`, which relocates a path), `replace` snapshots, out-of-band
  pushes, and RPC replies. The encoder always primes before compacting, so a
  compact frame only arrives when the decoder's remembered path is already
  set (WS reliable-ordered; reconnect uses `replace`, which resets state on
  both sides). `append` values are always strings, so the bare-string form is
  unambiguous vs. the object form.

The compaction is transparent above the transport: the diff engine, the
mirror, and `onPush` keep emitting/consuming full `{kind:"patch",ops}`
frames. A new push `kind` must remain an object (never a bare string) and
must clear the codec's remembered path to avoid desync.

### RPC (client → server, with reply)

Every RPC frame has an `id` (opaque string, client-chosen) and a `verb`
(string). The server replies with a frame carrying the same `id` plus an
outcome. The reply never carries Document state — Document changes arrive
exclusively via push.

```
// Request
{ "id": "1", "verb": "prompt", "text": "Fix the buffer overflow" }

// Success reply
{ "id": "1", "ok": true }

// Error reply
{ "id": "1", "ok": false, "error": "bad model" }
```

| Verb | Handler | Reply carries |
|---|---|---|
| `prompt` | Manager | `{ ok, error? }` |
| `abort` | Manager | `{ ok, error? }` |
| `discardSteer` | Manager | `{ ok, error? }` |
| `setModel` | Manager | `{ ok, error? }` |
| `setThinkingLevel` | Manager | `{ ok, error? }` |
| `renameSession` | Manager | `{ ok, error? }` |
| `navigate` | Manager | `{ ok, error? }` |
| `switchSession` | Manager | `{ ok, error? }` |
| `newSession` | Manager | `{ ok, error? }` |
| `listSessions` | Daemon | `{ ok, sessions: SessionInfo[], hasMore? }` |
| `getDaemonInfo` | Daemon | `{ ok, models: ModelInfo[], thinkingLevels: string[], cwdAllowlist: string[], devMode: boolean }` |
| `listFiles` | Daemon | `{ ok, entries: { path, isDirectory }[] }` |
| `listInstances` | Daemon | `{ ok, instances: InstanceInfo[] }` |
| `switchInstance` | Daemon (routing) | `{ ok, error? }` |
| `newInstance` | Daemon (routing) | `{ ok, instanceId }` |
| `killInstance` | Daemon (routing) | `{ ok, error? }` |
| `pull` | Connection | `{ ok, values: { entryId, fieldPath, value }[] }` |
| `console` | Daemon | `{ ok }` (dev-mode) |

### `pull` as a Connection-local RPC

`pull` is an RPC whose reply carries the current lazy values. Its side
effect — registering the requested paths in the Connection's subscription
set — is internal to the Connection. The Manager is not involved.
Subscription GC is implicit: when the provisional entry commits, the id
disappears, and future patch filtering naturally drops ops on the old path
(unchanged from ADR 02 "Lazy-value contract").

### Wire surface collapse

| ADR 02 | ADR 06 |
|---|---|
| `Command` + `CommandAck` | RPC call + reply (with `id`) |
| `PullRequest` + `PullResponse` | RPC `pull` + reply |
| `Init` (client→server) | deleted — server auto-pushes `replace` |
| `Init` (server→client) | `replace` push |
| `sessionList` (hypothetical) | `listSessions` RPC reply |

## Verb contracts

### Manager verbs

Manager verbs modify pi state. Their effects are observed via push
(`replace` for `switchSession`/`newSession`; `patch` for all others).
The reply carries only the failure channel.

| Verb | Patch author | Failure contract | Notes |
|---|---|---|---|
| `prompt` | pi-event-driven (`applyEvent`) | async (pi rejects → reply `ok:false`) | reply = "accepted"; patches follow |
| `abort` | pi-event-driven | async — awaits `session.abort()` (waits for `agent_settled`) | patches arrive during abort cycle; reply after completion |
| `discardSteer` | `applyEvent` (`queue_update` → `pendingSteer`) | sync | clears steer queue |
| `setModel` | synchronous `reconcile` after call | sync throw (bad model → reply `ok:false`) | no event on `session.subscribe`; reconcile immediately |
| `setThinkingLevel` | hybrid: `applyEvent` handles `thinking_level_changed` (status); synchronous `reconcile` discovers silent entry | sync throw (bad level → reply `ok:false`) | status change via event; entry via immediate reconcile |
| `renameSession` | synchronous `reconcile` after `session.setSessionName(name)` | sync — append-only, unlikely to fail | `session_info_changed` carries name for `status.name`; entry via reconcile |
| `navigate` | synchronous set of `leafId` (`setAtPath`) | sync throw (invalid entry → reply `ok:false`) | sets leafId only; no `reconcile` (would reset to last committed) |
| `switchSession` | `runtime.switchSession(path)` → `rebindSession` → re-bootstrap + `replace` push | async (file not found → reply `ok:false`, no push) | Manager object persists; internal runtime + Document replaced |
| `newSession` | `runtime.newSession()` → `rebindSession` → re-bootstrap + `replace` push | async | same mechanism as `switchSession` with new empty file |

**Idle-state reconcile:** `setModel`, `setThinkingLevel`, `renameSession`,
and `navigate` produce silent entries that `reconcile` discovers.
`reconcile` normally only fires at `turn_end`/`agent_settled`. When these
verbs are called while idle (no turn in-flight), the Manager calls
`reconcile` immediately after the pi API returns. This ensures the silent
entries appear in the Document without waiting for the next turn.

**Error handling:**

- `setModel` and `setThinkingLevel` throw synchronously on invalid input
  (bad model, bad level). The Manager catches the throw and replies
  `ok:false`. No reconcile is needed.
- `renameSession` is append-only and unlikely to fail on disk.
- `navigate` throws synchronously on invalid entry id.
- `switchSession`/`newSession` are async; failures propagate through
  `runtime.switchSession()`/`runtime.newSession()` (e.g., file not found).

**`switchSession` / `newSession` via `AgentSessionRuntime`:**

`AgentSessionRuntime` already supports session replacement through
`switchSession(sessionPath)`, `newSession()`, and `fork(entryId)`. These
methods tear down the old `AgentSession` (disposing event listeners), create
a new runtime via the stored `createRuntime` factory, and call the
`rebindSession` callback with the new session.

The Manager sets `runtime.setRebindSession(async (newSession) => { ... })`
once at construction. The callback re-bootstraps the canonical Document from
`newSession.sessionManager.getEntries()`, subscribes to events on the new
session, and pushes `replace` to all attached Connections.

The Manager object persists across session switches — only its internal
runtime and Document are replaced. `switchSession` affects ALL Connections
attached to the Manager. In v1 (1 Manager, N Connections), switching the
session switches it for everyone. This is by design: the Manager is the
shared view; all tabs see the same document.

### Daemon verbs

Daemon verbs are queries (and `listFiles`); they produce no `replace`/`patch` push except via `sessions_changed` where noted.

| Verb | Reply | Staleness / Push |
|---|---|---|
| `listSessions` | `{ ok, sessions: SessionInfo[], hasMore? }` | Scanned at query time; `sessions_changed` pushed on settle/rename/switch/new |
| `getDaemonInfo` | `{ ok, models: ModelInfo[], thinkingLevels: string[], cwdAllowlist: string[], devMode: boolean }` | Daemon-static; client caches for socket lifetime |
| `listFiles` | `{ ok, entries: { path, isDirectory }[] }` | On-demand prefix match |
| `listInstances` | `{ ok, instances: InstanceInfo[] }` | Enriched from Managers; Launcher polls every 5s (no `instances_changed` push) |

`listSessions` returns rich session metadata: `{ id, name, timestamp,
firstMessageText?, messageCount? }`. Scanned from the session directory at
query time. The web client uses this for sidebar rendering.

`getDaemonInfo` returns what the web client needs to render pickers:
the model registry (all available models) and valid thinking levels
(ambient capabilities). Computed once at daemon startup. These are distinct
from `status.model` and `status.thinkingLevel` in the Document — those carry
the current selection, not the list of options.

## Client side: `BridgeClient`

A typed object wrapping the WebSocket. Lives in `core` (browser-safe;
transport is constructor-injected).

```
bridge.prompt("Fix the buffer overflow")        // → Promise<RpcReply>
bridge.abort()                                  // → Promise<RpcReply>
bridge.setModel("openai", "gpt-5")              // → Promise<RpcReply>
bridge.setThinkingLevel("high")                 // → Promise<RpcReply>
bridge.renameSession("fix-buf")                 // → Promise<RpcReply>
bridge.navigate(entryId)                        // → Promise<RpcReply>
bridge.switchSession(sessionId)                 // → Promise<RpcReply>
bridge.newSession()                             // → Promise<RpcReply>
bridge.listSessions()                           // → Promise<{ sessions: SessionInfo[] }>
bridge.getDaemonInfo()                          // → Promise<{ models, thinkingLevels }>
bridge.pull(requests)                            // → Promise<PullReply> (batched {entryId, fieldPath}[])
bridge.listFiles(prefix)                       // → Promise<ListFilesReply>
bridge.listInstances()                         // → Promise<ListInstancesReply>
bridge.switchInstance(id)                      // → Promise<RpcReply>
bridge.newInstance(cwd)                        // → Promise<NewInstanceReply>
bridge.killInstance(id)                        // → Promise<RpcReply>

bridge.mirror                                  // → DocumentMirror (read-only)
```

`BridgeClient` owns two internal objects:
- `DocumentMirror` — receives push frames (`replace`, `patch`) and
  maintains the client-side Document. Unchanged from ADR 02/03.
- Pending-RPC map (`Map<id, {resolve, reject}>`) — correlates reply frames
  to outstanding promises. Rejected on disconnect only (no timeout). The
  client re-issues requests after reconnect.

Demux: on each received frame, check `id`. Present → resolve/reject a
pending RPC promise. Absent → `replace` or `patch` → dispatch to
`DocumentMirror`.

No `web` code constructs wire frames by hand. The `BridgeClient` is the
only place that touches the envelope.

`BridgeClient` is tested with a single test file covering demux and RPC
correlation (reply with matching `id` resolves, mismatched `id` is ignored,
reconnect rejects all pending). Typed verb methods are thin wrappers that
don't need per-verb tests.

## Manager callbacks

The Manager exposes four listener hooks — all are the state channel to Connections
and the test seam:

```ts
interface Manager {
  document: Document;
  readonly liveSessionId: string;
  readonly cwd: string;
  onPatch(listener: (patch: Patch) => void): () => void;
  onReplace(listener: (document: Document) => void): () => void;
  onExit(listener: () => void): () => void;
  onSettled(listener: () => void): () => void;
  addConnection(onPatch, onReplace, onExit): void;
  removeConnection(onPatch, onReplace, onExit): void;
  // ... typed verb methods
}
```

- **`onPatch`** — called for each `applyEvent`/`reconcile` emission. The
  listener receives an unfiltered `Patch`. Connections subscribe to filter
  against their own subscription sets.
- **`onReplace`** — called on bootstrap and after `switchSession`/
  `newSession` (via `rebindSession`). The listener receives the full canonical Document (lazy
  fields populated — Connections call `projectSnapshot` before sending).
- **`onExit`** — called during `manager.dispose()` after abort-save, before
  `runtime.dispose()`; Connections send `instance_exit` and detach.
- **`onSettled`** — called on `turn_end`/`agent_settled`; Connections push `sessions_changed` (first turn after `newSession` flushes the session file).
- **`addConnection`** / **`removeConnection`** — attach/detach a Connection's three callbacks.
  `addConnection` triggers an immediate `onReplace` push to the new
  Connection only.

These callbacks replace the `BridgeBus` from ADR 02/03. The bus class is
removed — it was an unnecessary wrapper around a listener array. The
callbacks are the test seam: tests register `onPatch` and `onReplace`
listeners to observe Document changes.

## Test seam

Tests create a Manager with injected fake services, subscribe to the
callbacks, drive turns via Manager methods, and assert on client-observable
state through a `DocumentMirror`.

```
test → createManager(fake deps)
         ├── manager.onPatch(capture)
         ├── manager.onReplace(capture)
         ├── manager.prompt(text)
         └── manager.document
```

The Daemon, Connection, and WebSocket are never involved in tests.
The `createManager` factory (renamed from `createHost`) accepts the same
injections as today plus an optional `sessionPath` for targeting a specific
session file (needed in v2 `switchInstance` routing):

```ts
interface CreateManagerOptions {
  cwd?: string;
  agentDir?: string;
  sessionPath?: string;  // for v2 switchInstance routing; defaults to continue-recent
  modelRuntime?: ModelRuntime;
  settingsManager?: SettingsManager;
  sessionManager?: SessionManager;
  model?: Model<string>;
  customTools?: ToolDefinition[];
}
```

`modelRuntime` (`ModelRuntime.create({ authPath })`) replaces the old `AuthStorage` + `ModelRegistry` pair; `ModelInfo` now carries `providerName`/`supportedThinkingLevels`/`contextWindow` via `getSupportedThinkingLevels`.

## v2: M:N routing

v1 is 1 Manager, N Connections — all tabs watch the same session. The
component model accommodates M:N from day one without redesign:

- The Daemon holds a list of Managers. No `Map<sessionId, Manager>`.
- Each Connection has an `attachedManager` reference.
- Routing verbs `switchInstance(instanceId)` / `newInstance(cwd)` / `killInstance(instanceId)` move a Connection between Managers (or create/dispose them) without affecting other Connections. The Daemon:
  1. Scans the Manager list for the target instance (O(N), fine for a handful).
  2. Calls `oldManager.removeConnection(conn)` / `newManager.addConnection(conn)` — triggers `replace` push.
  3. If no Manager exists for the target, `createManager({ sessionPath/cwd })` creates one.
- `switchSession` inside a Manager still changes the session for all Connections attached to that Manager — it's a document-level operation, not a routing operation.

`switchInstance` decouples routing from session lifecycle (`switchSession` remains the in-Manager session switch).

### ADR 07-driven additions (v1)

[ADR 07](./07-adr-client-architecture.md) §Protocol changes defines these small additive wire changes. Recorded here as cross-reference:

- **`sessions_changed` push** — the daemon now pushes `{ sessions, hasMore }` on `agent_settled`/`renameSession`/`switchSession`/`newSession` (cross-tab Sessions sync). `instances_changed` remains polling.
- **Provisional `parentId`** set to `doc.status.leafId` at creation in `applyEvent` (`message_start` (assistant), `tool_execution_start`). Not a wire change; core producer change keeping the tree well-formed during streaming.

## What changed (implemented)

### Code

- **`createHost` → `createManager`.** Renamed `src/host/host.ts` →
  `src/host/manager.ts`. Returns a `Manager` with typed methods for all
  session verbs, `onPatch`/`onReplace` callbacks, and `addConnection`.

- **`BridgeBus` removed.** Deleted `src/core/bus.ts`. Replaced by
  `onPatch`/`onReplace` callbacks on the Manager. The callback interface
  is the test seam.

- **`Daemon` rewritten.** Uses `createManager` instead of inline pi setup.
  Creates shared `ModelRuntime` (`ModelRuntime.create({ authPath })`), injects it into
  Managers, and uses `runtime.getAvailableSnapshot()` + `getSupportedThinkingLevels` for `getDaemonInfo`. Sessions are mtime-cached per-file via `scanSessions()` (live sessions excluded, `InstanceInfo` enriched from each Manager's `Document`).

- **`Connection` class.** New `src/host/connection.ts`. Owns WebSocket,
  subscription set, `pull` handler, patch filter+send loop, RPC frame
  demux. Routes by `verb`: session → Manager, daemon → Daemon, `pull` →
  self. Sends RPC reply on its own WebSocket.

- **Wire protocol:** `ServerMessage`/`ClientMessage` replaced by dual
  channel: push (`replace` + `patch`, no `id`) + RPC (call + reply, with
  `id`). `Command`/`CommandAck`/`PullRequest`/`PullResponse`/`Init` removed.
- **Compact wire form.** `CompactCodec` (`src/core/document.ts`) compacts
  consecutive single-op `append` patches to the same path into bare JSON
  strings on the wire. `Connection.send` encodes; `BridgeClient`'s
  `onMessage` decodes and restores the append op before the mirror sees it.
  See the §Push subsection above for the contract. `computeObjectDiff`
  (`src/core/document.ts`) also recurses into arrays element-wise now (was
  atomic `replace`), so streamed array arguments like `edits[].newText` emit
  granular `add`/`append` on element sub-paths instead of re-sending the
  whole array per token.

- **`core/client.ts`:** `applyInit` → `applyReplace`. New `BridgeClient`
  class: transport-injected, pending-RPC map, typed verb methods, demux.

- **`Document.status` gains `name`.** Derived from `SessionInfoEntry` at
  bootstrap, updated by `session_info_changed` event.

- **`web`:** `App.tsx` uses `BridgeClient` via `WsTransport` adapter. No
  web code constructs wire frames by hand.

- **`navigate` sets leafId directly** (reconcile resets it to last committed
  entry, which is wrong for branch positions).

### Tests

23 files (see `architecture.md` §6 for the full split). Key additions since v1:

- `bridge-client.test.ts` — `BridgeClient` RPC demux, disconnect, push handling (mock transport).
- `compact-codec.test.ts` — `CompactCodec` streaming-append compaction.
- `manager-verbs.test.ts` — `setModel`, `setThinkingLevel`, `renameSession`, `navigate`, `abort`, idle-state reconcile.
- `connection-daemon.test.ts` — Connection RPC routing via in-process WS pair (prompt, daemon/routing verbs, pull, setModel, errors).
- `multi-instance.test.ts` — multi-instance routing (`switchInstance`/`newInstance`/`killInstance`, `instance_exit`).
- `tree-unit.test.ts` / `accounting.test.ts` / `composer-draft.test.ts` / `wants-outbox.test.ts` — viewmodel + store + pull orchestration.
- `navigation-e2e.test.ts` — Navigate + mirror sync, prompt-from-branch, multi-navigate, idempotency.

Existing files updated for `createHost` → `createManager` and `bus.subscribe` → `manager.onPatch`.

## Invariants (from ADR 02/03, extended)

1-10 from ADR 02/03. ADR 05's invariants 11-16 are replaced by:

11. **Manager verbs' effects are observed via push, not reply.** The reply
    carries only the failure channel. Document changes arrive as `patch`
    or `replace`. Replies never carry Document state.
12. **Fallible Manager verbs are reactive.** The Manager waits for pi's
    outcome before emitting a push. Synchronous-throw verbs (`setModel`,
    `setThinkingLevel`, `navigate`) reply `ok:false` immediately. No
    optimistic push that later needs compensation.
13. **`core` is pure.** `BridgeClient` is browser-safe (transport-injected).
    The RPC demux lives in Connection and `BridgeClient`; `core` sees
    only typed interfaces.
14. **The Manager callbacks are the test seam.** `onPatch`/`onReplace`/`onExit`/`onSettled`
    listeners provide the same observation interface to both Connections
    and tests.
15. **No code constructs wire frames by hand.** `BridgeClient` wraps the
    transport on the client; `Connection.demux` routes to typed handlers
    on the server.
16. **Idle-state verbs reconcile immediately.** `setModel`/`setThinkingLevel`/`renameSession`
    trigger an immediate `reconcile(opts)` when called while idle, ensuring silent entries
    appear without waiting for the next turn; `navigate` sets `leafId` directly (no reconcile).

## V2 Addendum: Multi-Manager routing (2026-07-21)

The daemon now supports N Managers (projects) instead of one, and a Connection
attaches to one Manager at a time. See the multi-instance PRD
(`docs/04-prd-web-ui.md`) for the user-facing motivation.

### New verb category: routing verbs

Alongside session verbs (Manager-owned), daemon-static query verbs (Daemon-owned,
no side effects), and connection-local `pull`, there is a fourth category:

- **Routing verbs** — Daemon-owned, side-effectful, per-Connection. They mutate
  the instance registry and call `Connection.attach`/`detach`/`Manager.dispose`.
  Never touch the WebSocket directly; pushes flow through Manager callbacks.

| Verb | Handler | Effect |
|---|---|---|
| `switchInstance(instanceId, conn)` | Daemon | Detach conn from old Manager, attach to target (replace push) |
| `newInstance(cwd, conn)` | Daemon | Spawn new Manager, attach conn (replace push) |
| `killInstance(instanceId, conn)` | Daemon | `manager.dispose()` → abort save → onExit (`instance_exit` push) → teardown |
| `listInstances()` | Daemon | Returns `InstanceInfo[]` (global, no per-connection state) |

### New Manager callback: `onExit`

Emitted during `manager.dispose()` *after* the in-flight turn is aborted/saved
(via `await session.abort()`) but *before* `runtime.dispose()`. The Connection's
`onExit` handler sends the `instance_exit` push (the last frame) and nulls its
own `attachedManager`/`attachedInstanceId`. This preserves the §7.5 rule
("Manager callbacks are the only state channel") — even Manager exit flows
through callbacks, never Daemon-direct-to-WebSocket.

### New push kind: `instance_exit`

A scoped push sent *only* to Connections attached to the dying Manager (not a
broadcast). The push-bar rule: a new push kind is justified only when the
client's observation target has disappeared and lazy discovery would leave it
rendering stale state. `instance_exit` is the sole lifecycle push; all other
lifecycle metadata (Projects list, sessions list) stays lazy (re-query on
focus/reconnect).

### Registry: flat `Map<instanceId, Manager>`

No tuple, no reverse index. The Daemon holds `Map<string, Manager>` with a
stable `instanceId` (uuid) assigned by the Daemon at Manager creation. Each
Manager exposes `cwd` (delegating to `runtime.cwd`) and has no `instanceId`
field — routing identity is owned by the Daemon, not the Manager. The
Manager's listener Sets (`exitListeners`, `patchListeners`, `replaceListeners`)
handle all fan-out; the Daemon never enumerates a Manager's Connections.

### `--allow` CLI flag

`--allow <dir>` (repeatable) adds an allowed instance cwd. `--cwd <dir>`
remains as a backward-compat shorthand (added to the union of entries).
At least one entry is required; the daemon refuses to start otherwise.

### Reconnect: client-driven re-attachment

A fresh Connection has `attachedManager = null` — nothing is pushed on
connect. The client fetches `listInstances` + `getDaemonInfo`; if its stored
`attachedInstanceId` is still alive, it sends `switchInstance` to re-attach
and get a `replace` push. One extra RPC round-trip vs. v1's immediate
`replace`. `liveSessionId` is removed from `GetDaemonInfoReply` (the per-
instance session id lives in `InstanceInfo.sessionId`).

### `manager.dispose()` ordering invariant

The kill path guarantees: `await session.abort()` (finalize + flush the
in-flight turn; listeners still attached → clients see final patches) →
emit `onExit` to exitListeners (Connections send `instance_exit` as the last
frame and self-detach callbacks) → unsubscribe from pi events →
`await runtime.dispose()`. Wire order on attached tabs: final patches
(`turn_end`/`agent_settled`) → `instance_exit` (not `manager_exit`). This satisfies the PRD's
"saves first, then tears down."

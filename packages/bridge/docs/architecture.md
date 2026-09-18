# pi-bridge architecture

The high-level overview. Read this first; the ADRs and `AGENTS.md` own the
detail. This document defines the architecture such that new features (a TUI
client, a binary transport, server-side auto-respond) slot into existing
categories without restructuring.

> **Navigation model is now ADR 11.** Where this document describes an
> `Instance` as the client-facing navigation/reconnect handle, read
> [ADR 11](./11-adr-projects.md) instead: the client-facing domain is
> `Project` + `Session`, addressed by `(projectId, stem)`; the runtime
> (`Instance`) is an internal, never-on-the-wire activation. The Document
> layer, sync model, and invariants below are unchanged.

## 1. System overview

### Logical model

pi-bridge presents agent session state as a **Document** — a single,
synchronized data structure that clients observe and steer through.

```
Document {
  status: { leafId, name, model: ModelRef{provider, modelId}, thinkingLevel, isStreaming, isCompacting, stats, contextUsage, pendingSteer }
  entries: Record<id, Entry>   // committed (immutable) + in-flight (provisional id)
  scopedModels: ScopedModelInfo[]
}
```

The Document is the **canonical session state machine**. pi provides durable
persistence; the bridge owns transient state (in-flight content, partial tool
calls, connection state). Clients sync to a Document, not a raw event stream.
Late-joiners and reconnecting clients receive a replace snapshot, not a
replay of history.

State changes flow as **Patch** batches (json-patch ops + one semantic op:
`append` for string concat during streaming). Each Patch is an atomic
transaction — after applying it, the Document is domain-valid. Multi-op
transitions (commit rename + metadata) are grouped into one Patch.

Two pure functions produce all Patches:

- **`applyEvent(doc, event) → Patch | null`** — consumes `AgentSessionEvent`s
  in real time. Delta-driven: content starts as a skeleton (`add`), grows via
  `append`, and finalizes via `replace` with the authoritative final value.
- **`reconcile(doc, piEntries, opts?) → Patch | null`** — called at seals
  (`turn_end`, `agent_settled`) and by idle-state verbs. Diffs pi's durable entries against the
  Document: renames provisional ids to pi ids, discovers silent entries
  (model changes, compactions — entries whose events don't carry their id),
  repairs status drift (`model`/`thinkingLevel`/`contextUsage`/`name` via `opts`, `stats` recomputed).

The Document transitions through four states:

```
bootstrap ──► idle ──► streaming ──► sealing ──► idle
initFromEntries   │     applyEvent    reconcile      │
                  │     (per event)   (at turn_end/  │
                  │                   agent_settled) │
                  └──────────────────────────────────┘
```

**Laziness is a wire projection, not a storage property.** The canonical
Document always holds real content. On the wire, content-bearing fields are
`null`. Clients pull what they need: pulling an in-flight entry opens a live
subscription (streams until commit); pulling a committed entry is one-shot.
The lazy fields: `ThinkingContent.thinking`,
`ToolCallBlock.arguments`, `ToolResultEntry.content`, `ToolResultEntry.details`.
Text fields are wire-eager (never null) per ADR 07.

### Physical model (ADR 06)

```
┌─────────────────────────────────────────────────────────┐
│ pi (durable storage + event loop)                       │
│   SessionManager ── getEntries()                        │
│   AgentSession ─── subscribe(AgentSessionEvent)         │
└──────┬────────────────────────────────────┬─────────────┘
       │ events                             │ durable state
       ▼                                    ▼
┌─────────────────────────────────────────────────────────┐
│ Manager (in-process)                                    │
│   canonical Document, applyEvent, reconcile             │
│   onPatch / onReplace callbacks  ◄── test seam          │
│   typed verbs: prompt, abort, setModel, …               │
└──────┬──────────────────────────────────────────────────┘
       │ callbacks (unfiltered Patch batches)
       ▼
┌─────────────────────────────────────────────────────────┐
│ Connection (per-client)                                 │
│   per-socket subscriptions, lazy filtering              │
│   RPC demux: session → Manager, daemon → Daemon         │
│   pull → self                                           │
└──────┬──────────────────────────────────────────────────┘
       │ push (replace + patch) + RPC (call + reply)
       ▼
┌─────────────────────────────────────────────────────────┐
│ BridgeClient + DocumentMirror (browser)                 │
│   local document copy, typed verb methods, RPC demux    │
│   pull orchestration, rendering                         │
└─────────────────────────────────────────────────────────┘
```

| Component | Runtime | Owns |
|---|---|---|
| pi | Node | durable history (jsonl), AgentSession, model selection, tool execution |
| Manager | Node | canonical Document, event→Patch pipeline, `onPatch`/`onReplace`/`onExit`/`onSettled` callbacks, typed session verbs |
| Connection | Node | WebSocket, subscription set, RPC demux, pull handler, `CompactCodec` |
| Daemon | Node | Manager list (`Map<instanceId, Manager>`), Connection list, WS/HTTP server, `ModelRuntime`, session-file mtime cache, daemon verbs (`listSessions`, `getDaemonInfo`, `listFiles`, `readFile`, `listInstances`, `console`) + routing verbs (`switchInstance`, `newInstance`, `killInstance`) |
| BridgeClient | browser | DocumentMirror, RPC pending map, typed verb methods |

State flow: pi → Manager (events + durable state), Manager → Connection
(callbacks), Connection → BridgeClient (wire: replace + patch push, RPC
call/reply). Steering flows the reverse path: BridgeClient → Connection →
Manager → pi.

The Manager, Connection, and Daemon run in the same process but are
logically separate. The `createManager` factory exposes the Manager alone for
tests and embedding. The `Daemon` class creates Managers on demand, creates Connections
on WS connect, and wires them together via `attach`/`detach`. The canonical Document lives in the
Manager and outlives any transport. The Manager callbacks (`onPatch`,
`onReplace`, `onExit`, `onSettled`) are the integration-test seam.

## 2. Manager

The Manager owns one pi runtime (`AgentSessionRuntime`) and one canonical
Document (1:1 with a session file on disk). It exposes typed session verbs and
`onPatch`/`onReplace` callbacks that replace the old `BridgeBus`.

### Bootstrap

At startup, the Manager hydrates the Document from pi's durable state:

```
initFromEntries(sessionManager.getEntries()) → Document
```

This is a one-time pure projection. All entries are at their pi ids, content
populated, `status` fields derived from the latest entries (model from
`model_change` entries, thinking level from `thinking_level_change` entries,
name from `session_info` entries). No events are replayed.

### Event pipeline

The Manager subscribes to pi's `session.subscribe(AgentSessionEvent)`. Each
event is processed synchronously, in order:

1. `applyEvent(document, event) → Patch | null` — maps the event to Patch ops.
   Applies the Patch to the canonical Document immediately.
2. If the event is `turn_end` or `agent_settled`: `reconcile(document,
   sessionManager.getEntries(), { model, thinkingLevel, contextUsage }) → Patch | null` — diffs pi's durable state
   against the Document and reconciles `status` via `opts`. Applies the resulting Patch immediately.
3. Each non-null Patch is dispatched to all `onPatch` listeners.

### Session verbs

The Manager exposes typed methods for all session-level operations. Their
effects are observed via `onPatch`/`onReplace` callbacks, **not** RPC
replies. The reply carries only the failure channel.

| Verb | Effect | Patch source |
|---|---|---|
| `prompt(text)` | Starts a turn | pi-event-driven (`applyEvent`) |
| `abort()` | Cancels in-flight turn, waits for settle | pi-event-driven |
| `discardSteer()` | Clears queued steer messages (`queue_update`) | `applyEvent` (`queue_update` → `pendingSteer`) |
| `setModel(provider, id)` | Resolves model via `ModelRuntime.getModel`, calls session.setModel | `reconcile` (idle) + seal `reconcile` discovers silent `model_change` entry |
| `setThinkingLevel(level)` | Calls session.setThinkingLevel | event-driven (`thinking_level_changed`) + `reconcile` |
| `renameSession(name)` | Calls session.setSessionName | event-driven (`session_info_changed` updates status.name) + `reconcile` |
| `navigate(entryId)` | Calls sessionManager.branch, sets leafId | synchronous leafId patch |
| `switchSession(path)` | Tear-down old session, create new via runtime.switchSession | `replace` push to all Connections |
| `newSession()` | Create empty session via runtime.newSession | `replace` push to all Connections |

**Idle-state reconcile:** `setModel`, `setThinkingLevel`, `renameSession`,
call `reconcile` immediately when called while idle (no turn in-flight),
ensuring silent entries appear without waiting for the next turn.
`navigate` sets `leafId` directly — it does not call `reconcile` because
`reconcile` would reset it to the last committed entry, which is wrong for
branch positions.

**`switchSession` / `newSession`:** These call `runtime.switchSession()` /
`runtime.newSession()`, which tear down the old session and create a new one.
The Manager sets `runtime.setRebindSession(callback)`, which re-bootstraps
the canonical Document from the new session's entries, re-subscribes to
events, and pushes `replace` to all attached Connections. The Manager object
persists; only its internal runtime and Document are replaced.

### Callbacks (replaces BridgeBus)

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
}
```

- `onPatch` — called for each `applyEvent`/`reconcile` emission.
- `onReplace` — called on bootstrap and after `switchSession`/`newSession` (via `rebindSession`).
- `onExit` — called during `manager.dispose()` after abort-save, before `runtime.dispose()`; Connections send `instance_exit`.
- `onSettled` — called on `turn_end`/`agent_settled` (first turn after `newSession` flushes file); Connections push `sessions_changed`.
- `addConnection` — registers callbacks + triggers an immediate `onReplace`
  push to the new Connection only. This replaces the old `Init` snapshot.

These callbacks are the **integration-test seam**. Tests subscribe to
`onPatch`/`onReplace` to observe Document changes without WebSockets.

## 3. Connection + Daemon

### Daemon

The Daemon is a singleton that owns a list of Managers and Connections.
On startup it creates a Manager, scans the session directory (cached), and
starts a WS/HTTP server. On WS connect, it creates a Connection attached to
the Manager.

Daemon verbs (handled by the Daemon, bypass the Manager):

| Verb | Reply | Notes |
|---|---|---|
| `listSessions` | `{ ok, sessions: SessionInfo[], hasMore }` | Mtime-cached per-file, filtered by `cwd`, paginated (`max`/`ts` cursor), live sessions excluded |
| `getDaemonInfo` | `{ ok, models: ModelInfo[], thinkingLevels: string[], cwdAllowlist: string[], devMode: boolean }` | Queries shared `ModelRuntime` (`getAvailableSnapshot()` + `getSupportedThinkingLevels`); `ModelInfo` carries `providerName`/`reasoning`/`supportedThinkingLevels`/`contextWindow` |
| `listFiles` | `{ ok, entries: { path, isDirectory }[] }` | Prefix match against instance cwd |
| `readFile` | `{ ok, path, content, truncated, bytes }` | Fresh disk read for the web file viewer; relative paths resolve against the attached instance cwd, `~` expands; capped at 256 KB with `truncated: true` |
| `listInstances` | `{ ok, instances: InstanceInfo[] }` | Enriched from each Manager's `Document` (`lastActivityAt`/`preview`/`messageCount`) |
| `console` | `{ ok }` | Dev-mode only (`--dev`); relay `console.*` from browser |

Routing verbs (Daemon-owned, per-Connection, side-effectful — mutate the instance registry via `Connection.attach`/`Manager.dispose`; never touch the WebSocket directly):

| Verb | Reply | Notes |
|---|---|---|
| `switchInstance` | `{ ok }` | Detach from old Manager, attach to target (`replace` push) |
| `newInstance` | `{ ok, instanceId }` | Spawn new Manager, attach conn (`replace` push) |
| `killInstance` | `{ ok }` | `manager.dispose()` → abort save → `instance_exit` push → teardown |

The Daemon creates a shared `ModelRuntime` (`ModelRuntime.create({ authPath })`) and injects it
into `createManager` (`modelRuntime`), so all Managers share the same catalog and auth.

### Connection

The Connection owns one WebSocket, attached to one Manager. It:

- Subscribes to Manager callbacks (`onPatch`/`onReplace`), filters patches
  against per-connection subscriptions via `filterPatchForSocket`, and sends
  them as push frames.
- Demuxes incoming RPC frames by `verb`: session verbs → Manager, daemon
  verbs → Daemon, `pull` → self.
- Owns the `pull` handler: reads Manager's canonical Document, registers
  subscriptions for provisional entries.
- Owns the RPC demux — the only place that inspects `id` on incoming frames.
  The Manager never sees `id` values or WebSockets.

### Wire protocol (ADR 06: dual channel)

One WebSocket carrying two sub-channels. Framing rule: a frame with an `id`
is an RPC (client→server call with server→client reply); a frame without an
`id` is a push notification (server→client, unsolicited).

**Push (server → client, no `id`):**

| Kind | Payload | When |
|---|---|---|
| `replace` | `{ document: Document }` | Re-attachment (`switchInstance`), `switchSession`, `newSession` (fresh `Connection` has `attachedManager=null` — no auto-push on connect) |
| `sessions_changed` | `{ sessions, hasMore }` | Daemon push on `agent_settled`/`renameSession`/`switchSession`/`newSession` |
| `instance_exit` | `{ instanceId }` | Only to Connections attached to the killed Manager (last frame) |
| `patch` | `{ ops: PatchOp[] }` | Each `applyEvent`/`reconcile` emission |

`replace` is always auto-pushed — the server sends it, the client replaces
its DocumentMirror wholesale. No client→server `Init` message.

**RPC (client → server, with reply):**

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
| `readFile` | Daemon | `{ ok, path, content, truncated, bytes }` |
| `listInstances` | Daemon | `{ ok, instances: InstanceInfo[] }` |
| `switchInstance` | Daemon (routing) | `{ ok, error? }` |
| `newInstance` | Daemon (routing) | `{ ok, instanceId }` |
| `killInstance` | Daemon (routing) | `{ ok, error? }` |
| `pull` | Connection | `{ ok, values: { entryId, fieldPath, value }[] }` |
| `console` | Daemon | `{ ok }` (dev-mode relay `console.*` from browser) |

**`pull`** is a Connection-local RPC. Its reply carries the current lazy
values. Its side effect — registering the requested paths in the
Connection's subscription set — is internal to the Connection. The Manager
is not involved. Subscription GC is implicit: when the provisional entry
commits, the id disappears, and future patch filtering naturally drops ops
on the old path.

Replies never carry Document state. Document changes arrive exclusively via
push.

## 4. BridgeClient + DocumentMirror

### BridgeClient

A typed, transport-injected client wrapping the WebSocket. Lives in `core`
(browser-safe).

```ts
bridge.prompt("Fix the buffer overflow")        // → Promise<RpcReply>
bridge.abort()                                  // → Promise<RpcReply>
bridge.discardSteer()                           // → Promise<RpcReply>
bridge.setModel("openai", "gpt-5")              // → Promise<RpcReply>
bridge.setThinkingLevel("high")                 // → Promise<RpcReply>
bridge.renameSession("fix-buf")                 // → Promise<RpcReply>
bridge.navigate(entryId)                        // → Promise<RpcReply>
bridge.switchSession(sessionId)                 // → Promise<RpcReply>
bridge.newSession()                             // → Promise<RpcReply>
bridge.listSessions()                           // → Promise<RpcReply>
bridge.getDaemonInfo()                          // → Promise<RpcReply>
bridge.listFiles(prefix)                        // → Promise<RpcReply>
bridge.readFile(path)                          // → Promise<RpcReply>
bridge.listInstances()                          // → Promise<RpcReply>
bridge.switchInstance(id)                       // → Promise<RpcReply>
bridge.newInstance(cwd)                         // → Promise<RpcReply>
bridge.killInstance(id)                         // → Promise<RpcReply>
bridge.pull(requests)                           // → Promise<RpcReply>

bridge.mirror                                   // → DocumentMirror (read-only)
bridge.onPush = (msg) => { ... }                // → push callback
```

`BridgeClient` owns two internal objects:
- `DocumentMirror` — receives push frames (`replace`, `patch`) and maintains
  the client-side Document.
- Pending-RPC map (`Map<id, {resolve, reject}>`) — correlates reply frames
  to outstanding promises. Rejected on `disconnect()` only.

Demux: on each received frame, check `id`. Present → resolve/reject pending
RPC. Absent → `replace` or `patch` → dispatch to `DocumentMirror`.

No `web` code constructs wire frames by hand. `BridgeClient` is the only
place that touches the envelope.

### DocumentMirror

A pure, browser-safe class in `core`:

| Method | Purpose |
|---|---|
| `applyReplace(snapshot)` | Replace entire mirror with server snapshot (new root, immutable-persistent) |
| `applyPatch(ops)` | Apply incremental Patch batch (returns new root, structural sharing) |
| `needsPull(pending)` | Return subset of pending fields whose value is still `null` |
| `ingestPullResponse(values)` | Set lazy fields to received values (new root) |

The mirror is the client's single source of truth for rendering. It converges
to the canonical Document over time but is never treated as authoritative.

### Pull orchestration (pull queue)

Components declare pending pulls during render by appending lazy-field paths to a per-render pull queue. The connection layer drains the queue after each render pass:

1. Components append wanted `(entryId, fieldPath)` pairs during render.
2. Drain: filter through `needsPull()` + `loadingPaths` (in-flight dedup).
3. One batched `bridge.pull(requests)`.
4. `DocumentMirror.ingestPullResponse(values)` + `onPush` re-render. No component calls `pull` directly.

### Reconnect

On disconnect, the client opens a new WebSocket, creates a new `BridgeClient`, and drives re-attachment: `getDaemonInfo` + `listInstances` → if stored `attachedInstanceId` still alive, `switchInstance(id)` → `replace` push. A fresh `Connection` has `attachedManager = null` — `replace` is a consequence of re-attachment, not automatic (multi-instance, §9). All lazy fields are `null` again; the pull loop re-drains pulls for what's on screen. `BridgeClient` rejects all pending RPC promises.

## 5. Cross-cutting topics

### Session lifecycle

The happy path through all components during a single turn:

```
1. BridgeClient → Connection: RPC { id, verb: "prompt", text }
2. Connection → Manager: manager.prompt(text)
3. pi emits agent_start
4. Manager: applyEvent → Patch { isStreaming: true } → onPatch listeners
5. Connection: filters against subscriptions → sends Patch push
6. BridgeClient: applies to DocumentMirror, fires onPush

7. pi emits message_start (assistant)
8. Manager: applyEvent → Patch { add skeleton } → onPatch → Connection → BridgeClient

9. pi emits message_update (text_delta, thinking_delta, toolcall_*)
10. Manager: applyEvent → Patch { append/replace } → onPatch → Connection
11. Connection: filters against per-socket subscriptions → sends to each socket
12. BridgeClient: applies to DocumentMirror (content streams in-place)

13. pi emits tool_execution_start, tool_execution_update, tool_execution_end
14. Manager: applyEvent → Patch (add/update tool results) → …

15. pi emits message_end
16. Manager: applyEvent → Patch (final metadata) → …

17. pi emits turn_end
18. Manager: applyEvent (no-ops for turn_end) + reconcile → Patch (rename,
    silent entries, status repair) → …
19. BridgeClient: provisional ids renamed, entries now committed

20. pi emits agent_settled
21. Manager: applyEvent → Patch { isStreaming: false } + reconcile (catches
    compaction entries) → …
22. Connection: sends RPC reply { id, ok: true }
```

Abort follows a similar lifecycle. Aborted messages commit with
`stopReason: "aborted"`; aborted tool calls commit an error result. Every
in-flight entry eventually commits — none are discarded.

### Laziness end-to-end

The lazy content contract spans all four components:

1. **Manager** — the canonical Document holds real values in all content
   fields. Laziness does not exist here.
2. **Connection** — `snapshotForWire()` nulls lazy fields before sending
   `replace`. `filterPatchForSocket()` drops Patch ops touching lazy fields
   the socket hasn't subscribed to. `pull` resolves real values from the
   canonical Document on demand.
3. **BridgeClient** — `DocumentMirror` tracks which fields are `null` (not yet
   fetched). `needsPull()` filters wanted fields. `ingestPullResponse()` sets
   them. The UI renders `null` as a loading placeholder.

### Multi-client

The system is multi-client by construction:

- **Manager callbacks** — all Connections receive the same Patch sequence.
- **Transport** — each Connection is an independent subscriber with its own
  subscription set. Lazy filtering is per-Connection; one client pulling a
  field does not affect another.
- **No cross-client state** — clients are anonymous to each other.

Steering is single-writer: only `prompt` is surfaced. Multi-writer
collaboration is not designed for.

## 6. Testing

Tests are a first-class design concern. Three architectural decisions make
comprehensive testing possible without a real provider or WebSocket:

### Manager callbacks as integration-test seam

Tests subscribe to `manager.onPatch`/`manager.onReplace` in-process — the
same interface Connections subscribe to. A test drives a turn through the
Manager's typed methods, subscribes to callbacks, and asserts the exact Patch
sequence. No WebSocket, no network, same production code path. This decouples
logic verification from transport verification.

### Injectable dependencies

The server factory (`createManager`) accepts pi-facing dependencies as
optional parameters: `modelRuntime`, `settingsManager`,
`sessionManager`, `model`, `customTools`, `sessionPath`, `cwd`, `agentDir`. Tests inject
memory-backed fakes (`ModelRuntime.inMemory()`, `SettingsManager.inMemory()`)
and a jsonl-fixture-resumed `SessionManager`. Production and test paths are
the same function call with different arguments.

### Fixture-resumed pi instances

Integration tests resume a real `SessionManager` from a jsonl session fixture,
then drive turns through the production `AgentSession` loop with a faux
provider. This exercises the full event pipeline — `applyEvent` + `reconcile`
at real seal points — catching event ordering, interleaving, and timing
issues.

### Test split (23 files)

| File | Kind | What |
|---|---|---|
| `accounting.test.ts` | Unit | `sessionAccounting` cost ledger |
| `bridge-client.test.ts` | Unit | `BridgeClient` RPC demux, disconnect, push handling (mock transport) |
| `client-mirror.test.ts` | Unit | `DocumentMirror.applyReplace`, `applyPatch`, `needsPull`, `ingestPullResponse` |
| `compact-codec.test.ts` | Unit | `CompactCodec` streaming-append compaction |
| `composer-draft.test.ts` | Unit | Composer draft (`idle`/`compose`/`edit`) + blur/expand rules |
| `convergence.test.ts` | Unit | Invariant 12 (snapshot ≡ filtered replay), subscribed-client diff |
| `document-unit.test.ts` | Unit | `applyEvent`, `reconcile`, `initFromEntries` with hand-built inputs |
| `event-roundtrip.test.ts` | Unit | Patches survive `JSON.parse(JSON.stringify(e))` — WS-seam insurance |
| `integration-gaps.test.ts` | Unit | `filterPatchForSocket`, lazy-filtering + sanitization |
| `model-ref-disambiguation.test.ts` | Unit | `ModelRef` provider disambiguation |
| `property-invariant.test.ts` | Unit | Invariants: committed entries immutable, domain-valid, structural sharing |
| `store-unit.test.ts` | Unit | Store selectors, `migrateExpandKeys`, `loadingPaths` dedup |
| `tree-unit.test.ts` | Unit | `HistoryTree` / `LaneLayout` (Pass 1 + Pass 2) |
| `viewmodel-unit.test.ts` | Unit | `computeViewModel`: leaf-path, turn merging, siblings, newest-leaf walk |
| `pull-queue.test.ts` | Unit | `planPull`, `actionPulls`, pull-queue scheduling |
| `connection-daemon.test.ts` | Integration | Connection RPC routing (prompt, daemon/routing verbs, pull, setModel), in-process WS pair |
| `manager-verbs.test.ts` | Integration | Manager verbs: setModel, setThinkingLevel, renameSession, navigate, abort, idle reconcile |
| `mirror-integration.test.ts` | Integration | Tool execution, concurrent tools, abort, errors |
| `multi-instance.test.ts` | Integration | Multi-instance routing (`switchInstance`/`newInstance`/`killInstance`, `instance_exit`) |
| `navigation-e2e.test.ts` | Integration | Navigate + mirror sync, prompt-from-branch, multi-navigate, idempotency |
| `streaming-edge-cases.test.ts` | Integration | Streaming tool updates, concurrent tools, abort mid-stream/tool, silent entries, steering |
| `walking-skeleton.test.ts` | Integration | Resume + faux turn through `DocumentMirror` + Manager patches |

Full harness and fixture design: `test/suite/harness.ts`.

## 7. Invariants

The load-bearing constraints. Violating one is expensive to undo.

1. **The Manager holds the canonical Document.** pi is the durable backing
   store. No other code path writes the canonical Document.
2. **Committed entries are immutable.** `entries` only grows. In-flight entries
   (provisional ids) are the only mutable content.
3. **Patch is the transaction boundary.** After each Patch, the Document is
   domain-valid. Multi-op transitions (commit rename + metadata) are grouped
   into one Patch.
4. **`core` is pure and browser-safe.** No `node:*`, no `fs`, no `net`, no DOM.
   `import type` only for coding-agent coupling. Enforced by the browser-smoke
   gate.
5. **Manager callbacks are the only state channel** from Manager to
   Connections. No direct Document access across the boundary except the
   `replace` push and `pull` resolution. The callbacks are the
   integration-test seam.
6. **pi's event loop is serial; the bridge adds no concurrency.** Events
   processed one at a time, in order. `applyEvent` and `reconcile` are
   synchronous.
7. **Thinking, tool arguments, and tool results are lazy on the wire; `TextContent.text` is wire-eager (never null).** `null` means "not
   fetched." The canonical Document always holds real values; lazy stripping
   happens only at the wire boundary (`snapshotForWire` + value-recursive
   sanitization in `filterPatchForSocket`). After a pull, lazy
   fields in the canonical document are never `null` for committed entries;
   genuinely-absent values normalize to `""` (redacted thinking) or `{}`
   (absent tool result details).
8. **Cancellation finalizes, never discards.** Aborted entries commit with
   aborted/error content. Partial streaming content is replaced, not removed.
9. **pi drives the turn loop.** The bridge adds observation and wire, not turn
   lifecycle. `prompt` always uses `streamingBehavior: "steer"`.
10. **Reconnect replaces state wholesale.** No retained op history. `replace`
    snapshot + re-pull for what's on screen.
11. **Components declare pending pulls, the pull loop is the sole fetcher.** Components
    append lazy-field paths to the per-render pull queue during render.
    The connection layer drains the queue after each render pass,
    issues one batched pull, and ingests results into the mirror. No
    component calls `pull` directly.
12. **filterPatchForSocket sanitizes embedded lazy content (convergence invariant).** Parent-path op
    values (entry-root adds, block-level replaces) may embed lazy subfields;
    the filter strips them from the wire value for unsubscribed sockets. A
    client replaying the filtered patch stream converges to the same document
    as one re-initialized from `snapshotForWire`.
13. **Manager verbs' effects are observed via push, not reply.** The reply
    carries only the failure channel. Document changes arrive as `patch` or
    `replace`. Replies never carry Document state.
14. **Fallible Manager verbs are reactive.** The Manager waits for pi's
    outcome before emitting a push. Synchronous-throw verbs (`setModel`,
    `setThinkingLevel`, `navigate`) reply `ok:false` immediately.
15. **No code constructs wire frames by hand.** `BridgeClient` wraps the
    transport on the client; `Connection.demux` routes to typed handlers
    on the server.
16. **Idle-state verbs reconcile immediately.** `setModel`, `setThinkingLevel`,
    and `renameSession` trigger an immediate `reconcile` (or direct status
    update) when called while idle. `navigate` sets `leafId` directly — it
    does not call `reconcile` because `reconcile` would reset it to the last
    committed entry, which is wrong for branch positions.
17. **Domain objects flow through canonical types.** All data crossing the RPC
    boundary (RPC replies, server push payloads) is typed with a canonical
    domain type from `src/core/types.ts`. Cast from `unknown` directly to the
    domain type — no `Record<string, unknown>` intermediate, no inline
    anonymous types for domain data. Shapes nested inside `JsonValue` (tool
    call arguments, verb-specific payloads) are exempt but must use `?:` for
    fields that arrive incrementally during streaming.

18. **Document is immutable-persistent.** Every `applyPatch`/`applyReplace`/`ingestPullResponse` returns a new root with structural sharing; `Object.is` on the root is the change signal. Unchanged subtrees keep reference identity, so selectors and `React.memo` stay cheap.

## 8. Deliberate omissions

- **No sequence numbers on Patch.** WebSocket is reliable-ordered; reconnect
  uses full `replace` snapshot.
- **No subprocess adapter.** The bridge runs pi in-process via the SDK.
- **No multi-writer steering.** Only `prompt` is surfaced. Multi-client is
  first-class in the plumbing (fan-out) but steering is single-writer.
- **No auth/network posture.** localhost-only; remote access via SSH tunnel.
- **No wire protocol schema versioning.** Reconnect replaces state wholesale.

## 9. Invariant addendum: Multi-instance (2026-07-21)

The multi-instance work (N Managers, N Connections, attachment routing) does
not break the existing invariants, with one scoped relaxation.

### §7.13 spirit: kill-discovery

Kill (`killInstance` → `manager.dispose()`) is a **routing verb** (Daemon-owned, side-effectful),
not a Manager verb. It is technically outside §7.13's literal scope. However,
the *spirit* of §7.13 ("effects observed via push, not reply") is preserved:
the `instance_exit` push is emitted via the Manager's `onExit` callback
to *attached* Connections, keeping the "Manager callbacks are the only state
channel" rule (§7.5). The Daemon never touches the WebSocket.

The scoped relaxation: killed tabs learn about the loss via the `instance_exit`
*push*, not via the next RPC reply. This deviates from the PRD's original
"on their next RPC" wording but preserves the invariant's spirit more
faithfully. See ADR 06 addendum for the `onExit`/`instance_exit` design.

### §7.10 no-auto-replace on connect

A fresh Connection now has `attachedManager = null` — nothing is pushed on
connect. The `replace` push is now a *consequence of re-attachment*, not
automatic. This is a behavioral change from v1 (reconnect no longer auto-
recovers the document). The client drives re-attachment from its stored
`attachedInstanceId` via `switchInstance`. This is consistent with §7.10's literal scope (transport
reconnect replaces state wholesale — it just happens via client-driven
`switchInstance` RPC + resulting `replace` push).

### ADR 07.5 framing

The literal rule (store holds exactly one Document root) still holds. The
parenthetical "v1 is one session per browser context" is outdated; the store
tracks the *attached* instance's document. A single root suffices because the
store only holds one instance's document at a time.

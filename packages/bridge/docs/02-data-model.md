# ADR 02: Data Model — How Clients Sync to the Bridge

**Status:** Decided. All directions settled; remaining detail (exact `Command`
vocabulary, TypeScript type definitions) is implementation, not architecture.

## Context

v0 `core` is a pure fan-out bus: it forwards raw `AgentSessionEvent`s to
listeners and holds no state. The `AGENTS.md` invariant — "the bridge is the
canonical session state machine" — is aspirational under v0. This ADR commits
to that target and specifies the data model and sync contract that replaces the
bus.

The premise: a client should **sync to a document, not re-reduce an event
stream.** The bridge maintains canonical state; clients receive changes against
that state and apply them. Late-joiners and reconnecting clients resync against
the document, not by replaying history.

## The reframe that drives this ADR

Sync complexity is **not uniform** across the state. The state splits into two
regimes:

1. **`entries`** — the conversation tree. Immutable once committed; in-flight
   entries live here too, under provisional ids, until renamed to their pi ids.
2. **`status`** — `leafId`, `isStreaming`, `isCompacting`, `model`,
   `thinkingLevel`, token stats. Small, whole-field replaces.

The sync protocol is regime-aware: content is lazy and pull-based (see
[Lazy-value contract](#lazy-value-contract)); structural changes and status
are pushed. One semantic operation (`append`) plus stock json-patch covers both
regimes.

## The server owns the document

The bridge (server) holds the canonical `Document` in full fidelity — every
entry, every content field, real values. It is the single source of truth for
clients; pi is the durable backing store the bridge hydrates from and writes
through to. Clients sync to the bridge's output; they do not re-reduce events.

`Document` has two kinds of data:

- **`entries`** — the full history, following pi's `SessionEntry` model. All
  entry types are present: messages, tool results, compactions, model changes,
  thinking-level changes, labels, session-info, custom entries. The UI renders
  them as it wishes.
- **`status`** — the current agent state: `leafId`, `model`, `thinkingLevel`,
  `isStreaming`, `isCompacting`, `stats`. Most of `status` is derived from
  `entries` (`leafId` = last entry; `model`/`thinkingLevel` = latest
  corresponding change entry; `stats` = accumulated usage). Only `isStreaming`
  and `isCompacting` are transient bridge-owned state not derivable from
  `entries`.

**Laziness is a wire-projection property, not a storage property.** The
server's `Document` always holds real content. The server withholds content
fields on the wire (sends `null` in their place) and delivers them on demand via
pull. This keeps snapshots small and avoids pushing content the client isn't
rendering — critical for a branching-heavy document where a client may present
only a single path.

> **Note: `CanonicalState` is renamed to `Document`.** The old name conflated
> "document to replicate across clients" with "agent state." `Document` is the
> replicated document; `status` is where the agent's current state lives.

## Two pure functions, not one reducer

The `Document` is maintained by **two pure functions** in `core`, both
browser-safe, both producing patches:

- **`applyEvent(doc, event) → patches`** — consumes real `AgentSessionEvent`s.
  Handles the streaming interim: provisional entry lifecycle, `append`/`add`/
  `replace` on content blocks, `status` updates from lifecycle events
  (`thinking_level_changed`, `compaction_start`/`_end`, `queue_update`,
  `agent_settled`). Also handles `entry_appended` (custom entries from
  extensions — these carry the real id in the event, so no provisional is
  needed).
- **`reconcile(doc, piEntries, opts?) → patches`** — called by the host at each
  settle (see [Settle timing](#settle-timing)) and by idle-state verbs (`setModel`/
  `setThinkingLevel`/`renameSession`). Diffs `piEntries` (`getEntries()`) against the
  `Document` to conform the document to pi's durable state: renames provisional
  ids to pi ids, discovers silent entries the event stream didn't carry, and
  repairs status drift (`model`/`thinkingLevel`/`contextUsage`/`name` via `opts: ReconcileOptions`, `stats` recomputed).

The host subscribes to `session.subscribe`, runs `applyEvent` per event, and
calls `reconcile` at each settle. The bus dispatches patches from both. The client
never knows which function produced a patch — it just applies them.

There is no synthetic event mechanism. The reducer's input is **only real pi
events**. `reconcile` takes `SessionEntry[]` (type-only coupling) plus an optional
`ReconcileOptions` bag for `status` fields that live outside entries (`contextUsage` from
`session.getContextUsage()`), not events.
This is more honest than the earlier "single reducer + synthetic events"
framing: the `Document` is canonical, and conformance with pi is a direct mirror
of `getEntries()` + the session's live `status` projection, not an event replay.

`core` imports `AgentSessionEvent` and `SessionEntry` via `import type` only
(no runtime coupling; the smoke gate erases type imports).

## Decision

**One `Document`** is the only in-memory state both the bridge and clients hold:

```
Document {
  status: { leafId, name, model: ModelRef{provider, modelId}, thinkingLevel, isStreaming, isCompacting, stats, contextUsage, pendingSteer }
  entries: Record<id, Entry>      // committed (immutable) + in-flight (provisional id, mutable)
  scopedModels: ScopedModelInfo[]
}
```

`status.model` is a `ModelRef` (same provider disambiguates `claude-sonnet` via Anthropic vs OpenRouter). `status.contextUsage` (`tokens/contextWindow/percent`) and `status.pendingSteer` (steer queue, wire-eager) are part of the canonical `Status` (`src/core/types.ts`).

**Amendment (ADR 09):** committed `Entry`s carry an optional wire-eager
`ord` - their index in the session file's entry list. It is assigned only
where the full file-ordered list is in hand (`initFromEntries` or `reconcile`
at settle), never by `applyEvent`. Initial sync can add the same `ord` to its
wire projection without mutating the canonical Document. `reconcile` assigns
positions in the same patch that discovers any earlier hole. An entry becomes
cacheable only after it has `ord`; renderers still derive order from
`parentId` walks. See ADR 09.

In-flight entries live in `entries` under provisional ids alongside committed
entries. There is no separate `pending` field. An entry's provisional id is
renamed to its pi-assigned id at the settle. The renderer treats all entries
uniformly (one `Entry` shape, one path); provisional entries are rendered as
in-flight, committed entries as frozen.

**A semantically-enhanced sync protocol, extending json-patch.** json-patch
plus one semantic operation: `append` (string concat at a path, the streaming
primitive). Rename is stock json-patch (`move` to rename the key + `replace`
for metadata fields). Everything else is stock json-patch (`replace` for
`status`, `add`/`remove`/`move` for structural changes).

**Thinking, tool arguments, and tool results are lazy (pull-to-stream).** `TextContent.text` is wire-eager (never `null`). The server withholds lazy fields on the wire (`null`); the client requests them on demand. A pull on an in-flight entry opens a live subscription (streams updates until commit); a pull on a committed entry is one-shot. See [Lazy-value contract](#lazy-value-contract) and `architecture.md` §7 invariants 11–12 (pull queue, filter sanitization).

## Pending in `entries`

In-flight entries are items in `entries` with a special (provisional) name. No
separate `pending` field; no merging of tool results into messages (pi's
entry-based model is followed as-is). At the settle, the entry is renamed
(provisional id → pi id) and its metadata is conformed (`id`, `parentId`,
`timestamp`).

Verified in `packages/agent/src/agent-loop.ts` and `session-manager.ts`:
- Parallel tool execution is the default; `tool_execution_update` events
  interleave, so multiple tool results stream concurrently — each is a separate
  in-flight entry under a provisional id.
- `tool_execution_end` + `message_end` (toolResult) commit sequentially after
  `Promise.all`, so commits are one-at-a-time even when streaming is concurrent.
- `message_end` carries the `AssistantMessage` (or `ToolResultMessage`);
  `sessionManager.appendMessage(event.message)` wraps that *same object* in a
  `SessionMessageEntry`, adding only `id`, `parentId`, `timestamp`. The content
  is identical between the event and the committed entry — reconciliation adds
  metadata, not a content diff.

## Settle timing

Pi assigns entry ids inside `appendMessage`, **after** `message_end` fires
(`agent-session.ts:548–594`: `_emit(event)` runs synchronously, then
`sessionManager.appendMessage(event.message)` runs at the tail of
`_handleAgentEvent`). There is no post-commit event — `entry_appended` fires
only for custom entries (`agent-session.ts:2328`, the extension `appendEntry`
path). Regular `appendMessage`/`appendModelChange`/`appendThinkingLevelChange`/
`appendCompaction` emit nothing after assigning an id.

The bridge therefore **defers reconciliation to a later event guaranteed to see
pi's post-append state.** Pi's `processEvents` awaits every listener per event
(`agent.ts:565`), and the agent loop awaits each `emit(event)` — so any event
after `message_end` is a safe reconciliation point. The content freezes at
`message_end` (streaming stops); the id is learned at the settle. The gap is
benign: `isStreaming` is already false, the entry exists under its provisional
id, `leafId` points at it, and reconnect rebuilds from real ids anyway.

**The host reconciles at `turn_end` and `agent_settled` (plus idle verbs):**

- **`turn_end`** — seals each turn's assistant message + tool results + any
  `model_change`/`thinking_level_change` that landed during the turn. One
  `getEntries()` diff → one Patch (with `opts: { model, thinkingLevel, contextUsage }`).
- **`agent_settled`** — final sweep: catches compaction entries (compaction
  runs after `agent_end` and before `agent_settled`, `agent-session.ts:1891`)
  and any stragglers. Same diff mechanism.
- **Idle verbs** — `setModel`/`setThinkingLevel`/`renameSession` call `reconcile` immediately when idle (no turn in-flight) via `tryReconcile(opts)` so silent entries appear without waiting for the next turn; `navigate` sets `leafId` directly instead.

Both events always fire, including on the abort/error paths (`agent-loop.ts:197`,
`:224`; `agent.ts:508`; `agent-session.ts:538`). The gap lengths: assistant
message / tool results — `[message_end → turn_end]` (the tool-execution window);
compaction — `[compaction_end → agent_settled]` (brief).

## Three categories of entries

Not every entry reaches the `Document` the same way. `reconcile`'s `getEntries()`
diff partitions new entries into three categories:

1. **Streamed** — assistant, user, and toolResult messages. `applyEvent` built
   them under provisional ids from `message_*`/`tool_execution_*` events.
   `reconcile` renames: pairs by `toolCallId` (tool results) or by kind +
   ordinal (messages, see [Provisional naming](#provisional-naming-scheme)).
   Emits `move` + metadata `replace`s + `leafId` `replace` if applicable.

2. **Custom** — extension `appendEntry` entries. `entry_appended` carries the
   real id in the event; `applyEvent` adds them directly. `reconcile` finds
   them already in the `Document` and skips them.

3. **Silent** — `model_change`, `thinking_level_change`, `compaction`, `label`,
   `session_info`. These have no streaming (no provisional) and no event that
   carries the entry id:
   - `appendModelChange` → `model_select` emitted to extensions only, not
     `session.subscribe` (`agent-session.ts:1545`, `:1518`).
   - `appendThinkingLevelChange` → `thinking_level_changed` carries the level,
     not the entry id (`:1641`, `:1648`).
   - `appendLabelChange` → emits nothing (`:2338`).
   - `appendCompaction` → `compaction_end` carries a result, not the entry id.
   - `appendSessionInfo` → `session_info_changed` carries a name, not the id
     (`:2778`, `:2780`).

   `reconcile` discovers them via the `getEntries()` diff and emits `add
   /entries/<piId>` (skeleton + content, all lazy fields `null`). These can
   arrive mid-turn (e.g. `setLabel` from an extension during tool execution);
   the next settle sweep catches them. The gap is bounded by the next settle —
   same as category 1's rename gap.

`reconcile` also repairs **status drift** at each sweep: applies `opts` (`model`/`thinkingLevel`/`contextUsage`/`name`) and recomputes `stats` via `deriveStats`, emitting `replace
/status/*` if they differ from the `Document`. This covers `setModel`, which
emits no `AgentSessionEvent` at all, and `contextUsage` (from `session.getContextUsage()` — not derivable from entries). `name` is also carried via `opts` rather than re-derived from entries. At `turn_end`/`agent_settled` the host passes live session state as `opts`; idle verbs pass it via `tryReconcile`.

## Provisional naming scheme

In-flight entries use:

- `pending:message` — the assistant message. Singleton per turn (the
  one-message invariant: the assistant message commits before tools execute).
- `pending:<toolCallId>` — tool results. `toolCallId` is known from
  `tool_execution_start`, stable, and unique within a turn.
- `pending:user:<n>` — user messages, where `<n>` is a **1-based ordinal the
  reducer derives from document state** at `message_start` time:
  `n = 1 + count of entries whose id matches /^pending:user:/`. No host-side
  id minting, no counter field — the ordinal is a pure function of the current
  `entries`.

  The ordinal is necessary because pi's `steeringMode` is user-configurable
  (`"all"` | `"one-at-a-time"`, default `"one-at-a-time"`, `agent.ts:222`,
  `types.ts:49`). In `"all"` mode, multiple steered user messages drain into one
  turn (`agent-loop.ts:168–184`), all in-flight simultaneously until the turn
  seals. A singleton `pending:user` would collide. All `pending:user:*` seal at
  `turn_end`, so the count returns to 0 before the next turn; the ordinal is
  naturally turn-scoped without the reducer tracking turns explicitly.

No id minting by the reducer; no provisional→real mapping state. The host's
`reconcile` pairs a committed entry with its provisional by matching
`toolCallId` (for tool results), by kind + ordinal (for user messages), or by
kind (for the assistant message — singleton). Pi appends in event order and the
reducer added provisionals in event order, so ordinal pairing is correct.

## Semantic op vocabulary

json-patch plus `append` only. `append`'s semantics:
`{ op: "append", path, value: string }` concatenates `value` to the string at
`path` (the path must reference an existing string field). The client holds the
final string, not an array of chunks. Typical paths during streaming:
`/entries/<provisionalId>/content/<i>/text` (a text block),
`/entries/<provisionalId>/content/<i>/thinking` (a thinking block), or
`/entries/<provisionalId>/content/<i>/arguments` (a `ToolCall`'s arguments,
serialized as a string).

`append` remains semantic because stock json-patch's alternatives for streaming
string-concat (`replace` the full string, or `add` to a `chunks[]` array) are
both worse for LLM streaming. A future regime that json-patch serves poorly
would add a semantic op, additively.

The reducer is **delta-driven**: it consumes `assistantMessageEvent` (the
closed, `contentIndex`-keyed delta union from `packages/ai/src/types.ts` ~L459:
`text_start`/`text_delta{delta}`/`text_end{content}`, `thinking_*`,
`toolcall_*`) rather than the full accumulated `message`. Each delta maps
directly to a patch op:

- `*_start` → `add` a content block at `/entries/<provisionalId>/content/<i>`,
  with content fields `null` (lazy skeleton). For `toolcall_start`, the
  skeleton carries the partial arguments object (typically `{}`) rather than
  `null` — pi's `parseStreamingJson` has already reconstructed it from the
  LLM stream.
- `*_delta` → `append` the delta string to the block's `text`/`thinking`
  string fields. For `toolcall_delta`, the handler diffs the current
  arguments object against pi's reconstructed partial object and emits
  **granular json-patch ops** (`add`, `replace`, `append` on sub-paths like
  `/arguments/path`, `/arguments/content`). String sub-paths that grow by
  prefix use `append` for O(n) wire cost. Arrays recurse element-wise (new
  trailing element → `add` at the new last index; element string-field grows
  by suffix → `append` on `/arr/<i>/field`), so a streamed `edits[].newText`
  costs O(n) wire, not O(n²) whole-array `replace`.
- `*_end` → `replace` with the authoritative final
  (`text_end.content` / `thinking_end.content` / `toolcall_end.toolCall`).

The `*_end`→`replace` finalization is the correctness floor: `text_end` /
`thinking_end` / `toolcall_end` carry authoritative finals that may differ from
accumulated deltas (OpenAI `textSignature`, salvaged tool-call JSON in
`failToolCallsFromTruncatedMessage`). Without it, the document can drift from
the committed message. The reducer reads the full `message` at the bookends —
`message_start` for the skeleton (role, api, provider, model) and `message_end`
for the final (usage, stopReason) — but content growth during streaming is
delta-driven.

Tool execution events map similarly:
- `tool_execution_start` → `add /entries/pending:<toolCallId>` with skeleton
  (`toolCallId`, `toolName`, `content: null`, `details: null`, `isError: false`).
- `tool_execution_update` → `replace /entries/pending:<id>/content` + `replace
  .../details` (whole-field; partials are snapshots, not deltas).
- `tool_execution_end` → final `replace` of `content`/`details`/`isError`.

## Lazy-value contract

**Only thinking, tool arguments, and tool results are lazy. `TextContent.text` is wire-eager.** The closed lazy set:

- `ThinkingContent.thinking` — reasoning. Can be large; a client with the
  thinking panel collapsed shouldn't pay for it. (`TextContent.text` is wire-eager — always `string`, never `null`.)
- `ToolCall.arguments` — tool call arguments (partial JSON object). Only
  needed when the tool card is expanded. Stored as `JsonValue | null`;
  `null` means not yet pulled, an object means partial or final data.
  Streaming uses granular json-patch ops on sub-paths, not raw string
  fragments — the client always holds valid JSON.
- `ToolResultEntry.content` — tool output; median ~150 bytes, max ~49 KB.
- `ToolResultEntry.details` — structured tool metadata; median ~500 bytes, max
  ~8 KB.

All other fields (skeleton: `type`, content-block position, `id`, `name`,
`toolCallId`, `toolName`, `isError`, role, kind, all `EntryBase`, all `status`)
are always pushed.

A lazy field is `null` on the wire when not pulled. The pull request is keyed by
`(entryId, fieldPath)` — per-block granularity (e.g.
`/entries/<id>/content/3/text`), not per-entry. This gives subscription
precision: a client can subscribe to one text block without also streaming
thinking blocks in the same entry. To avoid chattiness on initial load or
navigation, `PullRequest` and `PullResponse` are **batches** — arrays of
`(entryId, fieldPath)` / `(entryId, fieldPath, value)` pairs, one round-trip.

**Pull = subscription for in-flight entries.** A `PullRequest` for a provisional
entry opens a live subscription: the server sends a `PullResponse` with the
current value, then forwards subsequent patches touching that path until the
entry commits (the `move` at the settle is the natural end-of-subscription
signal; the daemon GCs subscriptions whose entry has committed). A
`PullRequest` for a committed entry (frozen, no future updates) degenerates to
one-shot: a `PullResponse` with the final value, no follow-ups. One protocol,
two behaviors, distinguished by whether the entry is still provisional.

**Delivery filtering is per-socket, in the transport, not in `core`.** The
reducer produces all patches (including `append` and content `replace`s on lazy
paths). The server's `Document` always holds real content. The daemon's bus
listener filters per-socket: if a patch op touches a lazy field path and the
socket has no active subscription for that path, the op is dropped. `core` stays
pure; the subscription set is transport state. This is the one piece of
per-client semantics that moves from "deferred" (v0 `AGENTS.md`) into v1 — it's
a transport concern (which socket gets which op), not a reducer concern.

## Conformance scope

At the settle, `reconcile` diffs `piEntries` against the `Document` (and applies `opts`). For each
new entry:

- **Provisional exists (streamed)** → `move /entries/provisionalId →
  /entries/piId` + `replace /entries/piId/id` + `add
  /entries/piId/parentId` + `add /entries/piId/timestamp` + `replace
  /status/leafId` if the committed entry is the new leaf + `backfillLazyFields` (`thinking`/`arguments`/`content`/`details` that streaming left `null` but the durable entry normalizes to `""`/`{}`). No content diff beyond the backfill:
  `appendMessage(event.message)` wraps the same message object the event
  carried, so the content is identical between the in-flight and committed
  entry.
- **No provisional (silent)** → `add /entries/<piId>` (projected `SessionEntry`,
  lazy fields `null` on the wire via `filterPatchForSocket`/`snapshotForWire`; canonical holds real values).
- **Already in `Document` (custom)** → skip.

After entries, `reconcile` reconciles `status` (`leafId`, `name`/`model`/`thinkingLevel`/`contextUsage` from `opts`, `stats` via `deriveStats`).

If pi ever introduces a transform between `message_end` and persistence,
`reconcile` detects the content diff and emits a `replace` on the content path —
a backward-compatible extension, not a redesign.

## Cancellation

Cancellation does not require a new op or a "discard" path. On abort, the
assistant message still commits (with `stopReason: "aborted"`); aborted tool
calls commit an error result (`"Operation aborted"`, `isError: true` —
`agent-loop.ts:634`, `:649`). Every in-flight entry eventually commits — with
aborted/error content rather than its streaming content. The partial streaming
content is `replace`d by the error result (stock json-patch). No "remove from
entries" op for cancellation.

## Bootstrap

At bridge start, the host hydrates the `Document` from `sessionManager.getEntries()`
via a pure function `initFromEntries(entries: SessionEntry[]): Document`. This
produces the full-fidelity `Document` with all entries at their real pi ids,
content fields populated, `status` derived. It is not event-driven — it is a
one-time projection from pi's durable state. The `SessionEntry` type coupling is
type-only (browser-safe). `initFromEntries` is pure and testable without mocks.

## Reconnect

The client sends `Init` (no `lastSeenSequence` — see below); the server sends a
full `Document` snapshot (all content fields `null`). The client replaces its
state and pulls the content it needs (batch `PullRequest` for what's on screen).
No retained op history; the snapshot is bounded because all content fields are
withheld.

There is no `sequence` field on `Patch` and no `lastSeenSequence` on
client→server `Init`. WebSocket is a reliable ordered stream — a "dropped frame"
is really a connection close, which triggers reconnect→snapshot. `sequence` was
redundant with the transport's own reliability. The Patch's atomicity property
(see [Transactions](#transactions)) is a client-side application rule, not
sequence-dependent.

Per-socket pull-subscriptions are per-connection. Reconnect = fresh snapshot +
client re-issues pulls for what's on screen. No subscription state carried
across reconnect.

## Transactions

The reducer emits a sequence of ops. Some transitions are multi-op and have
**domain-invalid intermediate states**: the commit rename + metadata is the
motivating case. After `move /entries/pending:msg → /entries/realId` but before
`add /entries/realId/parentId`, the entry is at its real id with no `parentId` —
a committed entry without a parent is domain-invalid.

**The Patch is the transaction.** Each `Patch { ops[] }` is an atomic batch. The
client applies all ops in a Patch before rendering. The reducer guarantees:
after each complete Patch, the document is domain-valid. Ops that must be atomic
(commit rename + metadata + `leafId` advance, or a batch of renames from one
settle) are grouped into one Patch. No concept beyond the Patch — the atomicity is
a property of how the reducer groups ops and how the client applies them. One
event → zero or one Patch; one `reconcile` call (which may carry multiple
entries) → one Patch.

The domain-validity constraints the reducer must respect after each Patch:

- Committed entries have `id`, `parentId`, `timestamp` all set.
- In-flight entries have a provisional `id` but may lack `parentId`/`timestamp`.
- `status.leafId` points to an entry that exists in `entries` (or null for an
  empty session).
- Lazy fields are either a real value or `null` (not absent).

## Wire protocol

One WebSocket connection, one JSON message format with a `kind` discriminator:

```
ServerMessage = Init | Patch | PullResponse | CommandAck
ClientMessage = Init | PullRequest | Command
```

- `Init` (server→client) carries a full `Document` snapshot (content fields
  `null`).
- `Patch` (server→client) carries `{ ops[] }` — one transaction. Ops touching
  lazy fields are filtered per-socket (see [Lazy-value contract](#lazy-value-contract)).
- `PullResponse` (server→client) carries a batch of `{ entryId, fieldPath,
  value }` — the initial values for a pull, plus subsequent values for
  subscriptions (delivered as `Patch` ops, not repeated `PullResponse`s).
- `CommandAck` (server→client) carries `{ id, success, error? }` — defined
  but not yet sent by the daemon.
- `Init` (client→server) is `{ kind: "init" }` — no `lastSeenSequence`.
- `PullRequest` (client→server) carries a batch of `{ entryId, fieldPath }`
  pairs.
- `Command` (client→server) carries a bridge command.

The lazy pull rides the same connection as state sync. The `Command` vocabulary
is downstream: v0 surfaces `prompt` only (per `AGENTS.md`, always with
`streamingBehavior: "steer"`); the envelope carries whatever commands are added
later. `abort`/`steer`/model-switching are plumbing-available in pi but deferred
for the web MVP.

> The implemented wire differs from the above: [ADR 06](./06-component-model.md)
> supersedes the frame encoding with its dual-channel spec (push
> `replace`/`patch` + RPC call/reply, no `Init`). ADR 06 also specifies the
> **compact wire form** — a transport-layer compaction where consecutive
> single-op `append` patches to the same path are emitted as bare JSON
> strings (no frame envelope); the decoder restores the append op before the
> mirror sees it. Upper layers (diff engine, `DocumentMirror`, `onPush`) are
> untouched.

## Data model

```
Document {
  status: { leafId, name, model: ModelRef{provider, modelId}, thinkingLevel, isStreaming, isCompacting, stats, contextUsage, pendingSteer }
  entries: Record<id, Entry>      // committed (immutable) + in-flight (provisional id)
  scopedModels: ScopedModelInfo[]
}

Entry = MessageEntry | ToolResultEntry | BashExecutionEntry | CompactionEntry | ModelChangeEntry | ...
MessageEntry    = { kind: "message", role, content: Content[], ...EntryBase }
ToolResultEntry = { kind: "tool_result", toolCallId, toolName,
                    content: (TextContent|ImageContent)[] | null,  // null = lazy
                    details: JsonValue | null,                     // null = lazy (absent → {})
                    isError: boolean,
                    ...EntryBase }
BashExecutionEntry = { kind: "bash_execution",          // user-initiated shell run (! cmd)
                    command, output, exitCode, cancelled,
                    truncated, fullOutputPath, excludeFromContext,
                    ...EntryBase }                            // wire-eager (no lazy fields)
Content = TextContent | ThinkingContent | ToolCallBlock
TextContent     = { type: "text",     text: string, ... }         // wire-eager
ThinkingContent = { type: "thinking", thinking: string | null, ... } // null = lazy (redacted → "")
ToolCallBlock   = { type: "toolCall", id, name,
                    arguments: JsonValue | null, ... }               // null = lazy; object = partial/final

EntryBase = { id, parentId, timestamp }   // id is provisional ("pending:...") until settle
```

The bridge `Entry` union follows pi's `SessionEntry` model but is a **wire-safe
projection**, not a 1:1 mirror. `SessionEntry` has fields that are not
wire-safe: `CustomEntry.data: unknown` / `CompactionEntry.details: T` /
`CustomMessageEntry.details: T` (no serialization guarantee), and
`AssistantMessage.diagnostics` (redacted provider internals, not
render-relevant). The host projects each `SessionEntry` variant to a wire-safe
bridge `Entry` with explicit field types: `unknown` fields become a defined
json-safe union (`JSON value | null`), `diagnostics` is dropped. All entry
types stay in `entries` (including labels and session-info) — the renderer
filters.

An in-flight `MessageEntry` has `id: "pending:message"` or
`id: "pending:user:<n>"`; an in-flight `ToolResultEntry` has `id:
"pending:<toolCallId>"`. `parentId` and `timestamp` are set at the settle.
`ToolCall.arguments` is a `JsonValue` (partial object). It is not serialized
as a string — pi's `parseStreamingJson` has already reconstructed the
partial object from LLM fragments. Streaming emits granular json-patch ops
(`add`, `replace`, `append` on sub-paths) so the client mirror always holds
valid JSON. Lazy — pull to receive (`null` on wire = not fetched). The exact TypeScript definitions (the `Entry` union,
the `ServerMessage`/`ClientMessage` unions, the `append` op) are implementation,
to be written in `packages/bridge/src/core/`.

## Invariants

1. Committed entries are immutable; `entries` only grows; branching moves
   `status.leafId`, never mutates a committed entry. In-flight entries (under
   provisional ids) are the only mutable content.
2. The bridge holds the canonical `Document` (full-fidelity); clients sync to
   its output. Pi is the durable backing store.
3. The serial event loop is non-negotiable; events are processed one at a time,
   in order.
4. Entry ids come from pi; `reconcile` renames provisional ids to pi ids at the
   settle (`turn_end` + `agent_settled`), and discovers silent entries via
   `getEntries()` diff.
5. Thinking, tool arguments, and tool results are lazy; `null` at those fields means "not yet
   fetched." `TextContent.text` is wire-eager (never `null`). Pull on an in-flight entry = subscription; pull on a committed
   entry = one-shot.
6. Cancellation finalizes (commits aborted/error content), never discards.
7. `core` is pure and browser-safe. `applyEvent` is event-only (type-only
   `AgentSessionEvent` coupling). `reconcile` takes `SessionEntry[]` + optional `ReconcileOptions` (type-only
   coupling). No synthetic events; no runtime coding-agent coupling.
8. After each Patch, the document is domain-valid: committed entries have
   `id`/`parentId`/`timestamp`; `leafId` points to an existing entry or null;
   lazy fields are value-or-`null`.
9. Committed entries carry an optional wire-eager `ord` - their index in the
   session file's entry list. `initFromEntries` and `reconcile` assign it while
   the complete ordered list is available; initial sync can add the same value
   to its wire projection without mutating the canonical Document. Entries
   become cacheable only after assignment. `ord` is sync metadata; renderers
   derive order from `parentId` walks. (ADR 09)

## Relationship to v0

v0 ships the bus; this ADR specifies what replaces it. With the two-function
model placed in `core`, the migration is additive: the bus's `subscribe`/
`dispatch` surface is the listener the host hooks into. The bus becomes the
patch-emission channel; `dispatch` goes from "forward the raw event" to
"`applyEvent`, then dispatch patches; at settles, `reconcile`, then dispatch
patches." A usage line must be added to `scripts/browser-smoke-entry.ts` so the
gate exercises both `applyEvent` and `reconcile`.

# Document Data Model

The bridge synchronizes a canonical `Document`, not an event stream. The
Manager owns the canonical value for one Session; a web `DocumentMirror` is a
client replica. The wire representation and RPC envelope are described in
[protocol.md](protocol.md), and cursor-based initial sync and cache projection
are described in [sync.md](sync.md). The vocabulary follows
[the glossary](../glossary.md).

## Document

`Document` has two fields:

```ts
interface Document {
  status: Status;
  entries: Record<string, Entry>;
}
```

A document transition is immutable. `applyEvent` and `reconcile` return a
`Patch`; `applyPatch` applies the ordered operations with structural sharing
and returns a new root. Untouched objects retain their references. A non-empty
patch always changes the root, and applying a patch is atomic from the
client's point of view: the mirror renders only after all operations in the
patch have been applied.

`status` is the current session projection. It contains `leafId`, `name`,
`model` (`ModelRef` with `provider` and `modelId`), `thinkingLevel`,
`isStreaming`, `isCompacting`, `stats`, `contextUsage`, and `pendingSteer`.
Pinned models is not Document state: it is one daemon-global list resolved
from pi's global `enabledModels` and delivered by `getDaemonInfo` and the
`pinned_models_changed` push (ADR 15). Status fields derived from entries are
recomputed by the pure document functions; live model and context state can
also be supplied by the host during reconcile.

The server's document is full fidelity. A client mirror is never authoritative
and is replaced by the next initial-sync snapshot after reconnect or a failed
incremental attach.

## Entries

An `Entry` is the unit of persistence, rendering, and synchronization. Every
variant extends:

```ts
interface EntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
  ord?: number;
}
```

Committed entries have their durable id, parent, and timestamp. In-flight
entries use a provisional `id`; their identity and metadata are completed at
seal. `ord`, when present, is the zero-based position in the complete
`SessionManager.getEntries()` list. It is assigned only while that ordered
list is available, never by `applyEvent`, and is absent on provisional
entries. Its sync and cache meaning is specified in [sync.md](sync.md).

The union has exactly these eleven variants:

- `MessageEntry`, `kind: "message"`: `role` is `"user"` or `"assistant"`,
  with `content: Content[]`. Assistant entries can carry provider/model,
  response metadata, usage, stop reason, and an error message.
- `ToolResultEntry`, `kind: "tool_result"`: `toolCallId`, `toolName`,
  `content: Content[] | null`, `details: JsonValue | null`, and `isError`.
- `BashExecutionEntry`, `kind: "bash_execution"`: the user command, eager
  output, nullable `exitCode`, `cancelled`, `truncated`, nullable
  `fullOutputPath`, and `excludeFromContext`.
- `CompactionEntry`, `kind: "compaction"`: `summary`,
  `firstKeptEntryId`, `tokensBefore`, nullable `details`, and `fromHook`.
- `BranchSummaryEntry`, `kind: "branch_summary"`: `fromId`, `summary`,
  nullable `details`, and `fromHook`.
- `ModelChangeEntry`, `kind: "model_change"`: `provider` and `modelId`.
- `ThinkingLevelChangeEntry`, `kind: "thinking_level_change"`:
  `thinkingLevel`.
- `LabelEntry`, `kind: "label"`: `targetId` and an optional `label`.
- `SessionInfoEntry`, `kind: "session_info"`: an optional `name`.
- `CustomEntry`, `kind: "custom"`: `customType` and nullable JSON `data`.
- `CustomMessageEntry`, `kind: "custom_message"`: `customType`, nullable
  `content`, nullable `details`, and `display`.

`Content` is `TextContent`, `ThinkingContent`, `ImageContent`, or
`ToolCallBlock`. Text is eager. Thinking content has nullable `thinking`, and
a tool call has nullable `arguments`; those nulls mean that the value has not
been pulled on that wire path, not that the canonical value is absent.

## Events, reconciliation, and seal

`applyEvent(doc, event)` handles the live event phase. It creates provisional
entries in `entries`, updates status, and emits ordinary JSON-patch operations
for streamed content:

- `pending:message` is the assistant message for the current turn.
- `pending:user:<n>` is a one-based ordinal for each in-flight user message.
- `pending:<toolCallId>` is the tool result for a tool call.

The provisional names are derived from the current document. They are not a
second pending collection and do not require a mapping table. Streaming text
and thinking use `append`; partial tool-call arguments use granular object and
array diffs, with `append` for string suffixes. Tool execution updates replace
partial content or details. An `entry_appended` event already carries the
real id and is added directly.

Pi persists ordinary user, assistant, and tool-result messages at
`message_end`, before the bridge has a durable id available in its event
handler. The document therefore keeps the provisional entry until a later
settle boundary. The host runs `reconcile(doc, piEntries, options)` after
`turn_end` and `agent_settled`, and also after idle-state changes that need
silent entries or status repaired.

`reconcile` walks the complete durable list by index. For an existing entry it
ensures `ord` is correct. For a durable entry paired with a provisional it
emits one atomic rename: `move` to the durable id, metadata updates, lazy
backfill from the durable entry when streaming left a field null, and the new
`ord`. This is the seal transition. A discovered earlier hole can assign
positions to already-known later entries in the same patch. Durable entries
with no provisional are added from the file projection. Status leaf, name,
model, thinking level, context usage, and aggregate stats are repaired in the
same reconcile result when needed.

The host's `turn_end` and `agent_settled` processing applies the event patch,
then the reconcile patch, then notifies settled listeners. This ordering makes
the seal and its status changes visible as complete patch transactions. Idle
`setModel`, `setThinkingLevel`, and `renameSession` paths reconcile without
waiting for another turn; `navigate` changes `status.leafId` directly so it
does not reset a chosen branch position.

Cancellation finalizes state. The host clears the steer queue before awaiting
`session.abort()`, preventing queued steering text from starting a new turn
while abort waits. Pi then persists the assistant and tool-result outcomes as
aborted or error entries; cancellation does not remove a partial entry from
the document. The reply is sent only after the host operation completes, while
its document effects arrive through pushes.

## Lazy values

Laziness is a wire projection and delivery policy, not a property of the
canonical document. `snapshotForWire` strips these fields from every entry:

- `/entries/<id>/content/<i>/thinking`
- `/entries/<id>/content/<i>/arguments`
- `/entries/<id>/content` for a `tool_result`
- `/entries/<id>/details` for a `tool_result`

These are the exact roots in `LAZY_FIELD_PATTERNS`. `isLazyFieldPath` also
recognizes descendants of the object-valued `arguments` and `details` roots,
so a granular patch cannot bypass the subscription check. Text, image data,
tool names and ids, entry metadata, status, and scoped models are eager.

The canonical document holds real lazy values. Wire snapshots and unsubscribed
patches use `null`; `filterPatchForSocket` also sanitizes lazy fields embedded
inside an entry-root or content-block `add`/`replace` value. A connection's
`pull` request returns the current requested values. Pulling a provisional
entry registers a live subscription for later patches on that path; pulling a
committed entry is one-shot because it cannot change. The client mirror
requests only paths still null and merges pull replies through the same
immutable path update mechanism.

Projection normalizes genuinely absent values so null has one meaning: not
pulled. Missing thinking text becomes an empty string in canonical projections,
and missing tool-result details become an empty object. A committed entry is
therefore never canonically left with a lazy null merely because its wire
projection was lazy.

## Bootstrap and reconnect

`initFromEntries` projects the complete durable `SessionEntry[]` into a full
fidelity document and assigns `ord` in file order. Manager bootstrap then
overlays live model, thinking-level, context-usage, and scoped-model values.
No client event replay is required.

When a Connection attaches, the host emits exactly one initial-sync frame
before later live patches. It is a full `replace` or a cursor-aware `patch`,
and both carry the `SessionRef`; the rules are in [sync.md](sync.md). A
Connection clears its lazy subscriptions and resets its compact-wire state on
attach. On reconnect the client seeds, or starts with, its local mirror, then
reissues pulls for visible lazy paths. A full replacement always wins over the
old mirror and current server state wins over cached status hints.

The permanent wire contract is defined by the core types and is shared by the
Node host and the web client. Host routing details belong with the runtime
architecture; web projection details belong with the web architecture.

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

A document transition is immutable. `applyEvent`, `refresh`, and `settle`
return a `Patch`; `applyPatch` applies the ordered operations with structural sharing
and returns a new root. Untouched objects retain their references. A non-empty
patch always changes the root, and applying a patch is atomic from the
client's point of view: the mirror renders only after all operations in the
patch have been applied.

`status` is the current session projection. It contains `leafId`, `name`,
`model` (`ModelRef` with `provider` and `modelId`), `thinkingLevel`,
`isStreaming`, `isCompacting`, `stats`, `contextUsage`, `pendingSteer`, and
`inFlightTools`. `inFlightTools` is the one host-owned live field that is not
part of pi's model and is never persisted: a `toolCallId → elapsedMs` map,
produced by the host from an in-memory start stamp, so a client attaching
mid-run recovers how long a running tool has already run. Absent means no tool
is in flight. Pinned models is not Document state: it is one daemon-global list resolved
from pi's global `enabledModels` and delivered by `getDaemonInfo` and the
`pinned_models_changed` push (ADR 15). Status fields derived from entries are
recomputed by the pure document functions; live model and context state can
also be supplied by the host at its refresh boundary.

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
  isSealed?: boolean;
  ord?: number;
}
```

`id` is stable from the entry's first event through persistence and reopen;
it is never renamed or reused. `isSealed` is the lifecycle fact: `false` while
the entry is the live, not-yet-persisted form, `true` once the authoritative
persisted representation has been installed. Absent means sealed, so records
written before the field existed stay authoritative. Execution state (running,
completed, failed, aborted) is independent of sealing: a tool can finish
before its entry seals.

`ord`, when present, is the zero-based position in the complete
`SessionManager.getEntries()` list. Sealing assigns it together with
`isSealed: true`; `applyEvent` never invents it. It is also the only order
authority over the entry map: an all-digit entry id enumerates before every
string key in a JavaScript object, so map key order is neither insertion nor
file order, and derivations that need "the latest entry" select by `ord`.
Its sync and cache meaning is specified in [sync.md](sync.md).

The union has exactly these thirteen variants:

- `MessageEntry`, `kind: "message"`: `role` is `"user"`, `"assistant"`, or
  `"system"`, with `content: Content[]`. Assistant entries can carry
  provider/model, response metadata, usage, stop reason, an error message,
  and pi's recorded generation time (`durationMs`, nullable when pi did not
  record it). A `system` entry is pi's prompt-section diff, not a conversation
  turn: it carries eager `sectionNames`/`removedSectionNames` (for the
  collapsed summary) and the section text in `sections`, which is lazy.
- `ToolResultEntry`, `kind: "tool_result"`: `toolCallId`, `toolName`,
  `content: Content[] | null`, `details: JsonValue | null`, `isError`, and
  pi's recorded execution time (`durationMs`, nullable when pi did not record
  it). The bridge carries these durations verbatim from pi's messages; it
  performs no timing of its own.
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
  Extension-owned; the viewmodel renders it as an extension turn unless a
  bridge extension (the git stamp) claims the type.
- `CustomMessageEntry`, `kind: "custom_message"`: `customType`, nullable
  `content`, nullable `details`, and `display`. Rendered only when `display`
  is set.
- `UnknownEntry`, `kind: "unknown"`: `sourceType` and the raw `data` of an
  upstream entry type the projection cannot classify. Rendered as the
  unrecognized fallback so drift stays visible.
- `InternalEntry`, `kind: "internal"`: `sourceType` of a named upstream
  entry type the bridge deliberately does not render (context edits, usage
  records). Named rather than dropped so the silence is explicit.

`Content` is `TextContent`, `ThinkingContent`, `ImageContent`, or
`ToolCallBlock`. Text is eager. Thinking content has nullable `thinking`, and
a tool call has nullable `arguments`; those nulls mean that the value has not
been pulled on that wire path, not that the canonical value is absent. A
system message's `sections` is lazy the same way.

## Events, reconciliation, and seal

Two halves meet in the document.

`applyEvent(doc, event)` is the live half. It opens the form of the item in
flight under the id pi reserved for it (`isSealed: false`), streams content
into it, and updates status. Streaming text and thinking use `append`; partial
tool-call arguments use granular object and array diffs, with `append` for
string suffixes. Tool execution updates replace partial content or details. A
live event never writes an entry that already sealed: a delayed stream cannot
overwrite persisted content. Every event for a persisted item carries the
reserved `entryId`; one without it is dropped rather than addressed under an
invented identity, because a fabricated id can never be sealed and its entry
would never settle away. The one exception is a nested tool call
(`parentToolCallId`), which owns no entry at all: its outcome is recorded on
the result of the call that issued it.

`createEntryProjection` is the authoritative half, and the only entry
lifecycle: `refresh(snapshot)` installs pi's appended suffix, and `settle()`
removes live forms that never persisted. For every entry a refresh installs,
the persisted projection replaces whatever the document had under that id —
content, parent, timestamp, `isSealed: true`, and the file `ord` — or is added
when no event announced it (silent appends such as a label). A wholesale list
replacement (a fork or reload, observed as a version change) re-reads from
zero and reassigns every position. There is no pairing step and no identity
move: an entry's id is its identity, so sealing is a replacement, not a
rename.

`SessionManager.readEntries(from)` is the read boundary the host uses: one
synchronous snapshot of the appended suffix, the next position, the selected
leaf, and a version that changes when the ordered list is replaced wholesale.
The host reads it before attach, after events, after its own commands, and at
settle boundaries, so an event payload is never treated as proof that an entry
exists.

Status leaf, name, model, thinking level, context usage, and aggregate stats
are repaired in the same patch as the entries. A live form may extend the
leaf while it streams — but only while its parent chain reaches pi's
selected leaf or one of its ancestors: a live form parented onto a sealed
entry of another branch is not the selected continuation. When the run
settles, live forms with no persisted entry are removed and the leaf returns
to pi's. Aggregate stats describe the rendered branch, so they are re-derived
whenever an entry is installed or the selection moves — a branch switch with
no append still changes the path the totals describe. The session name is
re-derived when an installed suffix carries a `session_info` entry, so a
reopened session's title and a silent rename publish without their own event
(the rename event lands after the append and sets the same value). Idle
`setModel`, `setThinkingLevel`, and `renameSession` paths refresh without
waiting for another turn; `navigate` goes through the same refresh boundary
so the leaf, the branch statistics, and the recovery kind all describe the
newly selected branch. A refresh that finds nothing new installs nothing
and stays O(live forms): the host refreshes after every event, so copying or
enumerating the entry map there would put history-sized work on the token
cadence — and a refresh that installs a suffix copies the entry map once for
the whole suffix, never per entry, so a bootstrap-sized install stays linear.
Selected ancestry is cached across unchanged refreshes, including
while a live entry streams; a leaf change or entry-list version change
invalidates it.

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
`pull` request returns the current requested values. Pulling a live form
registers a live subscription for later patches on that path; pulling a sealed
entry is one-shot because it cannot change. The client mirror
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

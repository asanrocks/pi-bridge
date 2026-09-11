# ADR 07: Client Architecture

The companion reference document ([`07-adr-ref.md`](./07-adr-ref.md)) is the
original `dev-pi-web` ADR 02 written for the `packages/web` split-repo
attempt. This ADR adapts its decisions to our single `packages/bridge`
codebase, accounting for the PRD ([04-prd-web-ui.md](./04-prd-web-ui.md))
and the component model ([06-component-model.md](./06-component-model.md)).

## Context

The current `web/src/App.tsx` (~500 lines) is a debug dashboard: a flat
expandable entry list with a raw protocol inspector. It exercises the full
`BridgeClient` + `DocumentMirror` stack but uses `useState` + `setTick` for
re-renders, inline styles, and no ViewModel. The PRD requires a chat-style
UI with Markdown, action groups, streaming, branch navigation, session
sidebar, and pickers. The wire protocol (ADR 06) is a dual-channel
WebSocket: push (`replace` + `patch`) and RPC (typed verbs with `id`).
`BridgeClient` already wraps this in a browser-safe typed object.

**Foundation:** The Document is immutable-persistent (pure appliers, structural sharing, root-flip on every change — enforced in `core/document.ts`).
This ADR depends on the root-flip property for React selector
change-detection via `Object.is`.

The decisions below fill the gap between "we have a working protocol
client" and "we have the PRD's chat UI." They are client-side only —
protocol, daemon, and Manager concerns are owned by ADR 06, except for two
minor protocol addenda noted in §Protocol changes.

## Framework: React + streamdown

React is already in use. The additional dependencies are at exact versions:

- `zustand@5` — selector-based subscriptions on `useSyncExternalStore`.
- `streamdown@2.5` — markdown rendering built for streaming, using the
  `unified`/`remark`/`rehype` pipeline. Instead of replacing the entire
  DOM subtree on each chunk via `dangerouslySetInnerHTML` (the old
  `marked` approach), streamdown produces a HAST tree and reconciles it
  through React's JSX runtime — only changed text nodes and elements are
  patched. This eliminates the flicker that `dangerouslySetInnerHTML`
  caused during fast streaming.

  Two modes: `"streaming"` for in-progress (provisional) blocks, and
  `"static"` for sealed blocks. During streaming, `parseIncompleteMarkdown`
  handles unclosed code fences and partial formatting without breaking
  the DOM. Syntax highlighting via Shiki (`shikiTheme` prop, `render/shiki.ts` + `CodeSnippet`) — highlights once on seal in `streamdown`'s `"static"` mode; `"streaming"` mode skips it to avoid re-highlighting on every `append`.

  For single-line think previews (collapsed view), a tiny regex-based
  `parseInlineMarkdown` produces inline HTML for `dangerouslySetInnerHTML`
  on a single `<span>` — no flicker risk for a one-liner.

> **Overturned**: The old ADR chose `marked` + `marked-highlight` +
> `dangerouslySetInnerHTML` over the `unified`/`remark`/`rehype` pipeline,
> reasoning that the multi-pass pipeline (~200KB+) was the bottleneck, not
> the DOM write. Streaming proved this wrong: the `innerHTML` nuke-and-rebuild
> on every chunk causes visible flicker on fast appends, regardless of how
> fast the parser is. Streamdown keeps the pipeline but eliminates the DOM
> churn via incremental HAST reconciliation.

> **Removed**: `marked`, `marked-highlight`, `highlight.js`, `lowlight`.

## State: Zustand store holding a `Document` root

Changed from the ref ADR: the old "use `zustand`" section's example
store was an unrelated pattern. The current store shape is below.

The current `useState` + `setTick` approach re-renders the full component
tree on every `append` patch. Sub-50ms for a debug dashboard; not
acceptable for a chat UI where a single text block streams 200+ `append`
ops while the rest of the conversation must stay stable.

Zustand's selector-based subscriptions solve this: a `TextContent` component
subscribes to its own content slice. When an `append` targets that block,
only that component re-renders. The conversation above the fold and the
sidebar are unaffected.

**Store shape (actual `web/src/infra/store.ts`):**

```ts
interface ClientStore {
  document: Document; // root-flip (immutable-persistent) → Object.is change signal
  connection: ConnectionState; // {kind:"connecting"|"connected"|"reconnecting"|"unreachable"|"init_failed"}
  attachedInstanceId: string | null; // routing identity, stable across session switches
  draft: ComposerDraft; // idle|compose{id,text,initialText}|edit — survives collapse, per-session localStorage
  composerExpanded: boolean; // visual only; app keybinding drives "/" → expand
  focusedEntryId: string | null;
  expandedActionGroups: Set<string>; // "${firstEntryId}:${firstBlockIndex}"
  expandedSteps: Set<string>;        // "${entryId}:b${blockIndex}"
  uncappedDetails: Set<string>;
  frozenActionGroups: Set<string>;
  frozenSteps: Set<string>;
  loadingPaths: Set<string>;
  pullTick: number; // bumped on pull ingest/failure → wants re-render (wants-outbox)
  sessions: SessionInfo[]; sessionsHasMore: boolean;
  instances: InstanceInfo[]; cwdAllowlist: string[];
  models: ModelInfo[]; thinkingLevels: string[]; devMode: boolean;
  historyOpen: boolean; scrollToEntryId: string | null;
  notifications: Toast[];
  // actions: setConnectionState, syncInstances/clearInstance, append/replaceSessions,
  // applyReplace, toggleActionGroup/toggleStep/toggleUncapDetails, setDraft*/blurDraft/clearDraft,
  // setComposerExpanded, setFocusedEntryId, setLoadingPaths/bumpPullTick, migrateExpandKeys, toasts
}
```

`ConnectionState` is a discriminated union (TopBar chip + Launcher down-states), not a 3-string enum. `attachedInstanceId` replaced the earlier `activeSessionId/liveSessionId` pair (see §Multi-instance). `draft`+`composerExpanded` own the composer textarea durably; `pullTick` drives the wants-outbox loop.

**The store holds a `Document` root, not the `DocumentMirror` instance.**
The `BridgeClient` lives in `useConnection` (a `useRef`). On every `onPush`
frame, `BridgeClient` applies changes to its internal `DocumentMirror`, then
the store does `set({ document: bridge.mirror.document })`. The mirror is
plumbing; the store state is the root. This makes store tests trivially
driveable with hand-built Documents — no mirror, no WebSocket, no transport.

**UI state classification rule:** shared by two or more components → store;
otherwise `useState` in the owning component.

| State | Owner | Reason |
|---|---|---|
| `document`, `connection`, `attachedInstanceId`, `instances` | store | many consumers; Launcher + Sidebar + TopBar |
| `draft`, `composerExpanded`, `focusedEntryId` | store | Composer + keybinding layer + ConversationArea |
| `expandedActionGroups`, `expandedSteps`, `uncappedDetails`, `frozen*`, `loadingPaths`, `pullTick` | store | ConversationArea ↔ Action components + pull loop |
| `sessions`, `models`, `thinkingLevels`, `cwdAllowlist`, `devMode` | store | Sidebar and pickers read them |
| `historyOpen`, `scrollToEntryId` | store | HistoryPane ↔ ConversationArea |
| `sidebarOpen` (derived) | `useState` in Sidebar | local to one component |
| `userScrolledUp` | `useRef` in ConversationArea | local; never causes re-render |

Note: the original ADR listed `pickerOpen` for model/thinking dropdowns. The
implementation uses native `<select>` elements which have no open/close state —
no `pickerOpen` is needed.

### attachedInstanceId (replaces activeSessionId/liveSessionId)

Pre-multi-instance the store held `activeSessionId` (client-owned) vs `liveSessionId` (from `getDaemonInfo`). With N Managers the routing identity is `attachedInstanceId: string|null` — the Daemon-assigned instance id, stable across `switchSession` within the instance. `instances: InstanceInfo[]` (from `listInstances`) carries each instance's `sessionId/name/isStreaming/preview`. The live indicator in the Sidebar/Launcher derives from `instances`, not a single `liveSessionId` field (which no longer exists on the wire).

### Expand-state keys

ADR 06's `move` op renames provisional ids to pi ids on seal. If expand
state were keyed by `entryId` alone, a sealed entry would lose its expand
state — the `pending:message` key becomes stale and the committed entry
renders collapsed. Two mechanisms fix this:

1. **Action group keys use `${firstEntryId}:${firstBlockIndex}`** — the
   first step's source entry and block index. Since the visual spine can
   span multiple entries (textless-entry accumulation), the key is derived from the
   first step in the group, not the owning entry. Block indices are stable
   (append-only) and survive entry-id rename. Step keys:
   `${entryId}:b${blockIndex}`.
2. **`migrateExpandKeys(oldId, newId)`** — on every `move` op, the store
   rewrites keys in `expandedActionGroups`, `expandedSteps`,
   `frozenActionGroups`, `frozenSteps`, and `loadingPaths` that start
   with the old provisional id prefix to the new committed id. This is a
   pure reducer — tested as a unit function.

**Freeze on interaction.** During streaming, the trailing action group
auto-expands so the user sees actions as they appear. If the user
manually toggles a group or expands a step, that element is added
to `frozenActionGroups` / `frozenSteps` and streaming state no longer
drives it. Frozen sets are permanent — keys never collide across turns
because `migrateExpandKeys` rewrites provisional ids to durable ids.

### Sessions list refresh

The daemon rescans on `newSession`/`renameSession`/`switchSession`/`agent_settled` and pushes `sessions_changed` to all connections (cross-tab Sessions sync). The calling tab also applies `appendSessions`/`replaceSessions`. `instances` list is polling (`listInstances` every 5s in Launcher) — no `instances_changed` push. On mount and reconnect, the client fetches `getDaemonInfo` + `listInstances` → re-attaches via `switchInstance` if needed → `listSessions`.

## ViewModel: flatten + structure in `src/viewmodel/`

The ViewModel lives in `src/viewmodel/` — browser-safe, type-checked by
`tsgo` (in `src/`), verified by `check:browser-smoke` via a curated entry
import line. It is **not** in `web/src/`, which is only checked by `vite
build`. Tier-1 vitest tests cover it from `test/viewmodel-unit.test.ts`.

**Layer separation:**

```
core/          — wire types, document reducer, BridgeClient, DocumentMirror
viewmodel/     — flatten + structure, turn projection, sibling leaf-walk,
                 action summaries, move-migration reducer (all pure, browser-safe)
web/           — React components, useConnection, CSS modules
host/          — Manager, Connection, Daemon (node-only)
```

### Lazy fields

Architecture §1 defines the lazy fields on the wire:

| Field | Type |
|---|---|
| `ThinkingContent.thinking` | `string \| null` |
| `ToolCallBlock.arguments` | `JsonValue \| null` |
| `ToolResultEntry.content` | `Content[] \| null` |
| `ToolResultEntry.details` | `JsonValue \| null` |

**Text is wire-eager.** `TextContent.text` is `string` (never null) and
does not appear in `LAZY_FIELD_PATTERNS`. Compaction and branch_summary
`summary` fields are also wire-eager. Only thinking text, tool arguments,
and tool result content/details require client pull.

The Document's flat `Record<id, Entry>` goes through a two-step pipeline
before reaching the renderer:

```
Document.entries
  → flatten(doc) → FlattenedBlock[]   (pure-data descriptors, tool result joins)
  → structure(flat, doc) → ViewModel  (leaf-path walk, run merging, siblings)
  → render(ViewModel) → React          (consecutive-step detection → spine)
```

### Flatten step

Each entry in `Document.entries` produces zero or more descriptors. These
are plain data, not render types — they carry only the fields needed for
lazy pull (`entryId` + `blockIndex`) and display identity:

- **User MessageEntry:** one `TextBlockVM` per `TextContent`.
- **Assistant MessageEntry:** one descriptor per `Content` —
  `TextBlockVM` for text, `ThinkActionStepVM` for thinking, `ToolActionStepVM`
  for tool calls. For tool calls, look up `ToolResultEntry` by
  `toolCallId` and attach a `ToolResultSnapshot` (or `null` if result
  hasn't arrived yet).
- **CompactionEntry / BranchSummaryEntry:** store `summary` directly
  on the `SystemTurn` (wire-eager, no lazy pull needed).
- **Model change / thinking level change:** no descriptor (metadata-only).
- **ToolResultEntry:** skipped — already joined during the assistant
  message's `ToolActionStepVM` production. Never appears as a standalone
  turn.

### Structure step

Walk `status.leafId` → root via `parentId`, reverse for chronological
order, then collapse into turns. The structure step has access to the
full `Document` for entry-kind checks and sibling queries.

- **User messages** → `UserTurn`. All text blocks concatenated into
  `text`. Siblings computed from entries with same `parentId`.
- **Assistant messages** → `AssistantTurn`. Consecutive assistant entries
  merge into one **run**; the run closes at a user message, a system turn,
  a user bash execution, or the end of the path. Text blocks do NOT split
  the run: the per-message split experiment (8386faacf, later reverted)
  multiplied turns ~5x on real sessions for a cosmetic gain —
  `segmentBlocks` renders interleaved text/action groups in order within a
  turn. Metadata (model, usage, timestamp) from the last entry in the turn;
  stopReason/errorMessage ride the run-closing turn (its last ref is the
  entry's last block), so an error line renders once per run.
- **Turn timing** is per-run-window: `turnStartedAt` is the seal of the
  path entry preceding the run's first block (usually the user message).
  The window extends past the closing entry's seal to the latest sealed
  tool result of the tool calls the run issued, and toolMs subtracts the
  assistant-generation windows (per-batch max for parallel tools, not a
  per-tool sum).
- **System entries** (compaction, branch_summary, model_change,
  thinking_level_change) → `SystemTurn`. Compaction and branch_summary
  carry `summary` (markdown, wire-eager); model_change and
  thinking_level_change use a `detail` string.

Examples of turn structure:

```
Entry A: [think, read]   assistant   (textless → accumulates)
Entry B: [edit, bash]    assistant   (textless → accumulates)
Entry C: [text]          assistant   (text merges; run closes here)
→ AssistantTurn { blocks: [ThinkActionStep, ToolActionStep(read), ToolActionStep(edit), ToolActionStep(bash), TextBlock] }

Entry A: [think, text, bash]   assistant   (one entry — no split)
Entry B: [text]               assistant   (merges into the same run)
→ AssistantTurn { blocks: [ThinkActionStep, TextBlock, ToolActionStep(bash), TextBlock] }
```

Turn identity is `turnKey`: the first block's entry id when the turn starts
at block 0, else `${entryId}:b${blockIndex}`. With run merging a turn
always starts at block 0, so `turnKey === entryId` in practice — but React
keys and the previous-VM reuse map key on `turnKey` anyway (the mid-entry
form is kept so a future split rule cannot silently break identity), never
`entryId`. `entryId` stays the first entry's id (App.tsx focus/navigation
lookups match the FIRST turn of an entry).

### ViewModel types

```ts
interface ViewModel {
  turns: TurnVM[];
  leafEntryId: string | null;
}

type TurnVM = UserTurn | AssistantTurn | SystemTurn;

interface UserTurn {
  kind: "user";
  entryId: string;
  index: number;
  text: string;             // concatenated text content (TextBlockVM.text joined)
  siblings?: string[];      // entries with same parentId (for variant pager)
  currentSiblingIndex?: number;
  timestamp: string;
}

interface AssistantTurn {
  kind: "assistant";
  entryId: string;          // first entry of the turn (NOT unique — split
                            // entries share it; use turnKey for identity)
  turnKey: string;          // unique: entryId, or entryId:b<blockIndex> when
                            // the turn starts mid-entry (split entry)
  index: number;
  blocks: (TextBlockVM | ToolActionStepVM | ThinkActionStepVM)[];
  model?: string;           // from last entry in turn
  usage?: Usage;            // from last entry in turn
  contextPercent?: number;  // window occupancy when the entry was generated
                            // (input+cacheRead+cacheWrite / contextWindow);
                            // only on the turn starting at block 0 of its entry
  contextDeltaPercent?: number; // change vs. previous valid reading; omitted
                            // below 1pp (negative — compaction drop — always
                            // renders), across model switches, or when the
                            // chain was broken by invalid usage
  timestamp: string;
}

interface SystemTurn {
  kind: "system";
  type: "compaction" | "branch_summary" | "model_change" | "thinking_level_change";
  entryId: string;
  summary?: string;  // markdown, for compaction/branch_summary (wire-eager)
  detail?: string;   // for model_change/thinking_level_change
}

interface TextBlockVM {
  blockType: "text";
  entryId: string;
  blockIndex: number;
  text: string;             // always populated — wire-eager
  isProvisional: boolean;
}

interface ToolActionStepVM {
  blockType: "tool";
  entryId: string;
  blockIndex: number;
  toolName: string;
  toolCallId: string;
  arguments: JsonValue | null; // null until lazy pull; object = partial/final
  result: ToolResultSnapshot | null;
  summary: string;          // e.g. "read: src/main.ts"
  status: "pending" | "running" | "done" | "error";
}

interface ThinkActionStepVM {
  blockType: "thinking";
  entryId: string;
  blockIndex: number;
  thinking: string | null;  // null until lazy pull
  isProvisional: boolean;
}

interface ToolResultSnapshot {
  entryId: string;          // ToolResultEntry id (for lazy pull paths)
  isError: boolean;
}
```

### Action summaries

`ToolActionStepVM.summary` is computed during flattening from the tool name
and `arguments` (a `JsonValue` partial object), falling back to a truncated
raw string:

- `read`/`edit`/`write`: `path` argument → "read: src/main.ts"
- `bash`: `command` argument → "bash: npm test"
- `glob`/`grep`: `pattern`/`query` argument
- Unknown: first argument value, truncated

Status (`"pending"` | `"running"` | `"done"` | `"error"`) is derived from
the presence and content of `ToolResultSnapshot`. It affects the status
dot color, not the label.

### Sibling pager

For a user message U: `siblings = {e ∈ entries : e.kind = "message",
e.role = "user", e.parentId === U.parentId}`, sorted by timestamp. The
pager shows `< i / N >`. Clicking `<`/`>` navigates to the **newest leaf
in the sibling's subtree** (DFS max-timestamp, then max-id tiebreak), not
to the sibling user message itself. Assistant sibling pager is
**deferred** (regenerate variants are not surfaced in v1).

**Monolithic for v1.** Per the ref ADR lesson: "extract when the third
feature touches the same code path." v1 has flatten + structure +
siblings — three functions in one module. When tree sidebar or mode
selector force a fourth touch, split into `flatten.ts` / `structure.ts` /
`siblings.ts`.

## Components: turn-based dispatch

The renderer reads `ViewModel.turns`, not `Document.entries` directly.
The store-to-ViewModel boundary is an invariant — components never import
Document types.

```
App
├── TopBar          (hamburger sidebar toggle, inline-edit session name, history toggle)
├── Sidebar         (Instances + Sessions, live dot ●, active highlight ▌, switch on click, +new)
├── ConversationArea
│   ├── UserTurn        (tinted background, variant pager)
│   ├── AssistantTurn   (flat blocks: TextBlock | ToolActionStep | ThinkActionStep)
│   │   ├── TextBlock       (streamdown + Shiki, copy button)
│   │   ├── ActionGroupView (neutral group header + vertical spine of steps)
│   │   │   ├── ToolActionStep    (tinted band: summary + ▸/▾ caret, expandable details + white inset)
│   │   │   └── ThinkActionStep   (short: plain header; long: caret + expandable prose)
│   └── SystemTurn      (compaction/branch_summary: streamdown; model_change/thinking_level_change: plain text)
├── Composer        (fixed floating card, collapsed/expanded, draft=store, steer chips, tab-complete, model picker, cost popover)
└── HistoryPane     (docked right rail / drawer, lane graph, look vs go)
```

AssistantTurn renders a flat list of blocks. Consecutive `ToolActionStep`
and `ThinkActionStep` blocks share a visual spine grouped under a neutral
`ActionGroupView` header. A single-step group renders no group header —
the step's own summary is the label.

Group fold is renderer-owned: the renderer detects consecutive steps
and derives a group key from the first step's `${entryId}:${blockIndex}`.
It looks up `expandedActionGroups` and shows/hides the spine section.
Individual step expand keys (`expandedSteps`) control details visibility
within the spine.

`React.memo` is keyed on turn identity: each `TurnVM` holds a
reference-equality-stable `entryId` + block indices. Adding a new step
block appends to the trailing AssistantTurn's `blocks[]` array; only
that turn re-renders. Within the turn, each block subscribes to its own
content slice via Zustand, so streaming text updates re-render only the
active `TextBlock`.

### Streaming inside components

`TextBlock` subscribes to its content slice via a Zustand selector.
On each store update, the selector returns the freshest text string.
The `Markdown` component is `streamdown` (HAST reconciliation via React JSX, not `innerHTML` nuke-and-rebuild) with Shiki highlighting. During streaming `Streamdown` runs in `"streaming"` mode with `parseIncompleteMarkdown` for unclosed fences; on seal (`isProvisional` → false) it flips to `"static"` and Shiki highlights once. `React.memo` prevents stable siblings from re-rendering.

**Action group rendering.** Consecutive `ToolActionStep` and
`ThinkActionStep` blocks share a visual spine grouped under an
`ActionGroupView` header (▸/▾ fold + left-edge family dot legend +
categorized summary). The group label is computed from step summaries
during render. Band hues map to four color families (mutate = edit+write,
bash, think, read); the family dot legend and the per-step strips/tints
share the same `--kind-*` tokens.

**Thinking display.** Short thinking (no newlines, < 80 chars) renders as
a plain step line — no caret, text visible inline, not expandable.
Long thinking renders as a step header with a ▸/▾ caret; expanding
reveals the full markdown prose inline on the lighter think tint.

**Tool display.** Tool steps always render with a caret. Expanding
reveals a white inset details panel with syntax-highlighted arguments
and result content (if pulled).

**Group expand state.** The renderer derives group keys from the first
step's `${entryId}:${blockIndex}` in each consecutive group. The
effective expanded state: `expandedActionGroups.has(key) ||
(isStreaming && isTrailingGroup && !frozenActionGroups.has(key))`.
During streaming, the trailing group auto-expands — steps appear,
details stay folded. If the user manually toggles a group or expands a
step, that element is added to `frozenActionGroups` /
`frozenSteps` and streaming state no longer drives it. Frozen sets
are permanent — keys never collide across turns because
`migrateExpandKeys` rewrites provisional ids to durable ids. On
`isStreaming` → false, the group reverts to manual toggle state
(default collapsed).

### Picker and verb gating during streaming

While `status.isStreaming` + `status.isCompacting`, the only live action is
`abort` (Stop button). Specifically disabled:
- Model picker, thinking picker (G2)
- `navigate` variant pager (G5)
- `switchSession` sidebar clicks (G5)
- `newSession` button (G5)
- Send (prompt) — replaced by Stop

`renameSession` is allowed mid-stream (pi writes names eagerly).

## Connections: BridgeClient + WsTransport

ADR 06's `BridgeClient` is already implemented in `core/client.ts`. The web
UI creates one instance, wraps the browser `WebSocket` in a thin
`WsTransport` adapter:

```ts
const ws = new WebSocket(`ws://${location.host}`);
const transport = new WsTransport(ws);
const bridge = new BridgeClient(transport);
```

`BridgeClient` manages `DocumentMirror` internally. The Zustand store does
**not** hold the mirror instance. On every `onPush` frame, `BridgeClient`
applies changes to its `DocumentMirror`, then the store extracts the root:

```ts
client.onPush = () => {
  store.setState({ document: client.mirror.document });
};
```

Testing: store tests feed `set({ document: handBuiltDoc })` directly — no
mirror, no transport, pure state machine.

**Connection lifecycle hook** (`useConnection` + `pullLoop.ts` + `draftPersistence.ts`):
- Opens `WebSocket`, creates `BridgeClient`, wires to store (`client.onPush` → `store.set({document})` + `migrateExpandKeys` on `move`).
- On close: sets `connection: {kind:"reconnecting",attempt}` (discriminated union: `connecting/connected/reconnecting/unreachable/init_failed`), starts exponential backoff
  (500ms initial, ×2, cap 5s, full jitter), re-opens. The TopBar chip + Launcher down-state reads `connection`.
- On reconnect/mount: `getDaemonInfo` + `listInstances` → if stored `attachedInstanceId` still alive, `switchInstance(id)` → `replace` push → `listSessions` → pull loop drains wants-outbox for what's rendered. No auto-push on raw connect (fresh `Connection` has `attachedManager=null`).
- Text and compaction summaries are wire-eager and arrive in the `replace` snapshot — no pull gap.
- Expanded state is **preserved** across re-attach to the *same* instance — the wants-outbox re-drains and `loadingPaths`/`pullTick` restore the view. On `instance_exit` / instance switch, `clearInstance()` resets expand/frozen/loading/draft.

## Lazy pull (wants-outbox)

Architecture §1 defines four lazy fields on the wire:
`ThinkingContent.thinking`, `ToolCallBlock.arguments`,
`ToolResultEntry.content`, `ToolResultEntry.details`. Text and
compaction/branch_summary summaries are wire-eager — always populated.

Components declare wants during render by appending to a per-render wants outbox (`PullRequestItem[]`). The pull loop (`web/src/infra/pullLoop.ts`, `useEffect` after each render) drains the outbox: filter through `needsPull()` + `loadingPaths`, one batched `bridge.pull(requests)`, `ingestPullResponse` → `pullTick` bump → re-render. No component calls `pull` directly; expand handlers are pure store toggles (`toggleActionGroup`/`toggleStep`).

Provisional pulls register live subscriptions on the `Connection` (subsequent `append` patches forward until `move` seal); committed pulls are one-shot. `filterPatchForSocket` sanitizes parent-path op values for unsubscribed sockets (convergence invariant).

## CSS: CSS modules

Vite supports CSS modules with zero configuration. Replace constant inline
`style` objects with co-located `.module.css` files. Truly dynamic styles
(e.g., `style={{ background: computedColor }}`) are acceptable where CSS
class toggling would add complexity without benefit. Design tokens live in
`web/src/app/index.css` under the `@theme` block — the `--color-*`,
`--radius-*`, and `--fs-*` namespaces are the single source of truth for
color, radius, and font-size (referenced by CSS modules via `var(--…)`, by
Tailwind utilities, and read directly by streamdown's precompiled
styles.css). v1 is light-themed; the previous "dark theme only / light
deferred" line was stale. See §Styling invariants for the adherence rules.

## Build: existing Vite setup

No changes to `web/vite.config.ts` or `npm run build:web`. The build
produces `dist/web/`, served by the daemon's HTTP server. No HMR, no Vite
dev server — same binary in dev and production. Client rebuild (`vite build
--watch`) + manual browser refresh.

## Testing

**Tier 1 — vitest (pure, DOM-free; 23 files):**
- `test/viewmodel-unit.test.ts` — `computeViewModel`: leaf-path projection, run merging (text does not split), sibling computation + newest-leaf walk, action-summary extraction, move-migration reducer, timing.
- `test/tree-unit.test.ts` — `HistoryTree` / `LaneLayout` (Pass 1 + Pass 2).
- `test/accounting.test.ts` — `sessionAccounting` cost ledger.
- `test/store-unit.test.ts` — store selectors, expand-state key migration on `move` ops, `loadingPaths` dedup. Store tests drive `set({ document: syntheticDoc })` directly — no mirror needed.
- `test/compact-codec.test.ts` / `test/wants-outbox.test.ts` / `test/composer-draft.test.ts` / `test/model-ref-disambiguation.test.ts` — codec, pull orchestration, drafts, `ModelRef` dedup.
- Remaining unit files: `bridge-client`, `client-mirror`, `document-unit`, `convergence`, `integration-gaps`, `property-invariant`, `event-roundtrip`.

**Tier 2 — manual visual check (per review gate):**
- Scroll-follow behavior
- Action group auto-expand/collapse during streaming (trailing group rule)
- Reconnect banner + re-pull of expanded content
- Tab title transitions
- Copy button
- No leaked subscriptions (devtools network panel)
- Model/thinking picker disabled during streaming
- Abort (Stop button)
- Variant pager `< X / N >` navigation

No browser test runner for v1. Add when real temporal regressions are
observed.

## Protocol changes (ADR 06 addenda)

1. **`sessions_changed` push** — daemon pushes `{ sessions, hasMore }` on `agent_settled`/`renameSession`/`switchSession`/`newSession` (cross-tab Sessions sync; `instances` remains polling).

2. **Provisional `parentId` set at creation** in `applyEvent` (`message_start` (assistant), `tool_execution_start` → `doc.status.leafId`). Core producer change, not a wire change; keeps tree well-formed during streaming.

3. **`attachedInstanceId` routing** — `switchInstance`/`newInstance`/`killInstance` + `instance_exit` push + `listInstances` (see ADR 06 V2 addendum). `GetDaemonInfoReply` no longer carries `liveSessionId` (replaced by `InstanceInfo.sessionId` in `listInstances`).

## Rationale

### Why React and not a smaller VDOM lib

React is already the container framework (Zustand, CSS modules, event
handling). Markdown rendering uses `streamdown` (HAST reconciliation via React JSX) + Shiki, not `innerHTML` nuke-and-rebuild. `streamdown`'s `"streaming"` mode handles unclosed fences without DOM flicker; `React.memo` + selectors keep re-renders to the streaming block.

### Why Zustand and not `useReducer`+Context

`useReducer`+Context re-renders all consumers on any state change because
every patch mutates the whole `DocumentMirror` state. `React.memo` cannot
prevent this when the projection returns fresh array references each
patch. We need subscription-based selection from day one. Zustand is the
ergonomic implementation of that pattern on top of
`useSyncExternalStore`; it gives selector subscriptions without custom
store plumbing.

### Why the store holds a Document root, not the mirror

The `DocumentMirror` is a mutable wrapper that the `BridgeClient` owns.
Storing it as Zustand state would require every test to construct a mirror
and wire a transport. Storing the `Document` root instead lets store tests
drive `set({ document: syntheticDoc })` directly — the store is a pure
state box. The mirror lives in `useConnection` (an unexported `useRef`),
fed into the store's `onPush` callback. This is a refinement of the ADR's
original phrasing; the intent (one document, identity-flip change signal)
is preserved.

### Why a thin ViewModel pipeline and not modularized from day one

The Document's flat `Record<id, Entry>` is close to display-ready. The
remaining work is flatten (entry → descriptor) + structure (descriptor →
turns) + siblings — three pure functions in one module. Pre-modularizing
(`flatten.ts`/`structure.ts`/`siblings.ts`) before the third feature
touches the code path guesses module boundaries before the natural ones
are visible. The store↔ViewModel boundary — an invariant — is what lets
us modularize later without a rewrite.

### Why the ViewModel lives in `src/viewmodel/`, not `web/src/`

`web/src/` is type-checked by `check:bridge-web` (`web/tsconfig.json` — DOM lib, `react-jsx`, `vite/client` types), not by the root `tsgo --noEmit` (which excludes `web/`). `src/viewmodel/` gets the full gate: `tsgo`
(build-tool coverage), `check:browser-smoke` (no `node:*` imports), and the
existing vitest runner. It is browser-safe by construction — pure functions
operating on `Document` and `Entry` types from `core/`. The cost is a small
extra import line in `scripts/browser-smoke-entry.ts`.

### Why the connection lifecycle is its own seam

The `useConnection` hook wraps `BridgeClient` and owns the WebSocket
lifecycle. Auth, multi-instance routing, and reconnect all plug into the
connection step — if that logic lives in the store or a component, each
feature gets hard. Isolating it in a hook + `BridgeClient` keeps state
and rendering pure and keeps network/identity concerns in one place.

### Why lazy pull for non-text content

Architecture §1 makes thinking, tool arguments, and tool result
content/details lazy on the wire. Text is wire-eager (always a `string`).
The PRD says "reading is the primary activity" — text must be visible
without pulls. The lazy fields are hidden in steps by default and
pulled on expand — heavier and less-frequently accessed, exactly the
content laziness was designed for.

### Why cross-entry accumulation and strict in-order

The entry boundary is a producer detail — pi emits a new entry for each
model response. Rendering per-entry would show multiple consecutive
metadata bars and fragment the step spine across artificial boundaries.
Textless blocks (thinking/tool-only) accumulate into the turn the next
message closes, so a tool-dispatch cycle renders as one unit with the
message that follows it; the renderer detects consecutive steps and draws
the visual spine. Turn boundaries land on text ("a message always ends a
turn"), which gives readers a natural separation unit and keeps turn
evolution append-only across recomputes. This preserves block order,
handles interspersed text naturally, and hides entry boundaries that have
no meaning to the reader.

## Alternatives considered

### Modularized ViewModel from day one (rejected)

**Proposal:** structure the ViewModel as `flatten`/`structure`/`siblings`
from the start, matching pi-sitter's evolved form.

**Rejected:** extract when the third feature touches the same code path.
Pre-modularizing guesses module boundaries before the natural ones are
visible. v1 has three functions in `computeViewModel`; the modularization
happens when tree sidebar / conciseness modes force a fourth touch,
inside the ViewModel layer, not as a rewrite.

### `streamdown` + Shiki for Markdown (over `marked`/`dangerouslySetInnerHTML`)

**Adopted.** `streamdown@2.5` produces a HAST tree and reconciles through React JSX — only changed nodes patch, no `innerHTML` flicker on fast `append` streams. Shiki highlights in `"static"` mode; `"streaming"` mode uses `parseIncompleteMarkdown` for partial fences. Single-line think previews use a tiny regex inline parser. See §Framework.

### Optimistic client updates (rejected)

**Proposal:** client optimistically applies its own commands (shows a sent
message immediately).

**Rejected:** commands are server-acknowledged via push (`patch`/`replace`
from the Manager). No optimistic updates means no rollback logic. The cost
is a small delay before a sent user message appears (until the Manager
reconciles and pushes). Accepted for v1.

### Custom incremental streaming Markdown parser (rejected)

**Proposal:** incrementally parse streaming text into a persistent AST,
append nodes as chunks arrive, eliminate block-boundary flip.

**Rejected:** buys eliminating a sub-100ms boundary flip; costs a custom
streaming parser with real maintenance burden. Full re-parse behind block
isolation + `React.memo` is sub-ms for typical block sizes; the flip is
accepted as a v1 artifact.

### Vite dev server / HMR for development (rejected)

**Proposal:** run Vite's dev server in development, proxy the WebSocket to
the daemon.

**Rejected:** adds a dev-only architecture (dev server in front of the
daemon) that differs from production. The daemon must be the same binary
in dev and production so that the code exercised during development is the
code shipped. Client rebuild + browser refresh is fast enough for v1;
avoiding the proxy/dev-server seam is worth the slower feedback.

### Shiki on streaming blocks (gated)

**Gated:** Shiki (via `streamdown`'s `shikiTheme`) runs only in `"static"` mode (sealed blocks). Streaming uses `"streaming"` mode without Shiki to avoid re-highlighting on every `append`. One highlight pass per block on seal.

### PRD's "action group below assistant text" reordering (rejected)

**Proposal:** collect all `thinking`+`toolCall` blocks into a single action
group after all text, regardless of their position in `content[]`.

**Rejected:** loses information about where tools ran relative to text
output. Turn separation with strict in-order preserves block ordering.
The renderer detects consecutive steps for the visual spine. The PRD's
description is the common case, not the general rule.

## Invariants (client-side)

1. **Renderers read `ViewModel`, never `Document`.** The store-to-ViewModel
   boundary makes future features (tree sidebar, side pane) second
   projections over the same store.
2. **Every state update is pure-then-`set`.** Store mutations are pure
   (`migrateExpandKeys`, `toggleActionGroup`, ...); side effects (reconnect,
   pull, RPC calls) run outside the store via `useConnection` or component
   event handlers.
3. **Components are `React.memo`'d on their turn props.** Only the
   streaming text block re-renders on `append`. Three sub-rules make
   this hold:

   **3a. No component subscribes to `s.document.entries` internally.**
   `entries` is a new cloneSet on every patch (immutable-persistent root-flip).
   `AppInner` needs it for VM computation but is the sole subscriber.
   Every other component either receives stable TurnVMs as props or
   subscribes to individual content slices via entry-id-scoped selectors.
   A component that must read entries at event-handler time uses
   `getStore().subscribe` in `useEffect` to update a ref — the ref
   mutation does not trigger re-render.

   **3b. The `computeViewModel` structural key excludes display-only
   fields.** Only fields that change entry topology belong in the guard:
   leaf-derived `pathIds`, `statusName`, `statusModel`,
   `statusThinkingLevel`, `isStreaming`, `isCompacting`, and
   `activeSessionId`. Display-only fields like `stats` (token counts,
   cost) and `usage` have their own store subscriptions in leaf components
   and must not invalidate the VM cache.

   **3c. `computeViewModel` preserves `TurnVM` identity via immutable-persistent
   structural sharing.** When `doc.entries[id] === prevDoc.entries[id]`
   and the path-index is unchanged, return the same `TurnVM` reference
   from the previous call. This keeps `React.memo` effective for stable
   entries during structural changes (e.g. a new `tool_call` appended at
   the leaf — only the new entry gets a new component, all prior entries
   reuse their cached VM references).

   **3d. Markdown renders via `streamdown` + Shiki.**
   `streamdown` reconciles HAST via React JSX; `"streaming"` mode handles partial markdown without `innerHTML` flicker, `"static"` mode highlights once on seal via Shiki. The Zustand selector always reads the freshest text; `useSyncExternalStore` ensures no stale renders.

4. **No code constructs wire frames by hand.** `BridgeClient` is the only
   place that touches the envelope (from ADR 06, invariant 15).
5. **The store holds exactly one `Document` root** (the attached instance's document), not a session-keyed
   map. The `DocumentMirror` instance lives in `useConnection`, not in the store.
6. **Lazy pull on expand, never eagerly.** Thinking text, tool arguments,
   and tool result content/details are lazy on the wire. They are pulled
   when the user expands a heading or group. Text and compaction summaries
   are wire-eager — no pull needed. `needsPull` + `loadingPaths` prevent
   redundant requests.

## Styling invariants

Visual-consistency invariants for `web/`. Softer than the render/store
invariants above — violations degrade consistency rather than correctness —
but they compound as surfaces multiply, so each is load-bearing once more
than one component uses it. Design tokens live in `web/src/app/index.css`
(`@theme` block: `--color-*`, `--radius-*`, `--fs-*`); the per-role spec
values live as comments at each rule site in the CSS modules.

1. **Design tokens are authoritative for color, radius, and font-family.**
   No literal `white`, `monospace`, or hex where a token covers that role;
   no runtime `color-mix` for a hover shade that should be a token. If a
   role lacks a token, add one to `@theme` rather than inlining a literal.
   - Solid-bg button hover/active darkens to a named `-hover` token
     (`--color-accent-hover`, `--color-error-hover`), never `opacity`
     dimming or `color-mix`. Opacity reads as "fading/disabled," not
     "pressed."
2. **Inline elements size relatively (em/%); container-level surfaces own
   their absolute baseline.** An inline `<code>` or chip must track its
   parent's font-size (e.g. `0.8125em`) so it isn't pinned at body-size
   inside a heading. `pre`, cards, and inputs own a baseline and may use rem
   or a `--fs-*` token. The `pre code` reset (`font-size: inherit`) owns
   block code; inline code owns its own ratio.
3. **One spec per semantic role.** Primary CTA, header icon action,
   row-delete button, chip — each role has a single canonical spec shared
   across every surface; a new instance references it rather than inventing
   a fresh rule. The spec values (e.g. primary CTA = `min-height: 36px`,
   `padding: 8px 16px`, `font-weight: 600`, `radius-md`) are mutable; the
   load-bearing constraint is one spec per role.
   - Tap-target min-heights are a floor that doesn't decrease at smaller
     breakpoints. Mobile density comes from layout (wrap/hide secondary),
     not from shrinking primary controls.
4. **Third-party-rendered content inherits the app's canonical element
   styling in every host context.** Streamdown emits default Tailwind
   classes on its elements (inline `<code>` = `rounded bg-muted px-1.5
   py-0.5 font-mono text-sm`); any `<Markdown>` host that doesn't scope an
   override bleeds that default. Every Markdown host — `.markdownContent`,
   thinking collapsed/heading/expanded — must scope the same chip/code
   treatment, or there is one global rule. The failure mode is the same
   element rendering differently when a thinking block expands/collapses.

## Deviations from the original ADR 07 (before resolution)

| Original ADR 07 | Resolved |
|---|---|
| Store holds `DocumentMirror` in state | Store holds `Document` root; mirror in `useConnection` ref. Intent preserved; testability improved. |
| `expandedFoldGroups: Set<entryId>`, `expandedCards: Set<entryId:cardIndex>` | Renamed to `expandedActionGroups` / `expandedSteps`. Keys `${firstEntryId}:${firstBlockIndex}` and `${entryId}:b${blockIndex}`. Added `frozenActionGroups` and `frozenSteps` for freeze-on-interaction. |
| `activeSessionId` sourcing unspecified | `activeSessionId` = client-owned; `liveSessionId` = daemon-owned (new wire field). V1b-future-proof seam. |
| ViewModel loosely in "the web client" | `src/viewmodel/` — tsgo, browser-smoke, and vitest-gated. |
| Provisional parentId null, tree malformed during streaming | Producer fix: set `parentId = leafId` at creation in `applyEvent`. |
| Uniform per-component pull | Text is wire-eager (always populated) — no pull needed. Non-text fields (thinking, arguments, tool results) are wire-lazy and pulled on expand. |
| Reconnect resets expanded state | Preserved; batched re-pull restores. Lossless. |
| Reconnect backoff unspecified | 500ms ×2, cap 5s, full jitter. |
| Picker/mutation verb gating during streaming unspecified | All pickers + navigate/switch/new disabled during streaming; only abort + rename live. |
| Sessions refresh on every RPC reply | Daemon rescans on mutation; reply carries updated list. Cross-tab stale — deferred ("refresh browser"). |
| No move-migration for expand keys | `migrateExpandKeys(oldId, newId)` reducer rewrites keys on seal. |
| Invariant 3 unenforced — `React.memo` silently defeated by new references | Sub-invariants 3a-3c keep props stable: no `entries` subscriptions, display-only fields excluded from VM key, TurnVM identity preserved across recomputations. 3d: markdown renders via `streamdown` + Shiki with streaming/static modes. |

## V2 Addendum: Multi-instance changes (2026-07-21)

The multi-instance PRD promotes the daemon from single-Manager to N Managers
(instances), one per cwd, each running one session. A Connection attaches to one
instance at a time; switching rebinds without killing the source.

### Store changes

| Was | Now | Reason |
|---|---|---|
| `activeSessionId: string \| null` | `attachedInstanceId: string \| null` | Routing identity by instance id (stable across session switches) |
| `liveSessionId: string \| null` | *(removed)* | Replaced by `InstanceInfo.sessionId` in `listInstances`; live dot now from `instances[]` |
| *(missing)* | `instances: InstanceInfo[]`, `cwdAllowlist: string[]` | Alive instances + allowed cwds from `getDaemonInfo`/`listInstances` |
| `connection: "connected"\|...` | `connection: ConnectionState` (5 kinds) | Discriminated union for TopBar chip + Launcher down-states |
| *(missing)* | `draft: ComposerDraft`, `composerExpanded`, `pullTick` | Durable composer + wants-outbox |
| `syncSessionState(partial)` | `syncInstances(partial)` / `clearInstance()` | Multi-instance attachment lifecycle |

### Reconnect sequence

Old: "1. replace push → 2. getDaemonInfo → 3. listSessions → 4. re-pull."

New: "1. getDaemonInfo + listInstances → 2. if stored attachedInstanceId in list,
switchInstance(id) → replace push → 3. listSessions → 4. pull loop drains wants-outbox."

The `replace` push is now a consequence of re-attachment (`switchInstance`), not automatic. Client
state (`attachedInstanceId`) persists across reconnect in the Zustand store; on
transport re-open, the client drives re-attachment. If the stored instance is no
longer alive (cross-tab kill while disconnected), the client falls to Launcher ("No instance selected"). No server-side per-Connection memory across
transport reconnects (§7.10 holds literally).

### `instance_exit` push handling

The client's `onPush` handler recognizes `kind: "instance_exit"` and calls
`clearInstance()` (nulls `attachedInstanceId`, resets document to empty,
clears expand/frozen/loading/draft). The Launcher renders. No toast — per the PRD.

### ADR 07.5 invariant framing

The literal rule (store holds exactly one Document root) still holds. The
parenthetical "v1 is one session per browser context" is updated to "the store
tracks the attached instance's document." A single root still suffices because
the store only holds the *attached* Manager's document; switching instances
replaces it via `replace` push.

### Reconnect framing

`switchInstance` is not a transport reconnect — the WebSocket stays open; only
the attached Manager changes. §7.10's literal scope (transport close+reopen) is
unaffected. Expand keys are cleared by `clearInstance` on `instance_exit`, so
no stale-key leak across instance switches. Retaining expand keys across `replace` to the *same* instance is preserved (re-pull restores view).

# PRD: pi-bridge Web UI

A browser-based session viewer for pi-bridge. Replace the current debug
dashboard with a usable conversation interface.

## Who this is for

Developers using pi who want to:

1. **Explore a codebase.** Browse files, read implementations, understand
   structure. The agent does the searching; the user reads and decides.
   Reading-heavy, low-interaction.

2. **Author documentation.** Write docs interactively with the agent.
   Chat on the left, a live-rendered document on the right. One document at
   a time, not a multi-tab IDE.

3. **Monitor implementation.** Watch what the agent is doing: think traces,
   tool calls, file edits, shell output. Catch misunderstandings early
   without staring at a terminal firehose.

4. **History and retry.** Commit the edited documents. Revert agent edits
   that went wrong. Rewind the conversation and try a different prompt.

## Design principles

1. **Reading is the primary activity.** The conversation is the content;
   chrome is minimal. Text is long-form, well-typeset, left-aligned.

2. **Document-like, not IDE-like.** Light background, proportional body
   font (desktop ≥16px — the WCAG reading baseline; the prior 14.4px was
   IDE-density and undercut long-form reading. Mobile drops to 14px below
   the 48rem measure cap — defensible at the shorter mobile viewing
   distance, and the narrower viewport rewards density), warm off-white
   page tone.
   Monospace for content that is literally code or terminal I/O;
   proportional for chrome and annotation. Text hierarchy (foreground >
   secondary > muted) clears WCAG AA 4.5:1 on both the page and the
   warmer sidebar surface.

3. **Non-text actions are folded by default.** Tool calls and thinking
   blocks collapse into an action group. Text always renders inline at
   its natural position in the content order.

4. **User intent wins over automation.** If the user manually toggles an
   action group or expands an action during streaming, that element
   freezes — automation no longer overrides the user's choice.

## Mental model

**Chat-style**, similar to Claude Web. User and agent messages flow in a
single scrollable column. Agent tool use appears as lightweight action
groups that expand in-place. v1 focuses on reading, editing past messages
to create forks, and inspecting actions on demand.

**Multi-instance.** The daemon is a background server bookkeeping N pi
instances (projects), each bound to a cwd from a startup allowlist, each
running one session. Multiple instances can share a cwd (concurrent
sessions per directory). A browser tab (Connection) attaches to one
instance at a time; switching rebinds without killing the source. On
connect, a tab auto-attaches when exactly one instance is live; at zero
it seeds one instance per allowlist cwd (each resuming that cwd's most
recent prior session) and attaches to the last; at more than one it lands
on the Launcher (instance rows + create + connection health).

## Layout

Three-column fixed-chrome shell. The conversation column is a scrollable
document; the left Sidebar and right HistoryPane are fixed rails that span
the full viewport height; the top bar spans only the middle column (its
left/right edges clear the two side-pane gutters). Both side panes toggle:
closed = the conversation reclaims the gutter. Messages flow top to bottom.
A fixed composer bar occupies the bottom of the viewport — never scrolls
with the document (see Composer section).

```
┌──────────┬──────────────────────────────────┬─────────────┐
│☰ Inst[+] │ pi/bridge · Implement pi-bridge  │⟳ History  ×│
│          ├──────────────────────────────────┤             │
│▌Impl…  × │  ┌────────────────────────────┐  │ ● "Set up"  │
│  Fix…  × │  │ 14:32 You   [Copy] ◀ 1/2 ▶ │  │ │\          │
│  Pub…  × │  │ Fix the buffer overflow…    │  │ ●│"Fix buf" │
│          │  └────────────────────────────┘  │ ●│"Fix ok" ◀│
│ Sess  [+]│  14:33 openrouter/glm-5.2 [Copy] │ ● "Tests"   │
│ ─Today ─ │  The buffer overflow is in …     │             │
│  Refactor│  ▾ read, read, edit, bash        │             │
│  Write…  │                                   │             │
│ ─Week ── │  ── Context compacted: 12k → 8k ─│             │
│  Init…   │                                   │             │
├──────────┴──────────────────────────────────┴─────────────┤
│ · Type a message...                                        │
└────────────────────────────────────────────────────────────┘
```

Below 768px both side panes become slide-over drawers (left/right
respectively) with a dismiss backdrop; the top bar spans the full width.

### Top bar

Spans only the middle column (clears the Sidebar gutter on the left, the
HistoryPane gutter on the right):

  \[☰\]  pi/bridge · multi-session  \[⟳\]

  ☰ toggle left Sidebar    ⟳ toggle right HistoryPane

Session name is editable (click to type, Enter to save, Escape to cancel).
Each side pane's toggle sits on its own edge of the top bar (hamburger left,
history right) — symmetric with the pane it controls.

### Sidebar

Dual-mode collapsible panel: inline column ≥768px (full viewport height,
left rail), slide-in overlay below. The overlay is a fixed left-attached
panel over a dimmed, click-to-close backdrop; open/close persists in
localStorage. Two sections: **Instances** (running pi instances) above,
**Sessions** (dormant conversation files for the attached instance's cwd)
below.

```
┌──────────────┐
│ Instances [+]│
│▌● Impl…    ×│  attached: accent bar + live dot; × always shown
│ ● Fix docs… ×│  dot: green idle, orange+pulse while streaming
│ ● Publish…  ×│  ×: hover-reveal (desktop), always (touch)
│              │
│ Sessions  [+]│
│ Today        │  quiet sentence-case label — no hairlines
│   Refactor  15│
│   Write docs 30│
│ This week    │
│   Init proj 2hr│
│ ↻ Load more… │
└──────────────┘
```

- **Instance row**: a live dot + session name (or cwd placeholder if
  unnamed) + kill `×` on every row. The dot is green idle, orange +
  pulsing while the instance streams — the cue that distinguishes live
  Instances from dormant Sessions. The attached instance carries an
  accent left-bar + accent-tinted background; its `×` is always shown,
  others are hover-revealed on desktop (always on touch). Truncated
  names reveal the full text via a tooltip. No per-row cwd — names are
  distinctive in practice.
- **Sessions list**: paginated, time-bucketed (Today / This week /
  Earlier), relative timestamps. Default fetch 10 (newest first).
  Live-in-some-instance sessions are not here — they're in Instances.
  Click a dormant row → `switchSession` on the attached instance
  (current session saves to disk, joins this list).

Hierarchy is gap + typography only — no internal hairlines. Section
headers (Instances / Sessions) are bold uppercase; group labels (Today
/ This week) are quiet sentence-case, flush, sitting closer to their own
rows than to the block above. Sections separate by a larger gap than
groups; rows are tightest. On narrow screens, selecting an instance or
session auto-closes the drawer, and safe-area insets keep content clear
of notches and the home indicator.

#### [+] buttons

- **Instances `[+]`**: opens a floating cwd popover (anchored to the
  button, clamped to the viewport) when the allowlist has >1 entry;
  creates directly when == 1. Spawns a new pi instance bound to the
  picked cwd, with a fresh empty session.
- **Sessions `[+]`**: existing `newSession` on the attached instance —
  switchSession to a new empty session (current one saves to disk).
  Disabled when no instance is attached.

#### Initial state (Launcher)

On connect the tab picks its target: if it was already attached to a
still-live instance, it resumes that; else if exactly one instance is
live, it auto-attaches; else if zero are live and the allowlist is
non-empty, it **seeds** — creates one instance per allowlist cwd, each
resuming that cwd's most recent prior session (fresh on first use), and
attaches to the last. The empty Launcher is only seen when seeding
fails or the allowlist is empty.

The **Launcher** (shown for >1 live instances, or the 0-instance
fallthrough above) lists live instances (live dot + name + cwd +
relative time + first-message preview + kill ×), offers a create
affordance (direct when the allowlist has one cwd, a cwd popover
otherwise), and a full-panel treatment for any connection-down state
(Connecting / Reconnecting (N) / Can't reach / Daemon unresponsive)
with a manual Retry. It polls `listInstances` every 5s for liveness.

#### Multi-instance rules

- **Allowlist**: daemon accepts `--allow <dir>` (repeatable); with no
  flags it defaults to `[process.cwd()]`.
- **Instance switch mid-stream**: allowed. Detaching from a streaming
  instance doesn't abort it — the stream continues server-side;
  re-attaching later shows the (possibly completed) result. Session
  switches *within* an instance still abort (an instance runs one
  session); disabled mid-stream.
- **Cross-tab kill**: the attached Connection gets an `instance_exit`
  push (clears to the Launcher) and `sessions_changed` is pushed on
  settle/rename/switch/new. There is no `instances_changed` push, so
  other tabs' Instances list is stale until they re-query (the Launcher
  polls every 5s).

### History pane

Docked right rail (desktop, full viewport height) / right drawer (mobile,
slide-over + backdrop). Toggled from ⟳ at the top bar's right edge (or
`Ctrl/Cmd+H`). A persistent reference, not a transient action — it stays
open across navigation, recomputes its layout from the document each render,
and does not capture the keyboard (app shortcuts stay live while it's open).

Shows user-message branches with lane-based layout and draft collapse:

```
● "Set up project"           09:12
│\
● │ "Fix buffer overflow"    09:15
│ ● "Add unit tests"         09:16
● │ "Fix accepted"   09:18  [+2]  ◀
│ ● "Tests pass"             09:20
```

 ● on-path (tinted)  ○ off-path  ◀ current leaf
↕ lane per fork; active path = straight spine
[+N] = N consecutive aborted dead-end siblings collapsed into this keeper

Click semantics are decoupled into **look** and **go**:

- **Idle:** click a node → navigate to its subtree's newest leaf **and**
  anchor-scroll the conversation to the clicked message.
- **Streaming:** on-path nodes do **look-only** — anchor-scroll, no branch
  (they're already on the active branch, so `go` is a no-op; and branching
  mid-stream rewrites `agent.state.messages` and races the in-flight turn).
  Off-path nodes are disabled with a "jump after reply" tooltip until the
  reply settles. The anchor pauses bottom-follow so the streaming delta
doesn't yank the viewport back to the bottom; scrolling back to the bottom
re-arms it.

### Conversation area

Scrollable single column, top to bottom. User turns are full-width tinted
bands (hairline top/bottom borders); assistant turns are flat — "you wrote
this" vs "the model wrote this." Both share horizontal padding so headers
and text align. Markdown throughout (syntax highlighting, GFM tables,
per-code-block copy buttons). System entries (compaction, branch summary,
model change) render as compact centered dividers.

```
  14:32 You · thought 3s        ⧉  ◀ 1/2 ▶  ✎   ← header: ts · role · timing | toolbar (hover)
  Fix the buffer overflow in src/main.      ← user turn (tinted band)

  14:33 openrouter/glm-5.2 · working 4s · 2 running   ⧉   ← assistant (streaming)
  The buffer overflow is in `process`...
  ▾ read, read, edit, bash

  14:33 openrouter/glm-5.2 · worked 12s · tools 4s   ⧉   ← assistant (sealed)

  ── Context compacted: 12k → 8k tokens ──    ← system divider
```

- **Header:** timestamp then role then timing. User = `You`; assistant =
  `provider/model` (e.g. `openrouter/glm-5.2`) — "pi" had no density. No
  turn numbers.
- **Timing** (muted, after the role, separated by `·`): a wall-clock fragment
  derived from entry seal timestamps (set at `message_end`). User turns show
  `thought for Xs` — the gap from the most recent ASSISTANT completion
  (across all branches, not just the leaf path) to this send. Anchoring on
  the previous assistant message — not the leaf-path predecessor — means
  re-editing history message A into A0 (a fork whose on-path predecessor is
  absent) still anchors on the old branch's leaf assistant (D), so the
  interval reads A0 − D, not "nothing". Omitted when no assistant has
  completed before this send (the first turn). Assistant turns show
  `worked for Xs · tools Ys` once sealed: total spans the user-send to the
  last seal; `tools` is the remainder after subtracting Σ assistant-
  generation windows, so parallel tools count once (per-batch max, not a
  per-tool sum); `tools` is omitted when <1s. While streaming, the header
  shows a live `working for Xs · N running` instead — a client-clock tick
  (server seals don't exist mid-turn) plus the count of tool calls without
  a sealed result; both swap to the authoritative server-based values at
  seal.
- **Toolbar on the header line** (not the bottom): top-anchoring keeps the
  pager put when branch content height changes. Hover-revealed on
  hover-capable inputs; always visible on touch (`@media (hover: none)`).
- **User toolbar:** `⧉` copy · `◀ X/Y ▶` (siblings only) · `✎` edit-to-fork.
  Glyph buttons carry `aria-label` + `title`. The assistant turn header has
  no toolbar.
- **Copy** copies the message's text (markdown source). On user turns it
  sits in the header toolbar; on assistant turns — where a run holds several
  messages — each text segment carries its own Copy chip (same `.toolbarBtn`
  style), floating at the segment's top-right, hover/focus-revealed, always
  visible on touch.

### Action groups

Assistant messages interleave text with non-text actions (thinking
blocks and tool calls). Text always renders inline. Consecutive
non-text actions form an **action group** — a neutral collapsible strip
that, when expanded, reveals a vertical list of **steps**, one per action.

A step is a full-width tinted region whose **hue marks its color family**.
Four families, three tiers:

| Family | Kinds | Tier | Hue |
|---|---|---|---|
| mutate | edit, write | stand-out | rose |
| bash | bash | stand-out | amber |
| think | think | neutral | cool slate |
| read | read | dimmed | gray |

edit + write share the mutate hue (file mutation); the label and details
still distinguish them, only the band hue merges. The family color's
saturation/value carries the tier — one tint strength for all bands.
The tint is the visual landmark separating "backstage" actions from
the prose — the eye skips the whole tool zone as terrain, not as a
list of items. Every band carries a **3px left strip** in its family
color (no exceptions — the read strip is dimmed but present, so the
band anatomy is uniform). The per-action **status dot is retired**: the
agent self-corrects, and the turn-header timing already signals
in-flight work — status is not surfaced as color.

Each step folds between an **ActionSummary** (the one-line `kind: detail`
label — path basename, command, etc.) and **ActionDetails** (the expanded
content). A single-step group renders the same header as a multi-step
group — one dot and the step's own summary — so a lone action rests in
the same collapsed dot-row state as a folded group. Opening it
auto-expands the lone step's details so the band shows without a second
click.

Fold affordances — three gestures in three places:

- **Group header**: `▸`/`▾` at the start, then a **left-edge dot legend**
  (one dot per family present, always visible), then the summary. Folds
  the whole group. Dots use the same family tokens as the band
  strips/tints — one vocabulary across group and step.
- **Step header**: `▸`/`▾` at the start of the tinted row. Folds the
  step's details.
- **Long details**: a `▾ show all` chip at the **header right**
  (sub-expansion) for details clipped by the 300px cap — distinct from
  the step fold.

The group label categorizes actions by tool type, sorted by precedence
(edit > write > bash > read > think — the dot legend collapses
edit+write to one mutate dot, so the family order is mutate > bash >
read > think), deduped and truncated:

  edit: main.ts, buffer.ts, +1 more · write: notes.md · bash: npm install · read 3 files · think

- **edit / write**: file basenames, deduped, alphabetically sorted, first 3 shown
- **bash**: key commands extracted (splits on `&&`/`;`/`|`, skips trivial
  commands like `cd`/`ls`/`echo`), first 2 shown
- **read**: file count
- **think**: single label

**Cross-entry merging.** pi emits separate entries per tool-dispatch
cycle; the UI merges consecutive entries whose content is exclusively
non-text actions into one group. Text in any entry breaks the group and
anchors the preceding one:

```
Entry A: [think, read]   Entry B: [text, bash]

  ▸ think, read: main.ts
  The buffer overflow is in `process`...
  ▸ bash: npm test
```

### Action details

Each expanded step wraps a **white inset panel** — code/diff/output sit
on an opaque `--color-background` surface inside the tinted step, so
syntax colors keep their neutral backdrop regardless of the surrounding
hue. There is **no annotation line** — the step header (`edit: main.ts`)
is the sole identifier; the details are just its content.

| Kind | Body |
|---|---|
| `read` | Syntax-highlighted file contents. |
| `write` | The written content, highlighted once the path determines the language. |
| `edit` | Unified diff: interleaved -/+ lines (GitHub style), word-level inline highlight on single-line changes. |
| `bash` | REPL: `$ command` lines, then output. Multi-line commands indent continuation; command and output separated by a blank line. |
| `grep`/`find`/`ls` | Argument key-value rows (no result card). |
| other | Fallback: argument key-value rows, thin divider, highlighted raw output. |

**Thinking** is prose, not an operation, so it is the exception: its body
flows inline on the (lighter) step tint — no white panel. Single-line
thinking is static (nothing to expand); multi-line folds to a first-line
preview with a ▸/▾ triangle.

Expanded step details are capped at 300px; the header-right ▾ show all
chip removes the cap. Streaming content renders as it arrives — bodies
are not gated on the "annotation" argument (path/command), so a `write`
whose `content` streams before its `path` shows the content live.

### Composer

The composer is a **fixed, floating card** at the bottom of the viewport —
never scrolls with the document. It is the one piece of *active* chrome
(the input affordance), deliberately elevated above the passive reading
surface: a brighter surface tone (`--color-surface-raised`), a rounded
card (`--radius-xl` = 16px), and a soft **layered elevation** — a
barely-there 0.5px hairline ring plus a low-alpha drop shadow. The drop
is symmetric (`0 4px 24px`) rather than upward-biased: the card is
bottom-anchored, but at these low alphas the visible upper spread of the
drop still reads as lift, and the symmetric soft halo matches the Claude
aesthetic. Two independent axes animate it — hover firms the ring, and
`:focus-within` deepens the drop — so focus reads as "elevated more," not
just hovered. This is the intentional exception to the "document-like,
minimal chrome" principle: the elevation separates "where you type" from
"where you read." Two visual modes: **collapsed** (a 44px bar with a
status dot and placeholder) and **expanded** (an auto-height textarea
plus a control row). Two behavioral overlays drive auto-expand and
auto-collapse on top of the expanded mode: **streaming** (auto-expand on
turn start, Send stays and a red Stop button appears alongside it,
auto-collapse on turn end) and **editing** (auto-expand with a pre-filled
message, Escape cancels).

**Collapsed (idle).** A single 44px bar inside the floating card, guttered
from the viewport edges so the card's elevation reads. Left: a small
status dot with the placeholder "Type a message...". No control row, no
token metrics, no model picker — absolute minimum visual weight. (The dot
lives here only — the expanded control row conveys state via its buttons,
so the dot would be redundant there.)

   ┌──────────────────────────────────────────────┐
   │ · Type a message...                          │
   └──────────────────────────────────────────────┘
     ↑ guttered, rounded card; layered elevation
       (hairline ring + soft drop) lifts it above the page

Clicking anywhere on the bar, or pressing `/`, expands the composer and
focuses the textarea.

**Expanded.** The bar grows to an auto-height textarea plus a control
row beneath it. The textarea auto-grows up to 40% of the viewport
height, then scrolls internally, and is borderless (no divider, no focus
underline). The control row — context %, context bar, a **cost button**
(token breakdown behind a popover), a **model picker** button, Send, and
Stop — renders in proportional sans at `--fs-xs`, dimmed to
`--color-muted-foreground` so it reads as chrome rather than competing
with the textarea's 16px foreground text. The left group is ordered
context-first (context %, context bar, cost): context is the actionable
metric (compaction risk), cost is a ledger. Mobile and desktop share
this element layout; under 640px only the presentation changes — the
context bar hides and the model button swaps its live name for a fixed
`Models` label (a truncated model name carries no information, and
mobile use is read/monitor rather than configure; the active model is
visible in the picker, which highlights the selection). There is no
status dot here;
streaming is conveyed by the Stop button that appears alongside Send,
and disconnection by a disabled Send. The textarea is a controlled view
onto a store-owned `draft` (idle / compose / edit), so its content
survives composer collapse, blur, and page refresh — see **Drafts**
below. Blurring a compose draft with no text recedes to idle; with text
it keeps the bar expanded (content is important state).

**Focus.** The textarea's `:focus-visible` outline is suppressed; focus
is carried by the card's `:focus-within` elevation (the drop deepens),
which keeps the borderless input borderless. Other controls (model
picker, Send) keep the standard `:focus-visible` outline for keyboard
users.

   ┌──────────────────────────────────────────────┐
   │ The actual fix should go in process()...     │
   │                                              │
   ├──────────────────────────────────────────────┤
   │ [███░]45%  $0.014▾   gpt-5 high ▾   ▶        │
   └──────────────────────────────────────────────┘

**Streaming.** On turn start, the expanded mode auto-opens. Send
stays available (submitting during streaming queues a steer); a red
Stop button appears **alongside** Send rather than replacing it. The
textarea remains editable. In the expanded row, streaming is conveyed by
that Stop button; in the collapsed bar, the dot pulses orange (though
streaming usually auto-expands first). The bar stays expanded through
the turn; it recedes to idle on blur or Escape when the draft is empty.
A draft typed during streaming is preserved (the draft lives in the
store, not the textarea, so it survives collapse). The green dot
returns when collapsed.

**Steering.** Submitting while the model streams queues a steer rather
than starting a new turn — each queued steer shows as a draft chip above
the textbox, preserved in order. The chips are discardable (clears all
pending). Stop halts the current generation; any pending steers are
salvaged into the input area (chips clear) so nothing is lost — the
user reviews, edits, and re-sends as a normal prompt. If the turn
completes on its own, the steers are applied automatically as subsequent
turns and the chips clear.

If the user scrolls up to read earlier messages while streaming, the bar
stays expanded at the bottom. Clicking anywhere on it reveals the Stop
button.

**Status dot.** 8px circle in the **collapsed** bar only (the expanded
control row conveys state via its buttons, so the dot would be redundant
there):

| State | Color | Behavior |
|---|---|---|
| Connected, idle | Green (`#4ade80`) | Static |
| Streaming | Orange (`#fb923c`) | Pulsing |
| Disconnected | Red (`#ef4444`) | Static |

Clicking the collapsed bar while disconnected shows the reconnect banner — no expand.

**Editing a past message.** Clicking `[✎ edit]` auto-expands the bar
with the original text pre-filled. The conversation scrolls to show the
dimmed branch above; the bar stays fixed at bottom. Escape exits edit
mode (clears the draft). Blurring an edit draft salvages the typed text
as a compose draft if it was modified (`text !== initialText`), so an
accidental click-away keeps your edits; an unmodified edit blur
discards to idle (no edit, nothing to save).

**Drafts.** The composer draft (the textarea content) is a store-owned
value, not local component state, so it outlives composer collapse and
blur. Compose drafts persist to `localStorage` keyed by session id (the
stable conversation identity — an instance's current session changes on
session switch, so the instance id is not a stable key) and restore on
attach, surviving a page refresh or a transient disconnect. Edit drafts
are session-live (tied to a specific entry) and are not persisted. Send
is atomic — the draft clears only after the prompt RPC resolves, so a
failed or offline send leaves the text intact for retry. Closing the tab
with a non-empty draft triggers a `beforeunload` warning.

#### Tab completion for file paths

Tab in a path context opens a compact dropdown above the composer bar:

- **Prefix match.** The typed prefix narrows results in real time.
  Returns a limited set of matches — enough to pick from, not a full
  directory listing.
- **Auto-enter directories.** Selecting a directory (Enter or click) is
  not a dead end — the dropdown stays open with its contents shown, so
  drilling down feels like a single fluid action.
- **Keyboard navigation.** Up/Down to select, Enter to commit, Esc to
  dismiss. Tab cycles forward through suggestions. When there is only
  one suggestion, Tab accepts it immediately.
- **Prefix is preserved.** The completed path is the user's typed prefix
  plus the selected suffix — no normalization, no path resolution, no
  surprises. `./../pa<tab>` produces `./../path`, not `../path` or an
  absolute path.
- **No match → Tab inserts a literal tab.** The dropdown never blocks;
  when there are no suggestions Tab falls through to the default
  textarea behavior.

#### Model picker

The model indicator is a **ghost button** (transparent, faint hover) with
a two-tone label — model name in foreground, thinking level muted — and
a `▾` chevron. Clicking it opens a floating searchable portal grouped by
provider (like pi-sitter), anchored to the button's bounding rect (not a
fixed viewport position). Think level is shown as pill toggles inside the
portal.

- **Pinned group.** Models scoped via `--models` (the session's
  `scopedModels`) appear under a "Pinned" group at the top, deduped from
  the provider groups so each model appears once while browsing. (While
  searching, the curated group is hidden and every model stays findable in
  its provider group.) With no scope, a "Suggested" group shows one model
  per provider instead.
- **Mid-stream.** The picker stays selectable during streaming; the choice
  takes effect on the next turn (the in-flight turn keeps its model).
- **Keyboard.** `Ctrl+P` cycles the curated set forward
  (`Ctrl+Shift+P` backward); the button shows a tooltip to that effect.
  The portal closes on `Escape` or outside-click.

#### Cost & token breakdown

The cost is a **ghost button** (with a `▾` chevron, mirroring the model
picker) showing just the running cost. Clicking or tapping it opens a
compact `CostPopover` anchored above the button with the token breakdown
— `↑ input ↓ output`, and `R cache-read CH cache-hit%` when there's
cache. It closes on outside-click or `Escape`. Tappable rather than
hover-driven, so it works on touch (where a `title` tooltip would be
invisible).

## Cross-cutting behaviors

### Keyboard

Reading is the default posture (`/` enters typing; the composer is the
opt-in active surface). Keyboard navigation follows the document's two axes
plus a switch layer:

- **Temporal (vertical):** `j`/`k` focus the prev/next turn (system
dividers are skipped), `g`/`G` jump to first/last. The focused turn
top-anchors below the fixed TopBar (instant snap — no smooth lag under rapid
presses) and carries a 2px accent frame (chrome, not a fill, so the
user/assistant band distinction stays legible).
- **Branch (horizontal):** `h`/`l` walk the sibling pager on a focused user
turn with siblings — the same affordance as the inline `◀ X/Y ▶`, repointing
focus across the async navigate so consecutive switches keep their place.
- **Turn actions:** `Enter` toggles the focused turn's first action group,
`e` edit-to-forks the focused user turn, `y` copies it.
- **Switch layer (named, not positional):** `Alt+↑`/`Alt+↓` cycle the
active sessions (global snapshot, newest first — the sidebar's pinned
order; cyclic, and from the launcher both directions open the newest);
`Alt+N` creates one (direct when the cwd allowlist has one entry,
surfaces the sidebar's cwd picker otherwise). Dormant history has no
positional key; the history pane and the sidebar folders own it.

| Key | Action |
|---|---|
| `j` / `k` | focus next / prev turn |
| `g` / `G` | jump to first / last turn |
| `Enter` | toggle focused turn's first action group |
| `e` | edit-to-fork focused user turn |
| `y` | copy focused turn |
| `h` / `l` | prev / next branch sibling (focused user turn w/ siblings) |
| `Alt+↑` / `Alt+↓` | prev / next active session (cyclic, newest first) |
| `Alt+N` | new instance |
| `/` | expand composer + focus textarea |
| `Ctrl+P` / `Ctrl+Shift+P` | cycle model forward / backward |
| `Ctrl+B` / `Ctrl+H` | toggle left Sidebar / right HistoryPane |

Scope: bare keys bail when the target is a text input (you're typing);
modifier combos (`Ctrl+P`, `Alt+…`) pass through so they work while typing
(`Ctrl+P` is the exception — the composer textarea owns it in-text to avoid a
double-cycle). The HistoryPane is non-modal — app keys stay live while it's
open (interactive-target guard prevents `Enter` from hijacking a focused
graph row). Pane toggles (`Ctrl+B`, `Ctrl+H`) are global, like `Alt+…`, so
they work while typing. Branch nav (`h`/`l` for branch siblings) and other
in-session verbs (navigate, edit-to-fork) are blocked mid-stream — they
retarget the streaming instance. Session *switches* (sidebar rows,
`Alt+↑`/`↓`, `Alt+N`) stay live: attaching is the daemon's job (it
resolves-or-creates the activation and rebinds the connection; the previous
session keeps streaming headless), so client-side streaming state is no
reason to reject one. The history pane's on-path nodes go look-only during
streaming (see History pane). Turn nav (`j`/`k`)
stays live for reading. Touch keeps tap + scroll — keyboard shortcuts are
desktop-only.

One centralized, scope-guarded listener (`useAppKeybindings` in
`infra/keybindings.ts`) owns all document-level shortcuts; the Composer's
`expanded` state lives in the store so `/` can drive it without reaching into
Composer internals.

### Streaming

While the agent is generating:

- **Text.** Appears character-by-character. The block grows downward;
  content above the cursor is stable. A blinking cursor marks the end.
- **Thinking.** Streams in real time. When a thinking block starts,
  the client pulls its content field on the in-flight entry; the pull
  registers a live subscription, so deltas stream into the inline
  text. A collapsed thinking block renders only the first line
  (no full markdown parse); if the user expands during streaming,
  the full text renders on each delta.
- **Action group.** The trailing action group auto-expands so the user
  sees actions as they appear. Tool bodies stay collapsed — summaries
  and inline thinking lines are visible. When the turn completes, the
  group auto-collapses.
- **Freeze on interaction.** If the user manually toggles a group or
  expands an action during streaming, that element freezes — streaming
  state no longer drives it. A subsequent turn re-enables auto-behavior
  on new groups.
- **Auto-scroll.** Follows new content. Pauses if the user scrolls up to
  read earlier messages. Resumes when scrolled back to the bottom.
- **Abort.** Stop lives in the composer's control row. Clicking Stop
  aborts the turn. The assistant message and in-flight tool calls commit
  with aborted/error content.

### Editing a past message

Any user message can be edited to create a new conversation fork. The
original branch remains intact — editing creates a sibling, not a mutation.

1. User clicks `[✎ edit]` on message M.
2. M and all messages below it dim. The composer auto-expands (if
   collapsed) and fills with M's original text. A Cancel button
   appears.
3. User edits the text.
4. **Cancel** (Esc or button) restores: dimming clears, composer resets.
5. **Send** creates a new branch: navigates to M's parent, then prompts
   with the edited text. The new message is a sibling of M.

Disabled while streaming. Editing the root message or the leaf's own
message is allowed.

### Error notifications

Persistent toast tray below the top bar. Click to dismiss. No auto-dismiss
timers.

| Trigger | Toast | Dismissed |
|---|---|---|
| Disconnect | `Reconnecting...` | On reconnect |
| Reconnect attempts exhausted | `Can't reach pi-bridge` | On reconnect |
| Init RPC fails | `Daemon unresponsive` | On retry |
| RPC fails | Server error message | Click |

Client re-inits from snapshot on reconnect; expanded actions re-pull their
content. The composer's status dot is the persistent connection indicator.

### Lazy pull

Content-bearing fields — thinking text, tool arguments, tool results —
are lazy on the wire: neither the init snapshot nor the patch stream
carries them. The UI fetches them via `PullRequest`, driven by a single
visibility → wants mapping computed from the view:

- **Summary visible** (step rendered) → pull the step's
  `arguments`.
- **Step expanded** → pull its details fields (thinking text,
  arguments, tool result content).
- **In-flight thinking block** → pull its thinking field; on an
  in-flight entry the pull also subscribes the connection to live
  deltas, so subsequent content streams without re-pulling.

Wants are deduplicated against fields already populated in the client
mirror (`needsPull`) and fetched in one loop. Pulled content is cached
in the mirror; re-rendering never re-fetches.

### Status notification

- **Streaming:** tab prefix `🔧` / `🧠` / `💬` for current activity.
- **Turn complete while hidden** (`document.hidden === true`):
  Browser notification. Title `pi-bridge`, body `<session> · Completed
  (<duration>s)`. Closes on `window.focus`. Replaces previous.
- **Turn complete while unfocused** (visible but not focused): Tab
  prefix `🔔`. Clears on focus or next streaming turn.
- **Notification permission:** requested on first user gesture (click
  or Send). Denied → tab `🔔` still works.

## Syntax highlighting

Code blocks throughout the conversation — user messages, assistant text,
thinking traces, and tool output — use a light theme matching the
document-like off-white background.

| Content | Highlighted |
|---|---|
| User message code blocks | Yes — always sealed |
| Assistant text code blocks (sealed) | Yes |
| Assistant text code blocks (streaming) | No — plain markdown to avoid re-highlight overhead |
| Thinking block code fences | Yes — atomic, not incremental |
| Tool results (read, bash, grep, find, ls) | Yes — with copy button |
| Tool results (edit, write) | No — status messages are plain text |

## Wire protocol

Defined by [ADR 06](./06-component-model.md). Dual-channel WebSocket: push
(server→client `replace` + `patch` + `sessions_changed` + `instance_exit`) and RPC (client→server call/reply). All
UX verbs (`prompt`, `abort`, `discardSteer`, `setModel`, `renameSession`, `navigate`,
`switchSession`, `newSession`) are RPC. Daemon verbs (`listSessions`,
`getDaemonInfo`, `listFiles`, `listInstances`) and routing verbs (`switchInstance`, `newInstance`, `killInstance`) are also RPC. See `RpcRequestBody` in `core/types.ts`
for the full verb list. `listFiles(prefix)` supports path
autocompletion in the input bar — the server resolves relative prefixes
against the instance cwd and returns `{ path, isDirectory }[]`. Push `replace` is sent on re-attachment (`switchInstance`), not on raw connect (fresh `Connection` has `attachedManager = null`).

## Implementation status

The chat-style UX described in this doc is implemented in `web/` — a React
+ Vite client wired to the `BridgeClient` + `DocumentMirror` stack over the
dual-channel WebSocket (push `replace`/`patch`/`sessions_changed`/`instance_exit` + RPC call/reply). The
conversation area (turns, action groups with cross-entry merging, tinted
kind steps with white inset details panels, inline thinking), the floating composer (collapsed/expanded, streaming overlay, edit-to-fork,
path tab-completion, model picker portal, cost-breakdown popover,
pinned-model dedup, mid-stream model switching, Claude-style bar chrome
with responsive layered elevation),
read-tracked lazy pull (wants-outbox), freeze-on-interaction, auto-scroll, tab-title
activity, streamdown+Shiki markdown, and turn-header timing (thought-for /
worked-for / tool split, with a live ticking total on the in-flight turn)
are all wired. History pane (docked right rail + drawer), draft collapse/persistence, and the Launcher
(instance rows, create, connection down-state panels), the
connection-state machine
(`connecting`/`connected`/`reconnecting`/`unreachable`/`init_failed`
with a TopBar chip + manual retry), auto-attach when one instance is
live, auto-seed at zero (one per allowlist cwd, each resuming its last
session), and `InstanceInfo` enrichment (`lastActivityAt`, `preview`,
`messageCount`) are wired. The items in **Deferred**
below remain unimplemented; all are additive.

## Deferred

- **Document editing pane** (authoring). Live-rendered document alongside chat.
- **ANSI color in bash output.** Bash output renders as plain text; ANSI
  escape parsing is not wired.
- **Manual compact** (history). Trigger context compaction manually.
- **Server-derived summary field.** If pulling full arguments for
  one-line summaries proves heavy (write/edit arguments carry file
  bodies), expose a derived `summary` as an additional pullable field.
- **Cross-tab `instances_changed` push.** The Launcher polls
  `listInstances` every 5s instead; a create/kill in one tab leaves
  others' Instances list stale until re-query.

All are additive — none requires restructuring the conversation view.

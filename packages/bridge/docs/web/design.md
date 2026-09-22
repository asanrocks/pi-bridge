# Web UI Design

This is the current user-facing design of the web client. The web UI is a
reading-first session surface: conversation content is the primary document,
while controls stay compact, predictable, and available at the edge of the
reading flow. The principles are distilled from the original web UI PRD
(ADR 04, deleted — see git history); this document describes the
behavior and visual rules encoded by the current feature components.

The vocabulary for Project, Session, turn, action group, card, chip, draft,
and the active path comes from the [glossary](../glossary.md). Store, network,
ViewModel, persistence, and reconnect ownership are described in
[web architecture](./architecture.md).

## Interaction

A viewer can open the launcher, choose a Project, open a Session from its
sidebar history, browse active Sessions, read the conversation, inspect
thinking and tool actions, copy text or tool artifacts, open file links, and
browse branches in History. A steerer can do the following:

- Send a prompt from an attached Session. A prompt clears its draft
  optimistically and restores it if the RPC fails, so an offline or failed
  send does not lose text. An image-only prompt is valid.
- Send while the agent is streaming. The prompt becomes a steer queued by the
  Session rather than a second concurrent turn. Queued steers appear as
  read-only chips above the textarea and can be discarded together.
- The web client renders user shell commands represented by `!` and `!!`
  bash entries. A user-bash entry is rendered as its own turn with a `$`
  prompt, command, output, exit or cancellation state, truncation notice, and
  a muted treatment for `!!` runs excluded from context. The current composer
  has no separate execute-bash control; when such an entry is present, the
  conversation behavior is the user-bash representation supplied by the
  Session.
- Abort a streaming turn with Stop. Stop also salvages queued steers into the
  compose draft before aborting, so they remain editable. Stop is shown while
  streaming or compacting; compaction itself blocks Send.
- Rename the current Session by clicking the topbar title, pressing Enter to
  save, or Escape to cancel.
- Choose a model and thinking level from the model picker. The picker is
  searchable, grouped by provider, marks the selected model, and filters the
  thinking slider to levels supported by that model. A curated group sits at
  the top: "Pinned" when the Session's scope is configured, else "Suggested"
  (one representative per provider). On Project home, where no Session exists,
  Pinned comes from the daemon's global `enabledModels`. Ctrl/Cmd+P cycles
  models; Shift reverses the cycle. The controls remain available whenever
  connected.
- Attach PNG, JPEG, WebP, or GIF images by file picker, paste, or drag and
  drop. Attachments are resized when necessary, show thumbnail chips, and can
  be removed individually. The per-message attachment cap and per-file
  failures are surfaced through toasts. Attachments are carried when an edit
  is turned into a new branch, but cannot be added while editing.
- Complete file paths in the composer. Tab opens a Project-scoped list for a
  path-like token; arrows, Enter, Tab, and Escape operate the list. Directory
  completion continues into the next path segment. This works on Project home
  before a Session is attached as well as inside a Session. On touch, where
  there is no Tab key, the list auto-opens on a typing pause once the caret
  token is path-like (a stricter predicate than Tab's: no empty or URL/scheme
  token), and a tap accepts a row; it stays non-modal and dismisses like the
  keyboard-triggered list.
- Edit a past user message into a fork. Edit is available from the user-turn
  toolbar or `e` when that turn is keyboard-focused. The edited text is sent
  from the original parent, producing a sibling variant; the original message
  attachments are retained. Editing is blocked while streaming or compacting.
- Browse sibling variants with the user-message pager. The pager shows the
  current sibling position. When the session is idle and following the live
  leaf, selecting a sibling navigates to the newest leaf below it; while
  streaming/compacting or already peeking, selecting is a read-only peek
  re-target instead. `h` and `l` perform the same previous/next sibling
  action for a focused user turn. There is no separate regenerate button:
  regeneration is represented by edit-to-fork plus the sibling pager.
- Navigate to Sessions and branches. Opening another Session is allowed while
  the current Session streams; the old stream continues without the tab
  attached. Branch navigation through a pager, History, or `h`/`l` is a real
  branch switch only when idle and following the live leaf; otherwise it
  degrades to a peek. The daemon additionally rejects `navigate` while a
  turn is in flight; a rejected selection drops its pending scroll anchor. Closing a live Session is destructive and unconfirmed:
  it stops and flushes the live runtime while preserving its history file.
  Closing the currently viewed Session lands on that Project home.
- Peek a branch without moving the effective leaf. The rendering leaf
  (`renderLeafId` in the UI slice) can pin any committed entry's root-to-leaf
  path while `leafId` stays authoritative; the daemon never learns about a
  peek. Peek is browse-only: send, edit, and navigate are blocked while the
  rendering leaf differs from the live leaf (divergence is ground truth —
  the daemon navigating onto the pinned entry re-syncs the client). The
  jump button becomes the return-to-live gesture while peeking. The pin is
  session-scoped: activating a different Session clears it (a same-id
  snapshot restore on reconnect keeps it).

The UI distinguishes three busy cases. Streaming permits steering and
Session switching, shows Stop, and drives live conversation updates.
Compacting shows Stop but disables Send and edit; browsing stays available
through peek. Disconnected state makes Send, attachments, and model selection
unavailable; drafts remain local and are kept for retry.

## Shell Layout

The shell uses the viewport as the document scroller. The fixed TopBar and
side surfaces do not scroll with the conversation. On desktop the usual
composition is a left Sidebar, a middle conversation column, and an optional
right History pane. The conversation column clears the side-surface gutters
and reserves the live composer footprint at its bottom.

### Launcher and Project home

The global launcher at `/` lists configured Projects with their working
directories and active Sessions, ordered newest-activity-first. Active rows
show a liveness dot, name or first-message fallback, Project, relative time
tracked to the Session's last activity, and a latest-message preview;
streaming rows use the streaming color and pulse. Selecting a Project opens
its Project home at `/<projectId>`.

Project home is an unattached, compose-first surface. It shows the expanded
`HomeCompose` card, focuses the textarea, and starts a new Session when the
first prompt is sent. The first prompt, images, and explicitly chosen
pre-session model and thinking level are admitted together. The draft is
scoped to the Project, and the model choice is persisted in one local Project
slot. An unset choice leaves model resolution to the daemon. Its picker's
Pinned group uses the daemon's global `enabledModels` scope; a project-level
`.pi/settings.json` override is not reflected until the Session attaches and
its own scope arrives. The home has no
collapsed compose bar, session ledger, Stop button, or attached-session
controls.

The launcher also owns the connection down-state panels:

- Connecting shows a centered connection message.
- Reconnecting shows the attempt number and a `Retry now` action.
- Unreachable shows a warning, the host explanation, manual retry, and the
  fact that automatic retry continues.
- Daemon unresponsive shows the initialization error and a `Retry` action.

The attached topbar mirrors these states with a clickable connection chip in
the top-bar button spec; the launcher panel remains the full explanation when
no Session is attached.

### Sidebar

The Sidebar is a Project tree. Each folder is a tri-state fold — folded
(nothing below the row), active (only the pinned rows), open (pinned rows
plus history) — cycled by clicking the folder row (chevron + name are one
target; the name does not navigate). The chevron mirrors the state: right
(folded), diagonal (active only), down (open). Missing fold state defaults
to `active`, so a fresh Project shows liveness without history. A folder
with no pinned active rows has only two states: the active step is skipped
in the cycle and a stale persisted `active` renders folded, since "active
only" is indistinguishable from folded there. The `Projects` header label
is the fold-all toggle: it applies one uniform state to every folder — the
smallest step strictly above every folder's current effective state, up
the ladder `folded` → `active` → `open` (the `active` step exists only
when some folder has pinned rows), wrapping to `folded` at the top. A
click therefore always changes every folder — no dead clicks — and
fold/unfold mixing never survives a click. Each folder also
has exactly one navigation affordance, the `+` button, which opens the
Project home — the compose surface where the first prompt creates the
Session (there is no empty-Session creation path). Folder children sit
flush-left with the folder row; hierarchy is carried by the chevron and
row fills, not indentation.

Folder children:

- Active Sessions are pinned first and remain visible in the `active` and
  `open` states. A green dot means active and an orange pulsing dot means
  streaming. The attached `(Project, stem)` row is the only selected row
  and uses the accent tint; a folder row never does — it is a fold control,
  not a target.
- Dormant Session history is fetched when a folder unfolds, ordered into
  `Today`, `This week`, and `Earlier`, and shown with relative timestamps.
  `Load more` requests the next page. A dormant row has a muted status dot
  and no close action.

The active rows and history rows open Sessions. A live row menu exposes
`Close` without confirmation. The grid action beside the `Projects` header
returns to the global launcher. Empty, loading, failed-with-retry, and
no-session states occupy the same quiet message position in the folder.

On desktop the Sidebar has three modes: hidden, a docked resizable rail, and
full-screen overlay — the shared side-pane model (below; the History pane
uses the same one, mirrored). The rail width is persisted and bounded for
readable rows. Dragging below its minimum hides it; dragging above its
maximum previews and enters the overlay. While hidden, hovering the topbar
hamburger opens a temporary peek drawer; clicking the drawer pins the rail.
The pane carries a corner toggle at the TopBar hamburger's exact position in
every open mode (peek: hamburger pins the rail; fullscreen and rail: an ✕
that dismisses or hides), so the same screen corner toggles the sidebar
throughout. A 12px left-edge drag zone can reveal and size the rail. Any
pick that navigates — opening a Session or a Project home — dismisses a peek
or mobile overlay.

On mobile the Sidebar has only hidden and full-screen overlay modes. The
overlay covers the shell, closes from its corner button or Escape, and uses
safe-area insets. The selection model and folder contents are unchanged.

#### Side-pane model

The Sidebar's pane behavior lives in a shared shell (`render/PaneShell` +
`usePaneMode`), so the History pane is the same machinery mirrored to the
right edge: a tri-mode state machine (hidden / rail / fullscreen, rail
desktop-only, rail visibility persisted), a resizable rail with
drag-past-min/past-max snapping whose live preview uses the release
predicate, an edge-reveal drag zone on the pane's own screen edge, a
hover-peek drawer fed by the pane's TopBar toggle, and Escape dismissal of
the fullscreen overlay. Each pane supplies its bounds, its header chrome
(the toggle affordance per mode), and its content; the content's navigation
picks dismiss transient surfaces (fullscreen backs off to the rail on
desktop, closes on mobile; the peek hides).

### Topbar

The TopBar is fixed between the Sidebar and History gutters. Its left control
is the Sidebar hamburger when the Sidebar is hidden or on mobile. Its center
is the editable Session name, falling back to `pi-bridge`. Its right control
is the History clock, symmetric with the hamburger: shown when a session is
open and the History pane is hidden, hidden when the pane has a surface of
its own, and hover-peeks the pane while it is hidden. It is not shown on the
launcher, where there is no history. A down-state connection icon sits beside
the name and retries when clicked: an icon-only broken-chain-link button on
the topbar button spec, with no text — the state phrase lives in the tooltip
and aria-label.
Its visible grammar is two-state: an animated link (opacity pulse; slow in
muted gray while first connecting, fast in error red while retrying) means a
retry loop is running, and a still red link means the connection has given
up. The icon never uses the streaming orange or the liveness-dot vocabulary,
and all motion is gated behind `prefers-reduced-motion`, falling back to
steady half-opacity for trying and full red for failed. In desktop rail mode
the Sidebar edge is the close affordance;
the topbar hamburger is not duplicated there.

### Conversation

The conversation is a single, measure-capped column. User turns are full-width
light tinted rows with thin top and bottom rules. Assistant turns are flat and
share the same horizontal alignment. System entries are compact dividers and
summaries. Markdown is used for user and assistant prose, with syntax
highlighting, tables, and copy controls supplied by the shared Markdown
renderer.

The viewport follows structural and streaming text growth while the reader is
at the bottom. Scrolling upward pauses follow. New readable text below the
viewport adds a dot to the floating jump button; tool and thinking churn alone
does not. The jump button returns to the live end. While peeking, auto-follow
pauses and the jump button is always visible as the return-to-live gesture:
clicking it unpins the rendering leaf and anchors at the live end, catching up
with everything that landed while peeking. History anchors and
keyboard focus scrolls account for the fixed TopBar and composer.

The first paint of a session's content (open, launcher switch, cold URL load,
re-attach after reconnect) lands by rule, never at the previous session's
viewport position: a streaming session lands at the live end with follow
armed; an idle session lands top-anchored on the last user turn of the active
path (falling back to the live end when the session has no user turns).

Opening or resizing a docked pane narrows the measure-capped column and
re-wraps text; the browser keeps the raw scroll offset through the reflow
(native scroll anchoring compensates only DOM mutations, not geometry
changes), which would slide the text under the reader's eye. The viewport
capture/restore anchor compensates: the deepest DOM element at the viewport
top plus its relative offset is kept current on every scroll (the live node
is the identity — a reflow moves boxes but does not mutate the DOM), and a
column width change (a ResizeObserver width filter — height growth is
content, not rewrap) scrolls that point of that element back to the same
viewport position. If React replaced the captured node meanwhile, the anchor
degrades to the enclosing turn's boundary; with no anchor at all it keeps
the offset.

### Compose dock

`ComposeDock` is fixed at the bottom between the Sidebar and History gutters,
above the mobile soft keyboard and safe-area inset. It publishes its measured
height so the conversation cannot be covered by the card.

The collapsed `ComposeBar` is a 44px card with a status dot and placeholder.
Clicking it, or pressing `/`, expands and focuses the shared `ComposeCard`.
The expanded card contains the controlled textarea, attachment chips, and
control row. Physical-keyboard Enter sends; Shift+Enter inserts a newline.
Coarse-pointer keyboards use Enter for a newline and the Send button for
submission. The textarea grows to 40% of the viewport before scrolling
internally.

Session drafts are store-owned and persisted by Session scope. Collapse is
visual: a non-empty compose draft becomes dormant and reappears on expansion,
including its cursor position. Blur with empty text recedes to the collapsed
bar; text keeps the card expanded. Edit drafts are a separate mode and exit
only through Escape or Cancel. The dock expands automatically when editing,
when a turn starts streaming, or while steers are queued; it does not
automatically close on turn completion.

The session control row contains context percentage and bar, a read-only cost
ledger popover, model and thinking controls, Send, and Stop. The context bar
is hidden below 640px and the model name becomes the fixed `Models` label;
otherwise control order is shared between desktop and mobile. Send is disabled
when disconnected, empty, compacting, or already committing, but is enabled
during streaming to queue a steer. Model and thinking selection are separate
from Send and can be changed while connected.

### History pane

History is a persistent spatial reference, not a modal workflow. The TopBar
clock control and Ctrl/Cmd+H toggle it. The pane uses the shared side-pane
model (see Sidebar) mirrored to the right edge: on desktop a docked,
resizable rail that publishes `--history-w` (the TopBar and conversation
clear the same gutter), with drag-past-bounds snapping, a right-edge reveal
zone, and a hover-peek drawer off the TopBar clock; on mobile only hidden
and a full-screen overlay with safe-area insets. Rail visibility is
persisted, and any row pick dismisses a peek or backs a fullscreen overlay
off to the rail so the picked conversation surface is visible.

The pane renders a git-log-style graph of user-message branches. SVG vertical
lineage and cubic fork curves sit beneath fixed-height DOM rows containing a
dot, time, and message preview. The active path uses the accent treatment;
the current deepest user message is filled. A `+N` badge groups consecutive
off-path aborted re-edit drafts; opening it reveals the individual drafts.
The pane scrolls to the active row when opened but does not keep repositioning
the reader on every new leaf.

Selection is state-dependent, and every row is clickable in every state:

- When idle and following the live leaf, selecting any row anchors the
  conversation to it and navigates to the newest leaf in that subtree (a real
  branch switch).
- During streaming or compaction, an on-path row is look-only anchor
  scrolling; an off-path row (or a draft row) peeks the subtree's newest leaf
  instead of navigating.
- While already peeking, any selection re-targets the peeked path. The
  scroll anchor follows the clamped committed leaf (resolveRenderLeafTarget),
  never the raw clicked id — a pending target would never render on the
  peeked path and would strand the anchor.

The rendered path gets a neutral row highlight alongside the live path's
accent so both are legible where they share ancestors.

### File viewer

File-path Markdown links open the in-app `FileViewer` instead of navigating to
the daemon origin. Each open performs a fresh read from the attached
Project's working directory. The viewer shows the resolved absolute path,
loads Markdown as rendered prose and other files as syntax-highlighted code,
and reports the server's 256 KB truncation. Escape, the close button, or the
dimmed backdrop closes it. Code files render a line-number gutter: each
gutter line is a two-column grid (fixed number column, wrapping content
column), so wrapped code never flows under the number.

The viewer header carries the same display toggles as tool cards — word-wrap
icon for code files, markdown glyph for Markdown files — driving the shared `cardWrap`
and `cardMarkdown` preferences, so one preference governs card and viewer
rendering alike. With preview off, a Markdown file renders as highlighted
raw Markdown in the guttered code view.

A trailing line anchor on a file link — `path.ts:98`, `path.ts:98:12`, or the
GitHub-style `#L98` — opens the viewer scrolled to that line with the line
tinted; the anchor is stripped before the path resolves. Markdown files skip
the gutter and anchors (heading fragments remain stripped). Links whose
scheme and trailing port look like a line anchor (`http://host:8080`) stay
URLs. The same open path serves tool cards: any card whose call arguments
carry a string `path` gets an open-in-viewer eye in the hover controls, and
the click reads the file as it exists at click time — not what the call
produced (the card shows what the tool did; the viewer shows the file now).

External URLs open a confirmation dialog before a new tab is opened. An
incomplete link whose target is still streaming is styled but inert. Both the
viewer and confirmation dialog use blocking overlays and portal surfaces.

## Conversation Rendering

The ViewModel's active path is rendered as a sequence of turns. Consecutive
assistant entries merge into one assistant turn without changing text/action
order. A split assistant entry uses a turn key distinct from its entry id so
keyboard focus and scroll anchors remain stable.

### Turn types

- **User turns** show local time, `You`, an optional thought duration, an
  optional git-state chip, and the message's Markdown and images. The header
  toolbar contains copy, the sibling pager, and Edit. The toolbar is revealed
  on hover/focus-capable inputs and always visible on touch.
- **Assistant turns** show local time, the display model, live or sealed
  timing, and context occupancy when known. Each text block has its own copy
  action because one assistant turn may contain several messages. Streaming
  text uses the streaming Markdown mode and a cursor; provider errors, aborts,
  and output-length stops render beneath the content.
- **System turns** render compaction and branch summaries as a divider plus
  Markdown summary. Model changes render as one divider line naming the new
  model and thinking level.
- **User-bash turns** are standalone bash-tinted action rows. The command is
  shown beside `$`; the shared wrap toggle governs it like the output (wrap
  on: full multi-line command; off: one-line ellipsis). Output uses the
  shared status and result controls and
  exposes exit, cancelled, truncated, and context-exclusion metadata.
- **Git-change turns** are standalone cards for repository observations that
  occur outside an open assistant action group. The effective branch and short
  commit appear in the collapsed row. A resolvable commit can expand to a
  fresh `git show --stat` result; unavailable commits produce a non-blocking
  explanation.

Editing dims the target's later turns, marks the target with an accent bar and
`Editing` label, and keeps the branch point explicit. A keyboard-focused turn
uses an inset accent frame rather than a background fill, preserving the
user-versus-assistant surface distinction.

### Action groups and cards

Consecutive thinking and tool blocks form one renderer-owned action group;
text blocks always break a group and remain inline in their original position.
The group header is a neutral summary with a collapse triangle and one
kind-colored dot per present tool hue. A single action uses the same group
header as a multi-action group. Expanding a group reveals a flat vertical
list, not a nested tree.

The trailing group auto-expands while streaming so new actions are visible,
but its action details remain collapsed. A manual group or action toggle adds
that element to the frozen set, so later streaming renders do not override
user intent. Each action has its own triangle. Long details use a separate
expand control (chevron icon, with a "Show all" tooltip); the normal details
region is capped at 300px and signals
clipping with a fade. Touch inputs keep hover controls visible.

Action rows use four semantic hues: edit, write, and apply_patch share the
mutate hue,
bash uses the streaming hue, thinking uses the neutral think hue, and read
uses the dimmed read hue. Each row has the same uniform tinted background and
3px left strip. The group legend and row strip use the same hue tokens. There
is no per-action status dot; status is carried by timing and the card status
line.

Expanded tool cards have a status line, full path or command header, error or
truncation notices, and a content region on the page surface. Read shows
highlighted file content; write shows written content; edit shows a unified
diff; apply_patch (the Codex-style patch tool) renders one diff section per
file — `Add`/`Update`/`Delete` labels above each section (clickable: each
opens its file in the viewer, a moved update its target), `@@` seek markers as
muted locator rows, move targets folded into the Update title, delete sections
carrying the label only (the old content is not in the envelope), and the
tool's result text under the diff (apply_patch failures cross the wire as
normal content, so the body owns their visibility); bash and PowerShell show
command output with tail/full controls; grep,
find, and ls show argument and result rows; unknown tools use the fallback
argument and output renderer. Copy, line-wrap, Markdown-render, expand, and
open-in-viewer eye (when the call's arguments carry a `path`, or an
apply_patch envelope touching a single file — multi-file patches get
per-section clickable labels instead) are card-local
icon controls with tooltips; apply_patch copies the raw patch envelope. Tool
arguments and
results can arrive while a call is streaming, so a card renders available
content without waiting for a path or command annotation.

Thinking is prose rather than an operation card. A non-empty block collapses
to a one-line first-line preview and expands inline as Markdown beside its
triangle. Redacted or empty thinking is a static muted label. Git-change cards
can appear inside an action group after the action that observed the change;
the group summary and legend include the git hue.

## Typography

No webfonts are loaded; the client uses two system stacks, declared at the
consumption sites (body plus the few controls that reset inheritance — there
are no `--font-*` tokens):

- **Prose and UI:** `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
  Helvetica, Arial, sans-serif`. The document body, composer, and all control
  chrome.
- **Literal text:** `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
  monospace`. Reserved for code, terminal I/O, file paths, and model names —
  never for labels or prose.

Sizes come from the five-step `--fs-*` token scale: `--fs-xs` (11px — meta,
group headers), `--fs-sm` (12px — action summaries, sidebar rows), `--fs-md`
(13px — small body, code, card content), `--fs-lg` (14px — empty states,
dropdowns), `--fs-xl` (16px — body and composer, the reading baseline). The
mobile breakpoint drops only `--fs-xl` to 14px; Markdown inline content scales
relatively (see the inline-scale invariant below).

Weights use a narrow range and never lighter than the default: `400` default,
`500` soft emphasis on launcher rows and headings, `600` for labels — section
headers, chips, badges, composer buttons, `700` reserved for the TopBar session
title and Markdown strong text. Body line-height is `1.6` with unitless
line-heights throughout so Markdown scales with its host;
`-webkit-font-smoothing: antialiased`; italics appear only on muted metadata in
action cards and composer placeholders.

## Styling Invariants

This section is normative for additions to the web UI. It is the authority
for new buttons, chips, action rows, and Markdown hosts.

- **Tokens are authoritative.** All design colors, surfaces, text levels,
  accents, status colors, action hues, overlay colors, radii, font sizes,
  motion durations, elevation shadows, uppercase tracking, and the z-index
  ladder are declared in the two theme blocks in `web/src/app/index.css`:
  `@theme` (light) and the media-gated dark block (see Theming below).
  Components consume `var(--color-...)`, `var(--kind-...)`, `var(--radius-...)`,
  `var(--fs-...)`, `var(--dur-...)`, `var(--shadow-...)`, `var(--tracking-...)`,
  and `var(--z-...)`; they do not introduce raw hex colors or color functions.
  Elevation pigments are structural, not a second color palette. A token that
  merely restates another token's value is declared as a `var()` alias so a
  retune cannot diverge — and so it follows the dark block for free.
- **Motion has two transition steps.** UI transitions use `--dur-fast`
  (0.15s — hover/fade/transform feedback, toast entrance) or `--dur-slow`
  (0.3s — larger geometry moves like composer expansion); nothing in between,
  because ±50ms is visually indistinguishable. Cadence animations are not
  transitions: the shared `streaming-pulse` keyframe (liveness dots — sidebar,
  launcher, composer) and the cursor `blink` keep literal durations, and every
  consumer wraps its own animation declaration in a
  `prefers-reduced-motion: no-preference` guard.
- **Elevation and layering are tokenized.** `--shadow-1` (small floating
  controls) and `--shadow-2` (popovers, panels, portals) cover the ambient
  shadows; the composer card's two-layer ring shadow has one token per state
  (`--shadow-compose-rest` / `-hover` / `-focus`), and the upward
  completion-dropdown shadow and the mirrored drawer edge shadows are tokens
  too (`--shadow-drop-up`, `--shadow-edge-left` / `-right`). Geometry and
  pigment stay together in one spec per role; dark mode has to restate every
  one of them (a black drop shadow vanishes on a near-black page, and the
  card's hairline ring inverts to a white ring), which is why these are tokens
  rather than the inline literals they began as. Intra-component stacking (a slider thumb, a
  floating copy action) uses literal z-index; the `--z-*` ladder is only for
  shell layering (panes → topbar → float → dock → overlay → toast → drawer →
  portal), where each portal/drawer panel sits one step above its backdrop via
  `calc(token + 1)`.
- **Use the relative scale for inline content.** Streamdown's inline code,
  table cells, superscripts, subscripts, and headings are restated as `em`
  ratios so they scale with their host. Block code stays at the shared code
  size. This keeps Markdown proportional in the 16px document, 14px mobile
  body, and compact action/card hosts.
- **One spec per role.** A role has one visual specification wherever it
  appears. `ComposeCard` and `ComposeBar` share the card shell; toolbar and
  touch-target rules are shared across turn surfaces; action hue, strip, and
  card anatomy are shared across tool, user-bash, and git-change rows. Do not
  create a near-duplicate button or chip for a second host.
- **Streamdown overrides stay scoped.** Markdown host corrections target
  Streamdown's `data-streamdown` markers in `index.css` and the app's
  `.markdownContent` rules. They remove unwanted nested card chrome, preserve
  one border and surface, keep copy actions compact, and do not alter tool
  cards by accident. App link behavior belongs in `AppMarkdown` and its link
  renderer.
- **Capitalization follows string role.** Sentence case for actions, controls,
  tooltips, and empty states (`Show all`, `Retry now`, `Load more`). Uppercase —
  only via `text-transform`, never typed caps — for short structural labels
  (section headers, mode badges), always with small positive tracking. Data
  (timestamps, paths, model names, status values) takes natural formatting with
  no case transformation. Ellipses use the `…` character, not `...`.
- **Every feature owns a CSS module.** Feature components and their CSS stay
  co-located. Shared rendering primitives own their own modules. Global CSS
  is reserved for tokens, base elements, shell custom properties, focus, and
  scoped third-party Markdown corrections.
- **Custom properties carry live geometry.** `--sidebar-w` and
  `--history-w` are published by their resize controllers and are consumed by
  the body, TopBar, conversation, and compose dock. They are zero when a
  surface is an overlay. `--composer-h` is published by a ResizeObserver so
  bottom padding and the jump button clear the actual card. `--vv-keyboard`
  pins the fixed composer above a mobile soft keyboard. Fixed-format controls
  keep stable dimensions so labels, icons, and dynamic content cannot shift
  their neighbors.
- **Relative inline sizing and readable wrapping are required.** Long paths,
  URLs, code tokens, labels, and button text must wrap or ellipsize inside
  their host. The document body is proportional; literal code and terminal
  I/O are monospace. Keep ordinary text tracking at zero and never introduce
  negative letter spacing; the existing compact uppercase section labels share
  one tracking token, `--tracking-caps`.
- **Surface hierarchy is restrained.** The page is warm off-white, the
  Sidebar/TopBar are a warmer chrome surface, user turns have a light blue
  tint, and the composer is the raised white surface. Cards are reserved for
  individual actions, dialogs, file viewing, and repeated rows; page sections
  are not nested cards. Radius stays in the token scale, with the composer as
  the deliberate larger-radius exception.

### Theming

The app ships one light ladder and one dark ladder over the same token names,
selected by the OS preference alone. Both declaration sites are in
`web/src/app/index.css`: `@theme` holds light, and an unlayered
`@media (prefers-color-scheme: dark) { :root { … } }` block restates every
literal-valued token. There is no stored preference, no theme state, and no
script — the browser is the control. The one prerequisite is
`<meta name="color-scheme">` in `web/index.html`, which keeps the
pre-stylesheet canvas and native widgets on the OS side instead of flashing
white. Aliases (`--color-card`, `--kind-*`, `--color-think`) appear only in
`@theme` and resolve through whatever the dark block moved.
`scripts/check-bridge-styling-tokens.mjs` enforces the pairing: every
literal-valued `--color-*`, `--shadow-*`, and `--action-tint` in `@theme` needs
a dark counterpart, every dark declaration must exist in `@theme`, every
`var(--x)` reference must resolve, and `prefers-color-scheme` may appear only in
`app/index.css` — a feature module branching on it could disagree with the rest
of the app.

Colors that come from JavaScript do not use inline `color`. The Shiki
highlighter is theme-agnostic: it emits each token's light color as `--code-c`
(and the root foreground as `--code-fg`) beside `--shiki-dark` /
`--shiki-dark-fg`, and the `.codeTokens` rules in `index.css` resolve the pair
through the same media query — the technique Streamdown's own spans use. An
inline `color` declaration would outrank the media query, so an OS preference
change would leave that host stale; with the properties in the cascade it is a
repaint. (Tailwind's `dark:` variant is left on its default media query for the
same reason: Streamdown's code-block spans carry
`dark:text-[var(--shiki-dark,…)]`, and that utility must follow the same
preference as the token block.)

The dark ladder is not an inversion of the light one. Surfaces are a warm
near-black family (chrome sits above the page in dark, below it in light) and
`--color-surface-raised` steps further than its light counterpart because a
1.05:1 elevation step is invisible on near-black. Text is rebuilt against the
dark backdrop rather than dimmed from the light one. Accents and status invert
direction: `--color-on-accent` becomes dark ink, `--color-error-hover`
brightens rather than darkens, and the status hues move up in lightness so they
clear AA as text (they are dots in light, but diff lines and error rows here).
`--action-tint` rises from 6% to 7% because alpha compositing over near-black
moves luminance less per unit alpha. Every text pair clears 4.5:1, the thinking
marks clear 3:1, and the elevation step is preserved.

## Keyboard and Notifications

The keyboard ring is document-level but respects text entry and interactive
controls. Bare reading keys stop at inputs, textareas, selects, and editable
content; Enter and Space on buttons and links retain their normal activation.
Modifier commands remain global where they represent shell intent.

- `/` expands the session composer when connected and not busy.
- `j` and `k` move focus through user and assistant turns, skipping system
  dividers; `g` and `G` jump to the first and last readable turn.
- Enter toggles the first action group of the focused assistant turn; `e`
  starts editing a focused user turn; `y` copies focused user or assistant
  text; `h` and `l` move between user siblings.
- Ctrl/Cmd+B toggles the Sidebar and Ctrl/Cmd+H toggles History, including
  while typing. Ctrl/Cmd+P cycles models in the composer; the textarea owns
  that shortcut to avoid a duplicate cycle.
- Alt+Up and Alt+Down cycle active Sessions. Alt+N opens the only Project's
  home, or opens the Sidebar when a Project choice is needed.

The focused-turn frame and visible keyboard focus ring use the accent token.
Pane resize gestures temporarily apply a uniform resize cursor and suppress
selection. Reduced-motion preferences disable pulsing, blinking, and entrance
transitions where the feature supplies them.

Status notifications are shell-owned. The document title uses the Session
name, an activity marker while streaming, and an unread count for sealed
text-bearing assistant messages completed while the tab is unfocused. The
marker reflects thinking, tool activity, or ordinary conversation. A hidden
focused Session can produce a browser notification on turn completion when
permission has been granted; focus clears the count and closes the
notification.

RPC and attachment failures appear in a persistent top tray of red,
click-to-dismiss toasts. Toasts do not auto-dismiss, and the tray does not
intercept clicks outside each toast. Connection down states remain full
panels or a topbar chip rather than relying on a transient toast.

## Responsive Rules

The principal breakpoint is 768px for docked panes. Below it:

- The Sidebar becomes a full-screen overlay with safe-area padding; it has no
  resizable rail or peek drawer.
- History becomes a right drawer with backdrop; `--history-w` remains zero so
  conversation and TopBar occupy the full width.
- The conversation loses its desktop horizontal gutter so user-row tinting
  can run full-bleed. The composer restores its own 8px side gutter so its
  raised radius and shadow remain visible.
- The body font token drops from 16px to 14px, while the relative Markdown
  scale preserves hierarchy.
- The composer keeps the same element order but hides the context bar and
  replaces the live model label with `Models`. Primary Send and Stop targets
  retain their touch size. The model picker flips below its anchor when there
  is insufficient space above.
- Hover-only toolbar and card controls become visible on touch-capable
  inputs, and coarse-pointer targets grow. Safe-area insets protect overlays,
  the drawer, and the fixed composer from notches and the home indicator.

The 640px composer breakpoint only changes compact control presentation; the
768px breakpoint changes pane topology. The document remains the scroll
container on mobile so browser URL-bar collapse and soft-keyboard behavior
remain coherent.

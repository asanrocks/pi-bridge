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
  thinking slider to levels supported by that model. Its catalogue is three
  tiers (ADR 15). A "Pinned" group sits at the top when models are pinned —
  the daemon-global list resolved from pi's global `enabledModels`; there is no
  Suggested fallback. Below it, one group per provider holds the whole catalogue
  for that provider; its normal models — those matching a `visibleModels`
  pattern from the bridge settings file, plus every pinned model — are shown.
  Each group's remaining models fold behind that group's own `More…` row and are
  revealed in place; a provider with only folded models still gets a group, so
  its `More…` row is the whole group. With no `visibleModels` configured
  nothing folds. A pinned model is a promotion: it repeats in its provider group
  and stays normal, never folded. Searching bypasses the
  tiers so a folded model stays findable. Hovering a row reveals its
  `provider/modelId` and, on an unpinned row, a pin toggle that its hover
  reveals; a pinned row keeps a filled pin visible, so the pinned set is
  scannable. The glyph is state only — hovering the control changes its fill,
  never the symbol, and the tooltip names the action. Shift+Enter toggles the focused row. Ctrl/Cmd+P
  cycles the pinned list; Shift reverses the cycle. The controls remain
  available whenever connected.
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
- Dictate into the composer. The microphone beside Attach is a disclosure for
  the dictation toolbar, not a transport: it shows the toolbar — nothing is
  captured until the toolbar's own record control is pressed, whose press is the
  gesture the microphone permission needs — and pressing it again keeps what was
  heard and closes the toolbar, never discards. The disclosure flag is one
  device preference (`localStorage`), shared by the session dock and the Project
  home and applied on mount, so the panel reopens where the user left it and a
  collapse or a reload does not lose it. Every state transition is one of the
  toolbar's own controls, so no control has two meanings: record, keep (finish
  now and insert the transcript), and discard (drop the utterance), all
  icon-only and `aria-label`ed, since glyphs cannot carry words. Record is the
  transport dot, never a microphone:
  that glyph belongs to the disclosure, and one glyph cannot mean both "show the
  controls" and "record". The toolbar stays open between utterances, so a
  second one is one press, and a committed transcript leaves an undo control in
  its idle row until the next utterance starts or the draft moves — the server
  rewrites the text while it is spoken, so taking the result back belongs beside
  the control that produced it, not in a notification. While an utterance runs
  the row is a status as well: the phase in words, an elapsed clock, and the
  level meter. The transcript is written into the field as IME composition and
  becomes one undo step when it commits. The field, Send, and Enter-to-send are
  locked while an utterance runs, and path completion pauses with them. The
  lock refuses edits rather than making the field read-only: a focused textarea
  that turns read-only loses its IME connection on Android, so the soft
  keyboard would close at the start of every utterance and reopen at its end.
  Escape dismisses in order of what is most transient: the running utterance,
  then the toolbar, then the card. Collapsing the card, switching Sessions or Projects, and an external
  edit to the field also end the utterance. The Project home offers the same
  control. The credential comes from the daemon, so dictation needs a daemon
  connection and a secure context (https or localhost); without either the
  toolbar replaces its record control with the reason, in the same row, so the
  capability answer is stated in place and works on touch (a title is
  unreachable there). A dropped socket does not end a running utterance — the
  ASR stream never used it — it only stops the toolbar from starting another
  until reconnect, and a failed credential request retries in the background
  while the row names it. A normal ending — the server expires the task after
  ~20 s of silence, or the transcript never arrives — keeps whatever was
  confirmed and reports the reason once as a notice; only a failure (no
  microphone, an unsupported browser, a rejected credential) is a failure
  toast.
- Polish the draft from the same row. The idle row carries a sparkle between
  Undo and Record: it sends the whole draft to the daemon and installs what comes
  back. Nothing is polished in the background — the press is the disclosure, and
  the control's tooltip says the text goes to the IME service, which is also why
  the answer is remembered for undo rather than requiring a second press later. The row states the outcome in
  place — "Polishing" with the pending dot while the round trip runs, then the
  reason it failed, or "Nothing to polish. The text already reads well." when
  the service had nothing to change — because a press deserves an answer in the
  panel that owns it, not a toast over the field. The field, Send, and
  Enter-to-send are locked for the round trip for the same reason they are
  locked during an utterance: the answer replaces text, so "the user is typing
  into it" and "the answer is about to land" cannot both be true. Discard stops
  waiting and drops the answer. Polish is not offered while dictation runs and
  dictation is not offered while polishing: one text operation at a time.
  Undo is one control with one meaning — "take back the last thing this
  composer did to the text" — and its words name the operation ("Remove the
  inserted transcript" or "Undo the polish"). It covers the changed region
  only, so carrying on writing outside what the polish rewrote leaves the
  control usable, and a whole-draft rewrite therefore does not have to be
  undone before the user can type.
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

### Display scale

The client is a document reader, so a pinch never magnifies a region (the
browser's visual zoom) but steps the app's type scale — the same reflow a
browser's Ctrl + / - performs. The scale is one device preference
(`localStorage`, default 100%), never session state, and it multiplies the
`--fs-*` type tokens only: shell geometry stays in px, so the conversation
column can never overflow the viewport. A pinch advances one rung per 15%
finger-travel crossing; a double-tap resets to 100%; a tap on a control or a
text field is neither. The ladder is deliberately asymmetric — fine-grained
0.1 steps down to 60% so a reader can pull back and skim, but only two steps
up, to 125%, because enlarging further trades away the whole-width column.
Keeping the lever on the rem-based tokens (rather than
the root font-size) lets the OS/browser text-size preference compose
underneath. The History graph, whose row pitch is a fixed px, rescales with
it. Desktop trackpad pinch stays suppressed, so keyboard shortcuts and the
browser zoom menu remain the desktop paths.

### Launcher and Project home

The global launcher at `/` lists configured Projects with their working
directories and active Sessions, ordered newest-activity-first. Above the
Project list, a plain Latest button (ADR 13) reads "Latest session" plus the
owning Project's id — selecting it navigates to `/@latest`, which resolves
to the newest active session without redirecting. It is deliberately not an
active-row duplicate: no liveness dot, preview, or time. It exists only
while something is active. Active rows
show a liveness dot, name or first-message fallback, Project, relative time
tracked to the Session's last activity, and a latest-message preview;
streaming rows use the streaming color and pulse. Selecting a Project opens
its Project home at `/<projectId>`.

Project home is an unattached, compose-first surface. It shows the expanded
`HomeCompose` card, focuses the textarea, and starts a new Session when the
first prompt is sent. The first prompt, images, and explicitly chosen
pre-session model and thinking level are admitted together. The draft is
scoped to the Project, and the model choice is persisted in one local Project
slot. An unset choice leaves model resolution to the daemon. The displayed
thinking level is the daemon's pre-clamp default resolution clamped to the
effective model's supported levels (`clampToSupportedLevels`), which is the
level a send runs at. Known gap: a per-model thinking-level override (pi
settings `modelThinkingLevels`) for a picked model is not reported to the
client, so the display cannot show it — the session runs at the override. Its picker's
Pinned group is the daemon-global list: pinned models is one concept, backed by
pi's global `enabledModels` and never a project override (ADR 15). The home has no
collapsed compose bar, session ledger, Stop button, or attached-session
controls.

The launcher also owns the connection down-state panels:

- Connecting shows a centered connection message.
- Reconnecting shows the attempt number and a `Retry now` action.
- Unreachable shows a warning, the host explanation, manual retry, and the
  fact that automatic retry continues.
- Daemon unresponsive shows the initialization error and a `Retry` action.

The attached topbar mirrors these states with a clickable connection control on
the TopBar's ghost spec; the launcher panel remains the full explanation when
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

The active rows and history rows open Sessions. A row menu exposes `Close`
without confirmation on live rows and `Archive` on any durable row — archive
closes the session then moves its file out of discovery, and a dormant row's
close is a no-op, so it is how history is thinned without opening each
session. The grid action beside the `Projects` header returns to the global
launcher. Empty, loading, failed-with-retry, and
no-session states occupy the same quiet message position in the folder.

On desktop the Sidebar has three modes: hidden, a docked resizable rail, and
full-screen overlay — the shared side-pane model (below; the History pane
uses the same one, mirrored). The rail width is persisted and bounded for
readable rows. Dragging below its minimum hides it; dragging above its
maximum previews and enters the overlay. While hidden, hovering the topbar
hamburger opens a temporary peek drawer; clicking the drawer pins the rail.
The pane carries a corner toggle at the TopBar hamburger's exact position in
every open mode (peek: hamburger pins the rail; fullscreen and rail: a close
control that dismisses or hides), so the same screen corner toggles the sidebar
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

The peek drawer covers the TopBar, including the toggle that opened it, so the
drawer's own header action takes over that toggle's box — 6px from the top, 12px
from the pane's edge, 36×36, the same box `.topBarBtn` occupies. The corner
control therefore never moves between the hover target and the surface it opens:
both panes do this arithmetic (Sidebar `.overlayHeader`, History `.headerPeek`),
and the peek's action is the one that pins the rail rather than a second close.

### Topbar

The TopBar is fixed between the Sidebar and History gutters. Its left control
is the Sidebar hamburger when the Sidebar is hidden or on mobile. Its center
is the editable Session name, falling back to `pi-bridge`. Its right control
is the History clock, symmetric with the hamburger: shown when a session is
open and the History pane is hidden, hidden when the pane has a surface of
its own, and hover-peeks the pane while it is hidden. It is not shown on the
launcher, where there is no history. A down-state connection icon sits beside
the name and retries when clicked: an icon-only broken-chain-link control on
the TopBar's ghost spec, with no text — the state phrase lives in the tooltip
and `aria-label`.
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
at the bottom. Scrolling upward pauses follow.

A sent message is different: the sent user turn top-anchors — the whole turn
container, header metadata included, not the text — and auto-scroll freezes
for the turn, so the reader's own message stays the reading position while
the reply streams in below. The freeze is unconditional for the turn and
lifts only when the reader reaches the live end after content has grown below
the parked viewport, presses the jump button, or switches sessions: reaching
the live end before anything streamed below is circumstance, not intent, and
must not lift it. The anchor scroll itself is animated (instant under
prefers-reduced-motion), and the frozen viewport's park position — not the
transient mid-animation position — is what the content-below check measures
against. Top-pinning the tail needs scroll range below it, which the tail
rarely has on its own, so the conversation column always carries tail slack:
the minimum manufactured scroll range that keeps the live path's last user
turn pinnable at the viewport top — exactly the just-sent reading position,
available at any time (an idle session landing, or a plain scroll down), not
only while a turn is frozen. It is trimmed down as content streams in below
the pin and grown back when content above the pin shrinks (a collapsed card),
so while any slack remains the document's maximum scroll IS the pin position
— scrolling past it into blank is structurally impossible — and once the tail
fills the viewport the slack is zero and the range below the live end is
exactly the content. The slack is written as a `--tail-slack` custom property
that the composer-footprint padding adds, so the composer's own growth stays
live in the cascade, and every live-end computation (at-bottom detection,
follow targets, the jump button, go-live) subtracts it, so nothing ever
targets the padded end. While peeking a committed branch the slack is not
recomputed (the viewport belongs to the reader); returning to live refreshes
it. A clamp at the other end (not enough content above the anchor to pin it
at the top) is benign — the anchored turn is then necessarily within the
first viewport. Sends from another client (steers) do not anchor; only the
local composer's sends do. The armed baseline carries the tail user
message's content fingerprint alongside its id: while a turn is in flight the
tail user message is a live form whose content is still being completed, and a
seal installs the persisted text under the same id. The fingerprint gate keeps
the anchor on the message it was armed for; identical consecutive messages
(same text and block shape) miss the anchor and fall back to plain
bottom-follow — never a wrong pin.

Reading up outside a frozen turn, new readable text below the viewport adds a
dot to the floating jump button; tool and thinking churn alone does not. The
button floats horizontally centered on the conversation column (inset to the
sidebar and history gutters), above the composer. With
the dot showing, the button top-anchors the latest reply turn — the latest
assistant turn, tool-only turns included, falling back to the last turn when
no reply exists yet — the same target as the G key, so every "go to the end"
gesture lands in one place. Without the dot it returns to the live end and
re-arms follow; while a turn is frozen it means "follow live" for the rest
of the stream. While peeking, auto-follow pauses and the jump button is
always visible as the return-to-live gesture: clicking it unpins the
rendering leaf and anchors at the live end, catching up with everything that
landed while peeking. History anchors, send anchors, and keyboard focus
scrolls pin the turn container clear of the fixed TopBar and composer via
scroll-margin.

The first paint of a session's content (open, launcher switch, cold URL load,
re-attach after reconnect) lands by rule, never at the previous session's
viewport position: a streaming session lands at the live end with follow
armed; an idle session lands top-anchored on the last user turn of the active
path — exactly, via the tail slack — falling back to the live end when the
session has no user turns.

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
the offset. A pinned action or group header is excluded from the probe — its
rect top is the pin offset, which would make the restore target non-unique — so
the probe falls back to that turn boundary while a header is pinned.

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
from Send and can be changed while connected. Send and Stop are the row's only
filled controls and the client's only two; every other control in the row is a
ghost control (see
[Iconography and control surfaces](#iconography-and-control-surfaces)).

When the tail turn is broken — it ended in an error after retries were
exhausted, was stopped (a user Stop or a session close mid-run, which leave
the same trace), had its tool work terminated mid-execution, or was cut off
after its tool results but before its final message — the dead turn grows an
error row carrying the recovery controls (ADR 16). The error row is the one
failure presentation and the one recovery carrier: its line is the turn's
real error or abort text, or — when pi persisted no error at all, the silent
data-loss shapes — a synthetic line in the same error hue ("Interrupted
while running tools", "Interrupted before the reply finished"), so a
half-dead run is never visually quieter than a provider error. The
ViewModel projects the recovery onto the turn containing the dead entry
(`AssistantTurn.recovery`, derived by the same pure
`computeRecoverableTurn` the host verb gates on, idle-only and from the live
leaf), so placement needs no renderer heuristic. The labels predict the
mechanism before the click: **Retry** silently re-requests from a clean
boundary (no interrupted work is re-run or re-sent, nothing is added to the
transcript) and is offered with **Edit** (the composer's edit mode on the
run's user message, then resend); **Send "Continue."** is the one action
that adds a message — a visible `"Continue."` user turn, after which the
agent re-orients using a bounded relay of completed tool results and calls
with unknown outcomes when a dangling assistant is removed — and is reserved
for tails where a tool was terminated or left unanswered. The line names
what happened; the tooltip names what the button does, per failure mode.
The line renders whenever the tail is broken; the buttons arm only while
idle, connected, and following the live leaf — the same gates as Send's
divergence lock. Pressing one branches past the broken turn (the failed
attempt stays visible in the history pane as a fork) and starts the
recovered run; if that run fails too, the control re-arms on the new
branch.

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

The header is a quiet uppercase `History` label. The pane renders the
conversation's branch graph; the repository's evolution lives in the
transcript's git affordances and the TopBar badge (see Git affordances).

The graph renders a git-log-style graph of user-message branches. SVG
vertical lineage and cubic fork curves sit beneath fixed-height DOM rows
containing a dot, time, and message preview. The active path uses the accent
treatment; the current deepest user message is filled. A `+N` badge groups
consecutive off-path superseded turns — dead ends, whether aborted drafts
or completed turns later edited away or abandoned for a sibling from the
same branch point; opening it reveals the individual turns. A dead end on
the active path, or pinned by a peek, stays a row. A user message carrying
a label (pi tree-selector bookmark) shows a tag at the beginning of its
preview. The pane scrolls to the
active row when opened but does not keep repositioning the reader on every
new leaf.

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

### Git affordances

Repository evolution has three discovery surfaces, one per question the user
asks, and no separate timeline pane. Each names its endpoint pair explicitly;
none infers a turn-scoped window git cannot know.

- **The turn chip** (the git identity on a user message) is a static label
  until the turn has something to review, then a disclosure menu. Its items are
  the commits observed during the turn (`UserTurn.gitTransitions`): a stamp whose
  commit differs from the previously observed one, attributed to the turn open
  at its path position — a prompt stamp is persisted before the message it
  labels, so it closes the previous turn while its identity becomes the next
  turn's baseline. A turn with several commits also offers one union window
  from the first transition's old commit to the last one's new commit. The
  live path's last user turn additionally offers **Compare with the current
  worktree** (its send state → `worktree`), the honest form of "what happened
  since this prompt" — it is a sampling point, so the browser marks it `as of`
  and refetches on settle. Earlier turns and peeked paths offer no worktree
  item, because comparing them to the current worktree would silently span
  other turns.
- **The git card** (`review`) opens that one commit against its first parent,
  resolved host-side. It is the card's only review meaning; the turn's
  transition windows belong to the chip menu, so there is no second `diff`
  affordance to disambiguate.
- **The TopBar changes badge** is the one turn-agnostic surface: the count of
  files differing from `HEAD` in the attached session's Project worktree,
  sampled when a turn settles (never per streamed entry) and hidden while
  clean. Its menu reviews `head → worktree`. Because dirt from several
  trailing turns is indistinguishable now, attributing it to any one turn
  would be a lie — which is why it lives in session chrome, not on a turn.

Every menu opens the same repository browser (see below) with the pair as its
target. Historical uncommitted state is still not recoverable: only the live
worktree is shown, and a turn's commits are the recorded identity transitions,
not an archived worktree.

### Repository browser

The browser is the one fullscreen repository surface (ADR 14): a file tree on
the left, file content on the right, in the portal role (Escape, the close
control, and the backdrop close it; read-only). Every entry point opens this same surface with a
different target — a Markdown link or a tool card opens one file with the full
tree, a turn chip menu or a git card's `review` control opens a changed-files
review, the TopBar badge's menu opens the live uncommitted review, and the
Project home browses the worktree from the Project cwd with
nothing selected. The browser is not a Session-scoped route: it is ephemeral
chrome, closed by an address change like the panes.

The header names the task, not the endpoint pair. Four surfaces fall out of
the target: **Files** (no baseline — one state read in the full tree, with the
single state selector and the root path as its detail); **Working changes** (a
worktree content state, described `since <baseline>`); **Commit changes** (a
pinned commit against its base, led by the commit id and subject); and a
**recorded transition** (a git-stamp window, titled by its origin — the turn's
first line or the commit subject — with the pair as metadata). A detail line
carries the changed-file count, the comparison, and an `as of` time whenever
the worktree is an endpoint (the worktree is a sampling point, so the render
is stale by construction). `Compare…` opens the endpoint selector — the three
common comparisons (Working, Staged, Unstaged changes) and a custom From → To
pair built from the same state list; the baseline end cannot be the working
tree, which the host rejects. Applying a comparison rewrites the target and
refetches, and drops the origin label, because the window is no longer the one
the browser was opened on. A worktree endpoint also refetches when a turn
settles, so the view tracks the agent without polling. Review-scoped diff
controls live with the content they act on, in a bar above the sections:
`Expand files` and `Expand all lines` (the latter replaces the diff's three
context lines with the complete diff, from contents that are already fetched).
The `Review` toggle switches between the stacked sections and one selected
file, and the changed-files tree scope is the tree pane's own label, which
toggles between the full tree and the changed tree when a baseline exists.

The tree has two scopes. The full tree lists one directory per expansion
(`listDirectory`), lazily, so a large repository costs one query per opened
folder; `.git` never appears, and a directory the host's cap clipped says how
many entries are missing. With a baseline, changed files are marked on their
rows with git's status letter. The changed tree is derived from the diff
directive's paths, never from walking the repository and filtering it
client-side; intermediate directories are synthesized from the paths. A file
link that points deep into the tree expands and loads its ancestors so the
selection is visible where it lives. A directory whose listing failed is
marked unreadable and stays collapsed — the next toggle retries it — rather
than rendering as an empty directory. On narrow viewports (the same 768px
boundary the Sidebar and History panes use) the tree starts collapsed behind a
`Files` control in the header and opens as an overlay drawer over a scrim:
tapping the scrim, the `Hide` control, or a file dismisses it, so it never
sits as an empty column and never buries the content it covers. The header's
own controls wrap to a second row on a narrow viewport rather than clipping at
the panel edge, and the browser's rows and chrome grow under a coarse pointer
like every other control in the app.

The wire is split by role, exactly as the old review surface was. `gitDiff` is
the *directive*: one call supplies the per-file list, statuses, and ± counts
and no patch text at all. `readFile` is the *payload*: the file pane reads one
path at the read state, and each review section fetches that file's content at
each end of the pair and diffs the two snapshots in the client with the shared
diff-line spec — so syntax highlighting, word-level inline diffs, the dual
old/new gutter, and context elision are the same spec the edit and apply_patch
cards use. There is no unified-patch parser. A fetch that fails, or a snapshot
the host truncated (which would diff as a phantom tail), says so instead of
rendering a wrong diff. Untracked files are listed by the directive (without
counts) and always fetch their content on expand; when the host capped the
untracked list or the changed-file list, the remainder is stated rather than
hidden.

A review section shows its path (the rename source struck through), binary
note, and ± counts in the diff tint colors, and expands to the diff — or, with
its `file` control, to the whole file at the read state through the shared file
body. Clicking a changed file in the tree scrolls to and opens its section, so
the tree is navigation over one stacked list rather than a filter; as the list
scrolls, the highlighted node follows the section being read. Sections are
collapsed by default, and `Expand files` / `Collapse files` toggles the whole
list; an open section fetches its payload as it approaches the viewport, on the
same measurement that moves the tree highlight, so expanding a large review
loads diffs on approach instead of one read per changed file. A section
left with no content change (a mode-only change) says so. An unreachable
recorded commit, a binary file, and an identical pair render as neutral
explanations, never errors.

The file pane and the review sections render through the same two shared specs
as the rest of the app: `render/FileContent` for whole files (one code
surface, one gutter, one truncation notice, the shared wrap/markdown toggles)
and the conversation's `DiffSections` for diffs. Opening a file in a review is
therefore indistinguishable from browsing it in the tree. A Markdown file
renders as prose, other files as highlighted code; the server's 256 KB
truncation is reported. A trailing line anchor on a file link — `path.ts:98`,
`path.ts:98:12`, or the GitHub-style `#L98` — opens the browser, scrolls to
that line, and tints it; the anchor is stripped before the path resolves, and
Markdown files skip the gutter and anchors. Links whose scheme and trailing port look like a
line anchor (`http://host:8080`) stay URLs.

Entry-point paths are absolute-ized client-side against the current Project
cwd (ADR 14): the browser's queries carry absolute paths, and `~`-rooted
paths are the one form left for the host, which owns HOME. A file inside the
Project browses from the Project cwd; one outside it falls back to its own
directory as the tree root. The same open path serves tool cards: any card
whose call arguments carry a string `path` gets an open-in-browser eye in the
hover controls, and the click reads the file as it exists at click time — not
what the call produced (the card shows what the tool did; the browser shows
the file now).

External URLs open a confirmation dialog before a new tab is opened. An
incomplete link whose target is still streaming is styled but inert. The
confirmation dialog uses a blocking overlay and portal surface; the browser
is the fullscreen variant of the same portal role.

## Conversation Rendering

The ViewModel's active path is rendered as a sequence of turns. Consecutive
assistant entries merge into one assistant turn without changing text/action
order. A split assistant entry uses a turn key distinct from its entry id so
keyboard focus and scroll anchors remain stable.

### Turn types

- **User turns** show local time, `You`, an
  optional git-state chip, and the message's Markdown and images. A user-
  defined label (a bookmark set from pi's tree selector or in-app) renders
  as a `#`-prefixed tag chip in the header, left-aligned after the git-state
  chip — and is editable in place: clicking the chip swaps it for an inline
  input (Enter commits, Escape/blur cancels, empty + Enter clears); an
  unlabeled message reveals a dashed ghost chip on hover as the add
  affordance (always visible on touch). Labeling is blocked while peeking
  another branch or a turn is in flight.
  The header
  toolbar contains copy, the sibling pager, and Edit. The toolbar is revealed
  on hover/focus-capable inputs and always visible on touch.
- **Assistant turns** show local time, the display model, and context
  occupancy when known. Each text block has its own copy
  action because one assistant turn may contain several messages. Streaming
  text uses the streaming Markdown mode and a cursor; provider errors, aborts,
  and output-length stops render beneath the content.
- **System turns** render compaction and branch summaries as a divider plus
  Markdown summary. Model changes render as one divider line naming the new
  model and thinking level. A system-prompt diff renders as a read-style card:
  a tinted collapsible row named `System prompt update`, expanding to a details
  card with the changed sections and the prompt text (pulled lazily) highlighted
  as markdown. An extension entry renders as an `Extension` divider; a
  display-flagged extension message renders as an `Extension message` divider
  with its text as Markdown; an upstream entry type with no bridge kind renders
  as an `Unrecognized` divider. Each names the source type, with the raw source
  entry in a collapsed detail block, so a path entry is never dropped silently.
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

Both fold controls pin against the viewport, which is the scroll container: the
group header sticks under the fixed TopBar for as long as its group is on
screen, and an action's own header — the row that carries its triangle — sticks
beneath the group header, so a long group or a long card never scrolls its
collapse target away. Nesting is the sticky offset (`--topbar-h`, then
`--topbar-h` plus the derived `--group-head-h`); each header is bounded by its
own containing block — the group, the action — so the next sibling's header
pushes the pinned one out. Both paint an opaque surface, because content
scrolls underneath: the group header the page tone, the action header its hue
tint composited onto that tone. A pinned header keeps its resting chrome — no
seam, no corner change, no shadow — so the conversation's colour band stays
unbroken while content slides beneath it. The pinning is chrome only — it adds
no height, and pinning itself does not affect the scroll anchor.

A fold lands where it was clicked: the clicked header keeps its screen position
and the body slides up beneath it. Pinning makes this necessary — a pinned
header's flow position is far above the viewport, so collapsing the body would
let the row fall back to it and disappear upward (and the shrunken document can
then clamp the offset somewhere else entirely). The correction measures the
header before the toggle and scrolls by the difference afterwards, which needs
no pin line named and is a no-op for a header that was not pinned. It is
upward-only: a collapse that shrank the document past the scroll range keeps
the browser's clamp instead of scrolling down. Keyboard folds (the focused
turn's first group) take no correction, since focusing a turn top-anchors it and
leaves that group's header below the fold line.

Action rows use four semantic hues: edit, write, and apply_patch share the
mutate hue,
bash uses the streaming hue, thinking uses the neutral think hue, and read
uses the dimmed read hue. Each row has the same uniform tinted background and
3px left strip. The group legend and row strip use the same hue tokens. There
is no per-action status dot; status is carried by the card status
line.

Expanded tool cards have a status line, full path or command header, error or
truncation notices, and a content region on the page surface. A settled
call's duration is pi's own recorded execution time
(`ToolResultMessage.durationMs`), rendered verbatim; a running call shows the
host-anchored live elapsed (`status.inFlightTools`, rebased onto the client
clock), or only its status light when no anchor is known. The bridge derives
no timing of its own: pi supplies the settled duration, the host supplies the
in-flight anchor. Read shows
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
content without waiting for a path or command annotation. Diff sections are
streaming-stable: highlighting is cached per section content, so a chunk
that grows one section keeps that section's previous highlighting visible
(only genuinely new lines render plain until their result lands, and a
restructured line falls back to plain until its tokens realign) while
unchanged sibling sections render byte-identical output — a streamed chunk
never drops a card to plain text.

Thinking is prose rather than an operation card. A non-empty block collapses
to its first line rendered as Markdown and clamped to a single line — the
triangle precedes it, and the clamp keeps the row one line tall even when line
1 renders as a heading, list, or fence — and expands inline as Markdown beside
its triangle. Redacted or empty thinking is a static muted label. Git-change cards
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

Markdown list indentation is one of those relative sizes: per-level marker
clearance in `em` (`--list-indent` 1.5em, `--list-indent-nested` 1.15em in
`index.css`), applied by one rule on Streamdown's list markers with `outside`
markers. So a level indents ~24px at the 16px desktop baseline and ~21px at
the 14px mobile one, and a pinch (see Display scale) rescales it with the text
rather than leaving a pixel indent behind.

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
  and `var(--z-...)`. Components introduce no raw pigment: no hex literal and
  no color literal outside a `var()`. A `color-mix()` whose inputs are all
  tokens, with one literal alpha, is a rule over the ladder rather than a
  pigment of its own — it follows the dark block through the tokens it mixes,
  and the ghost control's hover fill is the case that needs it.
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
  body, and compact action/card hosts. List indentation is part of this rule:
  the two `em` tokens above are marker clearance, never a px literal, and one
  unlayered `data-streamdown` rule sets `list-style-position: outside` on
  every Markdown host. Streamdown's `list-inside` puts the marker in the
  content box, which both drops the hanging indent (wrapped lines return to
  the padding edge instead of the text) and makes the apparent margin
  padding + marker. Padding is clearance, not taste: level 1 clears a
  two-digit `ol` marker, nested levels only a disc or single digit.
- **Controls are glyph-first and chromeless at rest.** A button paints no
  background and no border, and its state lives in the ink and in one optional
  hover fill rather than in chrome; the composer's Send and Stop are the only
  two exceptions. Icon-only is the default for verbs, and no in-document
  control is a font glyph or an emoji. See
  [Iconography and control surfaces](#iconography-and-control-surfaces).
- **One spec per role.** A role has one visual specification wherever it
  appears. `ComposeCard` and `ComposeBar` share the card shell; toolbar and
  touch-target rules are shared across turn surfaces; action hue, strip, and
  card anatomy are shared across tool, user-bash, and git-change rows. Do not
  create a near-duplicate button or chip for a second host; the ghost control
  is one spec, and a host inherits its states rather than restating them.
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
  co-located. Shared rendering primitives own their own modules. A spec shared
  across features (the ghost control) lives in one shared module and is adopted
  with CSS Modules `composes`, so it has one declaration site without becoming a
  global utility class. Global CSS is reserved for tokens, base elements, shell
  custom properties, focus, and scoped third-party Markdown corrections.
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
  the deliberate larger-radius exception. A hairline border is a boundary
  between two surfaces — a field, a portal, a card, a thumbnail — and never the
  thing that says a control can be clicked.

### Iconography and control surfaces

A control is a hit target carrying one glyph, plus a label when it needs words.
At rest it paints no background and no border, so its only ink is the symbol.
Chrome that exists to announce clickability competes with `--color-border`'s
single job — hairlines between surfaces — so a control earns a boundary only by
being a container.

**Reviewing the set.** `web/src/dev/glyphs.tsx` renders every export at all four
slots and again inside the box ladder, served by the dev server at
`/glyphs.html` and never built (Vite's entry is `index.html`). "This glyph is not
pretty" is the one finding no gate can produce, so the answer is a surface where
the whole set is visible at once instead of one screen at a time.

**One glyph set.** `web/src/render/icons.tsx` is the only source. Its file
header is the registry (role, glyph, one sentence each), exports are named
`<Role>Icon`, and adding a glyph means adding it there rather than inlining an
`<svg>` in a feature.

- **Grid and live area.** Every glyph is drawn in a `0 0 16 16` viewBox with a
  12×12 live area centred at 2..14. Ink stays inside the live area except round
  caps and joins, which may cross it by half a stroke. The live area is the
  answer to "how much blank surrounds the icon": it is applied inside the
  viewBox, so two glyphs by different hands read at one optical size and no
  consumer has to tune padding per symbol. Containment is not enough, though —
  any scale below the live area satisfies it and still reads as a size bug. So
  art authored elsewhere declares its **ink box** and `liveFit` maps it in: the
  larger ink dimension lands on 12, the smaller follows the aspect ratio, and
  the result is centred. One hand-applied constant cannot do that, because the
  imported solid marks span 16×10 (Markdown) to 14×15 (Copy) and a shared 0.75
  fits the widest while leaving Copy 12% narrow.
- **Stroke weight is stated in rendered pixels, not viewBox units.** A 16-grid
  glyph rendered at `S` CSS px carries `stroke-width: W * 16 / S`, which lands at
  `W` px on screen. `W` is 1.5 at the 16 and 20 slots and 1.25 at 12 and 14: the
  weight steps down on the optical-size step, because 1.5px of stroke on a 12px
  glyph is over a tenth of its height and starts to blob. Stated the other way
  round — one fixed viewBox stroke — a glyph rendered at 20px would be a third
  heavier than the same glyph at 14px, which is how a shared set drifts into two
  weights.
- **Four slots, no free numbers.** The slot follows the row, not the meaning:
  12 for meta marks (chip marks, section carets, a chevron beside a short
  label), 14 in compact control rows (card and turn toolbars, row menus), 16 for
  full-size icon controls (composer row, dialog and portal actions, the
  fullscreen viewer's close), 20 for chrome (TopBar and pane-header toggles). A
  feature picks a slot, never a number; 11, 13, and 18 are drift, and so is a
  per-call-site size.
- **Two ink modes, assigned by family.** Outline is the default. Solid is a
  closed set of three families with their own slot rules. **Object marks** (Copy,
  Check, Eye, Wrap, Markdown) sit beside Streamdown's own solid copy pair and
  must match it in the same row; they are legal at 12 and 14 only, because a
  filled symbol at 16 or 20 reads as a badge rather than a control. The one
  exception is Check in the composer's dictation row, where the check is that
  row's command rather than a mark beside copy art. **Menu marks** (More, the
  row overflow) are made of dots, which have no outline form — a stroked dot at
  14px closes its own counter and reads as a smudge — so they are solid by
  construction, at 12 and 14 by the same badge argument. **Transport solids**
  (Record, Send, Stop) are filled because solidity is the meaning; they render
  at 16, where the filled box around them carries the size. A new glyph is
  outline unless it joins one of those families, and the gate requires the
  decision at the point the export is added.
- **Directional marks split by what their rotation means.** Chevrons are
  outline and point at something. The fold caret is solid, and it is the only
  solid directional mark: rotation *is* its state (right / diagonal / down for
  folded / active / open), so it carries that state as three glyph directions
  rather than a CSS transform a consumer can forget. A filled triangle used as
  a chevron would be a different symbol, not a weight choice. Because the
  directions are one path under rotation, the path is authored symmetric about
  (8,8) — an off-centre source box would orbit the rotation origin instead of
  turning in place.
- **Box ladder and bleed.** An icon-only control is square, from
  24 / 28 / 32 / 36, chosen by the row it lives in. The hover and press rect
  outgrows the glyph without moving layout: `margin: -pad` with an equal
  `padding`, where `pad` is the row's own gap. That is what lets a 14px glyph in
  a card toolbar offer a 28px target, and what keeps neighbouring icons from
  reflowing when one of them lights up. Touch takes the other direction: on a
  coarse pointer the box the row declares is the box the finger gets, and a
  transparent overlay of the row's own gap carries the larger target
  (`turns.module.css`: a 28px square with a 40px target). Enlarging the border box
  instead repaints the control at finger size and lifts the row's height with it,
  which is exactly what makes a conversation header read loose on a phone — the
  target grew, the glyph did not, and the space between controls grew with both.
- **Nothing in the document is a font glyph.** No emoji, and no geometric
  character (`▾ ▶ ■ ✕ …`) standing in for an icon. Three concrete reasons: an
  emoji is a colour bitmap that ignores `currentColor`, so it cannot follow the
  dark ladder, the disabled opacity, or an accent hue; a text glyph sits on the
  baseline, so a centred square hit box drifts a pixel or two per font and per
  size; and its advance width is not its ink width, so "centre this" and "size
  this" disagree. A **status mark is an icon, not data**, so it becomes a glyph
  too (a failed directory listing shows a warning triangle, not `!`). Typed
  characters that *are* the data stay text: git's own `A`/`M`/`D` status
  letters, diff `+`/`−`, a `HEAD → working tree` label, and `…` as punctuation.
  The one legal emoji sits outside the document — the `document.title` activity
  marker, which no SVG can reach.
- **A glyph carries no words.** An icon-only control carries `aria-label` and
  its `<svg>` is `aria-hidden`. Never both: `role="img"` with an `aria-label`
  inside an already-labelled button announces the control twice.

**State is ink, not chrome.** A ghost control has five states and one channel
each:

| State | Ink | Fill |
| --- | --- | --- |
| rest | `--color-secondary` | none |
| hover | `--color-foreground` | `color-mix(in srgb, currentColor var(--state-fill-alpha), transparent)` |
| pressed (`aria-pressed`) | `--color-accent` | none |
| engaged (`data-on`) | `--color-accent` | `color-mix(in srgb, currentColor var(--state-fill-alpha), transparent)` |
| disabled | `--color-secondary` | none (`opacity: .4`) |

The two engaged states differ by one channel on purpose. `aria-pressed` is state
about the thing the control stands for — this row's model is pinned — so the ink
says it and nothing else does; a chip behind every pinned row would turn a column
of state into a column of buttons. `data-on` is a control that stays engaged, like
a toolbar's wrap or an open dictation disclosure, and it takes the fill so the row
reads as a pressed tool. Neither repaints its hue on hover.

The ink change carries the hover, and the fill has to be strong enough not to
pretend otherwise: the `--color-muted` surface token is 1.20:1 against the page
tone and 1.25:1 against the raised composer, below the threshold where a fill
reads as a change at all. So the fill is derived from `currentColor` — one
declaration that follows whatever hue the state already chose, in both ladders —
and the ink moves a full text level at the same time. The strength is
`--state-fill-alpha` rather than a literal per rule, and a **state fill must
clear ~1.4:1** against the surface it sits on, or the state is ink-only and the
fill is just texture. The shipped 20% resolves to 1.45:1 on the light page (the
earlier 12% was 1.25:1, within noise of the muted hover it replaced) and 1.78:1
in dark, where the same alpha moves more luminance over near-black. Rest ink
stays at the secondary level rather than the meta level, because with no border
the glyph is the only thing marking the control. Disabled is opacity plus a
rest-ink reset — a browser still matches `:hover` on a disabled button, so the
hover hue would otherwise sit under the opacity — and WCAG exempts inactive
components from the 3:1 non-text rule, so no per-state disabled color is needed.
Focus is never the control's business — the global accent ring in `index.css`
covers every button — and a control must not restate hover or focus as a
`border-color` change, which it cannot do anyway once it has no border.

**Toggle state swaps the glyph when the glyph has two forms.** Colour alone
cannot carry on/off (WCAG 1.4.1), so a toggle whose symbol can differ shows the
difference: an outline pin to a filled pin, a folded caret to an open one, the
cap chevron to its collapse direction. The swap is the state. A toggle whose
glyph has only one form (line wrap, Markdown rendering) takes the accent and the
engaged fill (`data-on`) instead, so the row of card controls shows which tools
are on at a glance; `aria-pressed` remains the non-visual state channel. Hover may change the fill but never the symbol, or the symbol
stops meaning state.

**A filled box marks a surface's primary command.** It is distinct from a solid
glyph, which is ink without a box. The family is small and each member is the
one control its surface exists to offer: Send and Stop in the composer (the
commit and the interrupt — ghosting them would leave the accent with nowhere to
live at rest and turn "stop the agent now" into a 1.5px stroke), the confirm in
a dialog, `Apply` in the compare menu, and `Retry now` in a connection down
state. Everything else is a ghost. A new filled control has to be that same
thing — a command issued at the edge of a surface whose state changes something
— and Send and Stop are the only two whose glyphs are also transport solids, in
`--color-on-accent`, so box and symbol never disagree about weight.

**A control that floats over content keeps a container.** The attachment remove
button sits on a thumbnail, the jump button floats over the conversation, and
the per-message copy chip floats over Markdown: what is beneath them is content,
not a row, so each keeps a filled disc or card to stay legible against it. That
is a legibility requirement, not chrome, and it is the only exception the border
rule needs.

A floating container's fill alone is not enough, which is why the copy chip
carries `--shadow-chip`: a raised surface on the page tone is 1.05:1, so the
half-pixel ring is what defines the shape — without it the chip reads as a hole
punched in the paragraph rather than a control placed over it. Two placement
rules follow from the same idea. A floating control stays inside the element it
belongs to and never crosses that element's top edge upward: the chip's earlier
`-8px` offset put it behind the fixed TopBar whenever its line sat at the top of
the viewport, which looks like clipping. And the box takes the slot that its
glyph fills — the copy mark is wide and squat, so 24 rather than 28 is what makes
a 14-slot glyph read at size.

**Text instead of a glyph, and the other way round.** Icon-only is the default
for verbs. Text stays where the control carries a value rather than an action —
the model and thinking label, context percentage, the cost ledger, the changes
count, the Session name — because an icon would erase the value. A verb whose
glyph is not yet established on screen, and an irreversible action with a small
target, keeps a label *or a glyph the surface already uses for that same
meaning*: discarding a steer, removing an attachment, and cancelling the
composer's edit are all the close glyph, so that card never words one and glyphs
another. At minimum a `title` and an `aria-label` name the outcome, and the
tooltip is also the only teacher on a hoverless device. A dashed outline is
the one border a control may own, and only for absent data — the unlabeled-turn
chip marks a placeholder, not a resting clickable state. A comparison label
(`HEAD → working tree`, the compare menu's between-chips arrow) is an
expression, not an icon: typed characters stay legal inside data.

Icon-first is not icon-always. The words stay wherever a glyph cannot carry the
operation's *object and scope*, and there are eight such groups in this client:

| Control | Why words rather than a glyph |
| --- | --- |
| `Review`, `File`/`Diff`, `Changed (3)`/`All files`, `Compare…`, `Refresh` | The words name which rendering, which state pair, or which read is being re-run. No glyph distinguishes two renderings of the same object without inventing a vocabulary for it, and a lone circular arrow among four text chips in one header would be the only glyph in the row — the same mixed-kind problem as the recovery bar below. |
| `Collapse files`/`Expand files` | A second chevron pair in the same review bar collides with the lines toggle one row below; the words are the only thing carrying the scope. |
| the `Full output` chip, the changes count | Values, not actions. |
| `Load failed — retry`, `Send "Continue."`, the recovery bar's `Retry` and `Edit` | The label is the mechanism: it says what will happen (`Retry` re-requests from a clean boundary, `Send "Continue."` adds a turn, `Edit` forks and resends), and that difference is the whole reason the row exists. This is why the recovery row is words even though the turn toolbar draws `Edit` as a pencil. |
| `Cancel`, `Done`, `Open link`, `Open comparison` **in a dialog footer** | A footer is a decision surface rather than a tool surface: two verbs of unequal emphasis, where both must be the same kind of thing. The composer's own `Cancel` is the close glyph instead, because that card already draws "abandon what is in here" that way for steers and attachments. |
| `Load more` | The ghost tier's own example — a continuation, not an action on an object. |
| `Browse files` | A link inside running prose; a glyph inside a sentence is a different problem from a glyph in a row. |
| a row menu's `Close`, `Archive` | One glyph on one item and none on its sibling is worse than no glyphs; menu rows are a text surface. |

Three rules keep the glyph rows honest. **One kind per surface**: a tool surface
(the composer card, a card toolbar, the file browser header) is all glyphs, and a
decision surface (a dialog footer) is all words, because a single glyph beside a
single word reads as a mistake in one of them. **A pane name pairs with a close
glyph, never with a word**: the file tree is `Files` while it is closed and its
dismiss is the `CloseIcon`, because a name and a verb are different kinds and a
pair must be one. **One consequence per glyph**: the dictation row discards a
recording with `CloseIcon` (the audio is gone) and cancels a pending polish with
`StopIcon` (the transcript is intact), because a single glyph for both would
leave the row unable to say which of the two a click performs.

**Implementation.** One spec, one file: `web/src/render/buttons.module.css`
holds the ghost control and feature modules adopt it with CSS Modules
`composes` (`composes: ghost from "../../render/buttons.module.css"`), never by
restating its states. That keeps one declaration site without a global utility
class, so the global stylesheet stays tokens, base elements, shell geometry,
focus, and scoped third-party corrections.

**The cascade layer order is declared in every file that opens the `control`
layer, and it must be.** `composes` does not link rules — the bundler inlines a
copy into every consumer — and a layer's priority is fixed by the first
appearance of its name in the *bundled* stylesheet, not by the order the source
files feel like they have. The inlined copies reach the CSS chunk before
`app/index.css` does, so declaring the order only in `index.css` registered
`control` first: preflight's `button { color: inherit; background-color:
transparent }` then outranked every ghost rule, and the controls lost both their
rest ink and their hover fill in the built client while the dev server, which
injects one copy ahead of everything, looked correct. The statement is
idempotent, so `index.css` and `render/buttons.module.css` both carry the full
list and whichever lands first establishes it — a statement placed after any
rule is too late. `scripts/check-bridge-styling-tokens.mjs` fails on a file that
opens the layer without it, and on any order other than
`theme, base, components, control, utilities`.

**These rules are gated, not just written.**
`scripts/check-bridge-icon-contract.mjs` (in `npm run check`) fails on an inline
`<svg>` outside the glyph set, on a geometric or emoji character in the document,
and on a solid mark rendered outside its family's slots. It also requires every
exported `<Role>Icon` to be classified, so adding a glyph forces an ink-mode
decision where it is added. Typed slot values could not catch any of this on
their own: the slot union proves a number is legal, not that the glyph belonged
there.

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

The installed-app surface is the one place where the token boundary stops:
there is no `theme-color` meta and no `<style>`-themed asset, because the OS
chrome and the launcher tile are painted before any stylesheet or media query
of ours runs and cannot follow the app's ladder. The manifest carries the light
page tone (`background_color`, `theme_color`) and the icon generator carries
the brand pigments (`web/build-icons.ts`, next to the mark's 4×4 cell grid);
both are install metadata consumed outside the document, not renderable colors,
so neither belongs in `@theme`. A `theme-color` pair would be the opposite — a
second declaration site for `--color-background` — and is deliberately absent.

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
intercept clicks outside each toast. Connection down states remain full panels
or a topbar chip rather than relying on a transient toast.

Secure-context guidance is not a toast: it is a one-time dialog on the shared
`render/Dialog` portal surface, raised the first time a capability is withheld
because the page is not a secure context — a clipboard write that fails, or
notification permission that is unavailable or denied on a plain-HTTP origin.
It shows only the detected browser's escape hatch: Firefox's `about:config` →
`dom.securecontext.allowlist` with this hostname, or a Chromium browser's own
`<scheme>://flags/#unsafely-treat-insecure-origin-as-secure` with this origin.
WebKit-based browsers (Safari, and the iOS builds whose user agents name Chrome
or Firefox) have no per-origin allowlist and get only the localhost-tunnel
alternative. Each of the page, the setting name, and the value has its own copy
control. Those controls alone take the dialog-scoped legacy `execCommand`
fallback, because the origin that needs the guidance is exactly the one without
`navigator.clipboard`; ordinary app copy actions keep using the modern API
exclusively. The dialog is raised at most once per browser session
(`sessionStorage`), never stacks while open, and never appears on a secure
origin, so an ordinary permission denial is not misreported as a deployment
problem.

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

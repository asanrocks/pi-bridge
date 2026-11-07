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
sidebar history, pick up queued work, read the conversation, inspect
thinking and tool actions, copy text or tool artifacts, open file links, and
browse branches in History. A steerer can do the following:

- Send a prompt from an attached Session. A prompt clears its draft
  optimistically and restores it only when the daemon refuses the admission
  (`ok: false`, so nothing ran), so a refused or offline send does not lose
  text. A reply that never arrives is treated as an unknown outcome instead:
  the turn may be running, so the draft stays cleared and the reattached
  Session shows what happened. An image-only prompt is valid.
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
- Choose a model and thinking level from the model picker. Model selection is
  client-local (the stateless client API): there is no model verb — the
  picker's pick rides with the next send, which also consumes it, so a later
  send inherits from the path the turn recorded instead of a stale pick. What
  the picker shows before any pick is that same inheritance: the path the
  send continues (an edit forks at the edited message's parent, a compose
  continues from the live leaf) names the model of its last recorded change,
  else the producer of its last assistant message, else the session's live
  model — the model an uncarried send runs on. The thinking level inherits
  the path's last recorded change the same way, clamped to the model's
  supported levels — the clamp is the single authority, so the level shown and
  the level carried cannot disagree. A pick is an override, not a default: it
  survives a rewind, and it survives a steer — a send admitted while a turn is
  in flight carries nothing (the running turn keeps its model) and keeps the
  pick for the next idle send. Known gap: inheritance prefers a recorded
  change over an earlier answer's producer, while a cold resume prefers the
  producer, so an automatic fallback answer reads as the recorded model here
  and as the fallback's model after a reopen. The picker is
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
  never the symbol, and the tooltip names the action. Hover and the keyboard
  cursor reveal the same pin (`data-cursor`), because Shift+Enter's target has
  to be visible to the user who presses it. Shift+Enter toggles the focused row;
  pinning appends to the tail, so a new pin never becomes the default. Ctrl/Cmd+P
  cycles the pinned list in its order; Shift reverses the cycle. The controls
  remain available whenever connected.
- Reorder the pinned list by dragging a pinned row's grip handle. The
  insertion line shows the landing slot, the move applies to the pinned group
  only (the handle exists nowhere else, and a drag that leaves the group lands
  at its nearest edge), and it commits once on release; membership is frozen
  while the picker is open, order is not. Reordering is pointer-only: the grip
  drag is the one gesture that moves a row, because the app's global
  Alt+Up/Down chord already cycles the work queue. A refused replacement
  (connection lost, verb rejected) rolls the rows back to the last accepted
  order. The head of the list
  carries a `default` label: it is the model a fresh Session starts on, which is
  why the ordering is a control rather than a detail. The picker's edits are
  one replacement of the daemon-global list (ADR 20), so the pin toggle and
  the drag send the same shape and the pushed list is the verdict.
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
directories and, below them, the work queue: every queued Session —
notified (awaits input), busy (an execution in flight), deferred (parked) —
in the daemon's queue order (notified → busy → deferred, each group newest
activity first). Above the Project list, a plain Latest button (ADR 13) reads
"Latest session" plus the owning Project's id — selecting it navigates to
`/@latest`, which resolves to the most recently active queued Session that is
not deferred, without redirecting. The same alias is available
scoped to a Project (`/<projectId>/@latest`): deep links and the CLI banner
use that form, which resolves inside the Project and falls back to its home.
The Latest button is deliberately not a queue-row duplicate: no state mark,
preview, or time. It exists only while something is queued. Queue rows show a
state mark — notified keeps the success-green dot, busy uses the streaming
color and pulse with a "running" chip, deferred uses the accent tint with a
"parked" chip — name or first-message fallback, Project, the shared time label
tracked to the Session's last activity, and a latest-message preview.
Selecting a Project opens its Project home at `/<projectId>`.

Project home is an unattached, compose-first surface. It shows the expanded
`HomeCompose` card, focuses the textarea, and starts a new Session when the
first prompt is sent. The first prompt, images, and the pre-session model and
thinking level are admitted together. The draft is
scoped to the Project, and an explicitly chosen model is persisted in one
local Project slot. The default pick is the first pinned model — the curated
group's head — so a fresh Session starts on it; with no pins the send carries
nothing and the daemon resolves (the settings default, else a provider
default, else the first available model), which is also what the display
falls back to (`ProjectInfo.defaultModel`). The displayed
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
(nothing below the row), active (only the Project's queued rows), open
(queued rows plus history) — cycled by clicking the folder row (chevron +
name are one target; the name does not navigate). The chevron mirrors the
state: right (folded), diagonal (queued only), down (open). Missing fold
state defaults to `active`, so a fresh Project shows its queue without
history. A folder with no queued rows has only two states: the active step is
skipped
in the cycle and a stale persisted `active` renders folded, since "active
only" is indistinguishable from folded there. The `Projects` header label
is the fold-all toggle: it applies one uniform state to every folder — the
smallest step strictly above every folder's current effective state, up
the ladder `folded` → `active` → `open` (the `active` step exists only
when some folder has queued rows), wrapping to `folded` at the top. A
click therefore always changes every folder — no dead clicks — and
fold/unfold mixing never survives a click. Each folder also
has exactly one navigation affordance, the `+` button, which opens the
Project home — the compose surface where the first prompt creates the
Session (there is no empty-Session creation path). Folder children sit
flush-left with the folder row; hierarchy is carried by the chevron and
row fills, not indentation. The three fold targets share one hover
signature: the `Projects` label and a folder row both step the meta ink to
the foreground and paint nothing, while the `+` beside them takes the fill
because it is an icon control (see
[Iconography and control surfaces](#iconography-and-control-surfaces)). A
folder row's hover is not a row state: it is a fold control, and the fill
channel belongs to rows that carry identity or position.

Folder children:

- The Project's queued Sessions are pinned first and remain visible
  in the `active` and `open` states, in queue order: notified → busy →
  deferred, each group newest activity first. The state mark derives from the
  durable state alone — a green dot means notified (awaits input), an orange
  pulsing dot means busy (an execution in flight), and the accent tint means
  deferred (parked: still open, but not next). The attached `(Project, stem)`
  row is the only selected row: the accent tint plus weight `500` on its name,
  per Row states below. A folder row never carries identity — it is a fold
  control, not a target.
- Dormant Session history is fetched when a folder unfolds, ordered into
  `Today`, `This week`, and `Earlier`, and each row carries the shared time
  label (relative while fresh, then a clock, a weekday, or a date). The bucket
  boundaries are read from the same classifier as those labels, so a heading is
  never contradicted by the rows under it.
  A chevron at the list's end requests the next page: the continuation is the
  one sidebar control drawn as a glyph rather than words, because "more below"
  is the meaning a chevron already carries, and this one sits below the content
  it extends while the pane's fold carets sit on the row above theirs. A dormant
  row has a muted status dot and no row menu.

The queued rows and history rows open Sessions. A row menu exposes `Close`
without confirmation on queued rows — close clears queue membership,
terminating a runtime first when one exists, and is legal on a dormant queued
Session — `Defer`/`Restore` on non-busy queued rows (the user's
parking toggle; a deferred row's menu reads `Restore`, a notified row's reads
`Defer`, and a busy row hides it), and `Archive` on any durable row — archive
closes the session then moves its file out of discovery, so it is how history
is thinned without opening each session. The grid action beside the `Projects`
header returns to the global launcher. Empty, loading, failed-with-retry, and
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
is the editable Session name, falling back to `pi-bridge`: the name is a
value the surface shows, so it takes no control box — a hover fill would
paint the flex-wide strip rather than the name — and answers the pointer with
an underline on the name itself, the same signal an inline link carries. Its right control
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
renderer — whose code-block copy button is restyled onto the app's floating
chip through unlayered attribute overrides (`app/index.css`), so it matches
the per-message Copy chip.

Until the wire confirms the rendered address (an address-bearing initial
sync), the published document is a local guess, and the conversation never
asserts what it cannot back — the loading tri-state. An unconfirmed document
with no content is *pending*: turn-shaped placeholder bars (a user-tinted row
and assistant text lines, pulsing on the shared liveness keyframes) render in
place of the empty-state copy, which is a claim about the server's transcript.
A session switch is instant by the same mechanism: a navigate paints the
target's cached prefix immediately (the previous conversation is replaced at
once, not kept under the new address), so the switch reads as immediate
wherever the browser has seen the session before. A *seeded* document — this
address's own last-known state painted from the cache, on boot or on the
instant switch — renders the content with the same skeleton continuing
after the last message: visibly not finished, asserting no failure, in place
of any derived failure presentation. A *staged* document — a navigate in
flight with no cache for the target, keeping the previous session's turns
published — renders untouched: the old conversation is still valid reading,
and appending the new session's wait to it would mis-attribute it. When the
initial sync commits, the skeleton or continuation is replaced by the
authoritative transcript, which materializes into the layout the placeholder
previewed. A wire-confirmed empty session renders the guidance copy ("No
messages yet. Send a prompt to begin."). The history pane's graph follows
the same rule on its own empty state.

The viewport follows structural and streaming growth (including expanded
thinking blocks, synchronized with deferred Markdown DOM layout via the column
`ResizeObserver`; collapsed thinking blocks stay fixed at one line and do not
drive follow after their initial line) while the reader is at the bottom,
advancing only when the content end extends below the current viewport bottom.
Scrolling upward pauses follow, including within the tail-slack range.

A sent message is different: the sent user turn top-anchors — the whole turn
container, header metadata included, not the text — and auto-scroll freezes
for the turn, so the reader's own message stays the reading position while
the reply streams in below. The freeze is unconditional for the turn and
lifts only when the reader scrolls down to the live end while content extends
below the parked viewport, presses the jump button, or switches sessions: reaching
the live end before anything streamed below (or after collapsing a block back
into the parked viewport) is circumstance, not intent, and
must not lift it. The anchor scroll itself is animated (instant under
prefers-reduced-motion), and the frozen viewport's park position — not the
transient mid-animation position — is what the content-below check measures
against. Top-pinning the tail needs scroll range below it, which the tail
rarely has on its own, so the conversation column always carries tail slack:
the minimum manufactured scroll range that keeps the live path's last user
turn pinnable at the viewport top — exactly the just-sent reading position,
available at any time (an idle session landing, or a plain scroll down), not
only while a turn is frozen. It is trimmed down as content streams in below
the pin and grown back when content shrinks (refreshed ahead of fold-landing
measurement on collapse so a pre-slack browser clamp cannot pull the parked
turn down from the top),
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
button is a round chip (the floating category's one shape variant — see
"A control that floats over content keeps a container") drawing an arrow, and it
floats horizontally centered on the conversation column (inset to the
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
The dot speaks the app's shared dot vocabulary: red while disconnected
(the transport outranks everything), orange and pulsing while something is
in flight — a streaming turn or a document the wire has not confirmed yet
(the loading tri-state) — and green at the confirmed idle state.
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
is hidden below 640px and the model name is clipped to an 8em box with an
ellipsis, its thinking suffix dropping with the tail; otherwise control order
is shared between desktop and mobile. The clip is a truncation, never a
substitute label: the row keeps the name it was given, so its leading token
still says which family (`Claude…`, `GPT…`, `DeepSeek…`) is in force, and the
button's `title` carries the whole name. Send is disabled
when disconnected, empty, compacting, or already committing, but is enabled
during streaming to queue a steer. Model and thinking selection are separate
from Send and can be changed while connected. Send and Stop are the row's only
filled controls and the client's only two; every other control in the row is
chromeless — the glyph-only ones compose `ghost` or `dim`, and the model and
cost readouts are value disclosures: their words are the whole control, with no
caret beside them, because a text control carries no glyph (see
[Iconography and control surfaces](#iconography-and-control-surfaces)).
The two readouts share one box, `.composerValueBtn`: 28px, the same step as the
attach and microphone squares, holding `--fs-xs` words and nothing else — so
Send and Stop at 32 are the row's only boxes of their own size. On a coarse
pointer that box keeps its 28px and a transparent overlay of the row's own gap carries
the target to 36, the rule the chip category follows.

When the tail turn is broken — it ended in an error after retries were
exhausted, was stopped (a user Stop or a session close mid-run, which leave
the same trace), had its tool work terminated mid-execution, or was cut off
after its tool results but before its final message — the dead turn grows an
error row carrying the recovery controls (ADR 16). The error row is the one
failure presentation and the one recovery carrier: its line is the turn's
real error or abort text, or — when pi persisted no error at all, the silent
data-loss shapes — a synthetic line in the same error hue ("Interrupted
while running tools", "Interrupted before the reply finished"), so a
half-dead run is never visually quieter than a provider error. Both derive
only from a wire-confirmed document: an unconfirmed tail (a cache seed's
quiesced state, a staged navigate) renders the loading continuation
instead — a mid-sync document is not a claim about the server's run. The
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
containing a dot, the shared time label (so a row from another day names that
day), and message preview. The active path uses the accent
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
asks, and no separate timeline pane. Each opens the browser on an explicit
endpoint pair; none infers a turn-scoped window git cannot know.

- **The turn menu** carries the review windows for a user turn: the commits
  observed during the turn (`UserTurn.gitTransitions`). Each row is a verb and
  its object — `Review all 3 commits`, `Review <subject>`, `Compare with
  worktree` — because the row is a command and reads as one; the endpoint pair
  belongs to the browser's header, which names both ends, not to a 12px row
  where an abbreviated oid pair is seventeen characters the reader cannot use.
  The rows name observed identity transitions: a stamp whose commit differs
  from the previously observed one, attributed to the turn open at its path
  position — a prompt stamp is persisted before the message it labels, so
  it closes the previous turn while its identity becomes the next turn's
  baseline. A turn with several commits also offers one union window from the
  first transition's old commit to the last one's new commit. The live path's
  last user turn additionally offers **Compare with worktree** (its send state
  → `worktree`), the honest form of "what happened since this prompt" — it is a
  sampling point, so the browser marks it `as of` and refetches on settle. Earlier turns and peeked paths offer no worktree
  item, because comparing them to the current worktree would silently span
  other turns. The turn's own identity at send (branch and short commit, with
  the commit subject) is a row in its
  [details ledger](#turn-headers) rather than a header chip, so the header has
  one disclosure instead of two.
- **The git card** (`Review`) opens that one commit against its first parent,
  resolved host-side. It is the card's only review meaning; the turn's
  transition windows belong to the turn menu, so there is no second `diff`
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
tree, a turn menu or a git card's `Review` control opens a changed-files
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

Both message turn types share one compact header (ADR 21) whose order never
changes: date disclosure, existing label, a trailing reading, the controls the
measured column affords, and the action menu. Missing fields take no space, so
a turn with no label and no reading is a date and a menu. The header never
expands into a metadata strip, and it falls back to a second line rather than
clipping a value when the essential fields cannot fit one line.

- **User turns** show the header (date, the `#`-prefixed label when the message
  has one, then the controls) and the message's Markdown and images. The tinted
  row carries the role, so no `You` verb is rendered; the row is a named
  `article` (`User message`) so assistive tech keeps the distinction. A
  user-defined label is a bookmark set from pi's tree selector or in-app: the
  chip is the direct edit trigger and opens a bounded editor panel (Save and
  Cancel; Enter commits, Escape dismisses) rather than swapping an inline field
  into the header, because an inline field changed the header's width while it
  was open. Creation is a menu command, so an unlabeled turn spends no header
  width on a ghost affordance. Labeling is blocked while peeking another branch
  or a turn is in flight. The header's inline controls are the sibling pager
  when the turn has siblings, then Copy, then Edit; see
  [Turn headers](#turn-headers) for the ordering rule and how width moves them.
- **Assistant turns** show the header plus the turn's Markdown and actions. The
  header's trailing reading has two mutually exclusive tenants: while the turn
  streams it carries the live status (`working for 12s · 2 running`), and once
  the turn seals it carries the rounded context reading (`17%`). They cannot
  collide — the percentage only exists with the turn's last usage — so progress
  costs no second line and the slot swaps in place at the seal. The percentage
  stands alone, matching the composer's own reading; its meaning and its change
  are the details ledger's `Context` row and the reading's tooltip, which is a
  hint rather than the only route to the numbers. The live span is the one
  progress signal that does not wait for a content delta. Each text block has
  its own copy action because one assistant turn may contain several messages,
  and that chip is shown as a control only when it can be used (see the reveal
  rule in [Styling invariants](#styling-invariants)). Streaming text uses the
  streaming Markdown mode and a cursor; provider errors, aborts, and
  output-length stops render beneath the content.
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

### Turn headers

The header is a single row with a fixed order: date, label, reading, controls,
menu. Fields read left, actions own the right edge: the reading stays in the
flow beside the date instead of docking to the controls, so a value's position
does not move when the column's tier moves commands between the header and the
menu — and adding a command later shifts nothing that is already placed. A
reading and a label never share a header (a reading is an assistant field, a
label a user one), so neither competes for the other's width. Two rules make it
hold at every width.

- **The date is the statistics disclosure.** It renders the shared relative /
  calendar time ladder as a value readout — chromeless text, no caret, the same
  classification as the composer's cost readout, with `aria-expanded` and the
  hover fill as the only marks — and opens a read-only ledger (`role="dialog"`,
  anchored, width-capped, body scrolls) of
  hairline-separated sections, each a list of labelled rows. Assistant turns
  show three sections: the producer (`Model`, `Provider` — as separate rows,
  because composing them into one string duplicates the provider that many
  catalog names already carry), the window reading (`Context` with its change),
  and the timing (`Time`, `Duration`, `Tools`). User turns show two: the timing
  (`Time`, `Since last reply` — a measurement, not a claim about the user's
  attention) and the repository state, split the same way (`Branch`, `Commit`,
  `Subject`: a branch and a commit are different facts, and the subject belongs
  to the commit). Unavailable fields are omitted rather than rendered as zeroes,
  and each row hides on its own — detached HEAD has no `Branch`, an unborn branch
  has no `Commit`, a v1 stamp has no `Subject`. A `Tools` row appears only once
  the share passes a second, because a sub-second share is noise next to the
  total and a turn with no tool calls resolves its share to zero — which would
  otherwise render as a confident `<1s`, a measurement the turn never made.
  `Since last reply` follows the same rule for its own reason.

  Every value keeps a label. That is the difference from the cost popover, whose
  values are all money and describe themselves; here a model name, a percentage,
  and two spans sit in one panel, so a bare `15%` would be a number with no
  subject. Sections need no headings — the divider is the group — and estimated
  spans carry a `~` in the value (`~1m 19s`) instead of a footnote sentence
  explaining that turn durations are derived from seals. The rows are one grid
  for the whole panel — a single `max-content` label column and a
  `minmax(0, 1fr)` value column, which the sections join through `subgrid` so
  every value sits on the same vertical edge instead of each section sizing its
  own labels. Values are **left** aligned (right-aligning a column of numbers is
  what the cost ledger wants, but this one holds prose, and a wrapped sentence
  ragged on both ends reads as a mistake) and labels are **baseline** aligned to
  their value's first line, so a wrapped subject keeps its label on the line the
  eye starts at.

  A missing or invalid instant keeps the trigger's shape as a clock mark rather
  than the word `Details`: the slot names a time everywhere else, so a word
  there reads as a verb among values. A streaming assistant turn has no sealed
  instant of its own yet, so it names its start anchor — the seal of the entry
  that opened it, usually the prompt, the same reading its live span measures
  from — and the turn's own instant takes over when it seals. The date never
  shrinks: an ellipsized date reads as a different date.
- **The menu owns every command that is not inline.** Ownership is exclusive: a
  command is either a header control or a menu entry, never both, and resizing
  the column moves it between the two. The menu is a `role="menu"` whose
  trigger is a `More` glyph; it focuses its first item on open, roams with
  arrows/Home/End, and returns focus to the trigger when it closes. A turn with
  no command renders no trigger instead of an empty menu. Two consequences are
  worth naming: the label chip edits an existing label, so the menu offers only
  `Create label`; and the date owns the details, so the menu does not repeat
  them.

Controls are ordered by where the row is anchored and by how often they are
used: an item's distance from a right-anchored row's edge depends only on the
items to its right, so the optional pager takes the leading slot and Copy, Edit,
and the menu keep their positions when a turn gains a branch. The fixed run is
descending frequency (Copy, then Edit) with the overflow last, which is also
where a command arrives when the tier collapses. The menu orders by likely use
instead of mirroring the row — a list reads top-down, so a spatial mirror would
bury Copy under `Previous branch`.

The tier comes from the measured conversation column, not the viewport or the
pointer type: at 560 CSS px and above the header keeps the pager, Copy, and
Edit; from 340 to 559 it keeps Edit; below that the menu is the header's only
control. Edit is the compact tier's keeper not because it outranks Copy in use
but because it is the correction path: a wrong or superseded message must be
one tap from its fix, while Copy is a tap away in the menu. The label is the one flexible field — it ellipsizes before the date,
the reading, or a control yields — and the row wraps to a second line rather
than shrinking text, a control, or a touch target. The commands are revealed on
hover, focus, or the keyboard cursor and are simply visible on touch, like every
other hover-revealed control: the header repeats once per turn, so glyphs
standing on every row are chrome the reader did not ask for, and opacity keeps
the reserved slot's layout stable. The tier decides *what* is present, so the
reveal never changes the set, only the ink. State is not a command: the
`Editing` badge sits beside the label, outside the revealed group, because a
state indicator that appeared only on hover would be a hidden state.

### Action groups and cards

Consecutive thinking and tool blocks form one renderer-owned action group;
text blocks always break a group and remain inline in their original position.
The group header is a neutral summary with a collapse triangle and one
kind-colored dot per present tool hue, plus the group's elapsed time
dright-aligned (`took 20s`, or `running 4s` while a call in the group still
runs) — an estimate anchored on the earliest call and the latest result, so
parallel calls count once. A single action uses the same group
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
  monospace`. Reserved for code, terminal I/O, file paths and URLs, and machine
  tokens (git refs and short oids, status letters) — never for labels, prose,
  names, or counts: a count in mono, an error sentence in mono, or a setting's
  `Off · global setting` in mono makes the face stop meaning machine text, and
  each of those was in the app until the face became an allowlist. A model id is
  a name, not code: the composer's model label, the picker's rows, and the cost
  ledger's per-model keys are UI-stack chrome, like the picker's search field and
  its `More…` verb. `check-bridge-styling-tokens.mjs` holds the face to its
  `MONO_SITES` table, so a new mono rule has to name what in that surface is
  machine text.

Sizes come from the five-step `--fs-*` token scale: `--fs-xs` (11px — meta,
group headers), `--fs-sm` (12px — action summaries, sidebar rows, menu rows
including the model picker's), `--fs-md` (13px — small body, code, card
content), `--fs-lg` (14px — empty states, the path-completion dropdown), `--fs-xl`
(16px — body and composer, the reading baseline). The
mobile breakpoint drops only `--fs-xl` to 14px; Markdown inline content scales
relatively (see the inline-scale invariant below).
`check-bridge-styling-tokens.mjs` holds both ends of this: a `font-size` must be
a scale token (or `inherit`, or a relative `em` inside a Markdown host), and the
steps this section names for a role — a menu row, a dialog's verbs, the
composer row's readouts, a worded verb in a row — are pinned in its
`CONTROL_TYPE` table, so moving a control to another step is a recorded
decision rather than a silent drift.
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
- **A control's state transition is one token.** `--state-transition`
  (`app/index.css`) is `color` plus `background-color` at `--dur-fast`, and the
  ghost tier declares it. `transition` is a single property, so a host that
  animates its own reveal (`opacity`, `transform`, `visibility`) must restate
  the whole list — and restating it by hand is how the floating chips' hover
  colour came to switch in one frame while the ghost buttons' eased, since the
  reveal rule's `transition: opacity …` replaced the tier's without naming the
  state channels. Hosts append `var(--state-transition)` to their list instead,
  and the one control outside the tier (Streamdown's code-block button, which
  cannot compose it) states the same token so it animates exactly what a
  composed chip animates.
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
- **A control's box follows its content.** Glyph-only controls are
  chromeless: no background and no border, state in the ink plus one optional
  hover fill. A control that carries words takes a boundary, because the words
  are what have to read as actionable; the composer's Send and Stop stay the
  only filled verbs, and a value chip or a row is neither. States live in the
  ink either way, never in restated chrome. Icon-only is the default for verbs,
  and no in-document control is a font glyph or an emoji. See
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
  tooltips, and empty states (`Show all`, `Retry now`). Uppercase —
  only via `text-transform`, never typed caps — for short structural labels
  (section headers, mode badges), always with small positive tracking. Data
  (timestamps, paths, model names, status values) takes natural formatting with
  no case transformation. Ellipses use the `…` character, not `...`.
- **Time has one ladder, one detail string, one duration spec.**
  `formatWhen(iso, now)` is the visible label: relative while the row is fresh
  (`just now`, `N min ago`), then the clock (`14:05`), then `yesterday, 14:05`,
  then the weekday (`Tue, 14:05`) for the rolling week, then the date (`Nov 3`,
  or `Nov 3, 2025` outside the current year). Escalating to the calendar is what
  makes a list answerable without a hover; a clock-only label cannot say which
  day a row belongs to. Every label is a `<time dateTime={iso}>` whose `title`
  is `formatWhenFull(iso)` — date, 24h clock, and zone — so the exact instant
  stays available on hover and on touch. Labels depend on the clock: hosts read
  `useNow()` (one shared 60s ticker per page) and never `Date.now()` during
  render, which would freeze a memoized row. Durations are a separate
  classifier: `formatDuration(ms)` (`1.2s`, `30s`, `2m 03s`, `10m`) for a
  measured tool run, `formatSpan(ms)` (`<1s`, `12s`, `2m 3s`, `1h 5m`) for an
  estimated turn or action-group span. Never route an instant through either. A live turn span
  ticks every second (`useTurnClock`) because it is not a label and cannot
  afford a minute of staleness. Locale is pinned `en-US` and instants are
  device-local;
  relative wording is app microcopy, so it is not delegated to
  `Intl.RelativeTimeFormat`, while calendar parts come from `Intl` so DST and
  month lengths are never computed by hand. Session buckets read the same
  classifier, so `Today`/`This week`/`Earlier` cannot contradict a row's label.
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
  are not nested cards. Elevation is an ordering, not a hue: the raised tier
  (`--color-surface-raised`) is the only surface documented as sitting above the
  page, so it is what an anchored panel takes (`--color-popover-bg`), while the
  chrome tier is a *recess* in light and a *rise* in dark and can never carry a
  floating surface. An overlay is separated from its host by tone, hairline, and
  shadow together, never by tone alone. Radius stays in the token scale, with the composer as
  the deliberate larger-radius exception. A hairline border is a boundary
  between two surfaces — a field, a portal, a card, a thumbnail; the one other
  boundary is the control that carries words (see
  [Iconography and control surfaces](#iconography-and-control-surfaces)).

### Row states

A list row shows four states — selected or not, times hovered or not — but they
are two dimensions, not four styles. **Identity** is persistent (the session
you are attached to, the model in force, the file you opened); **position** is
transient (the pointer, or the keyboard cursor in a list that moves one).

| | not selected | selected |
| --- | --- | --- |
| rest | no fill | accent tint (`--row-selected-alpha`), name weight `500` |
| position | `--color-muted` | the same tint one step down (`--row-selected-hover-alpha`) |

- **Hue-locked, not layered.** Both dimensions live in the fill channel, so
  they take different hues: identity is the cool accent, position the warm
  neutral. A warm wash and a blue wash at similar luminance are distinguishable
  at a glance; two warm washes 1.03:1 apart are not.
- **One value per state, no overrides.** A selected row declares its own hover
  step, so selection and pointer feedback coexist. A
  `sidebarItemSelected:hover` that repaints the resting identity fill is the
  defect this replaced.
- **Strength is a token.** `--row-selected-alpha` and
  `--row-selected-hover-alpha` carry only a number; the tint is mixed with
  `transparent` at the use site so it composites over the row's own surface
  (chrome sidebar, page-tone portal) rather than pinning a hex per host. 30% is
  1.28:1 on the chrome and 1.30:1 on the portal — past texture, and legible
  because the pair also differs in hue. It sits below the 1.4:1 control-state
  floor deliberately: that floor was written for a fill that carries the state
  alone, and identity here also carries weight.
- **Identity is not a band.** A leading stripe spends a gutter rows do not all
  have and is the last thing a left-to-right scan finds.
- **A structural header never paints a state fill.** Group and section headers
  are a hairline plus an uppercase `--tracking-caps` label; a header fill
  1.09:1 from the hover fill reads as a hovered row.
- **Reveal follows position, not the pointer.** A row control revealed on hover
  appears for the keyboard cursor too (`.portalItem[data-cursor] .portalPin`),
  or the user who needs Shift+Enter never sees the target. `aria-current` (and
  `aria-selected` where the row is a `treeitem`) is the non-visual channel.
- **Rows whose fill already carries meaning keep it.** The History graph's
  path membership and the action rows' hues are semantic: position there is a
  stronger alpha of the same hue, and identity moves to the row's mark column
  (the history node dot) or the edge.
- These rules are gated: `scripts/check-bridge-styling-tokens.mjs` fails a
  `:hover` rule painting `--row-selected-alpha`, a structural header at rest
  painting a row state fill, and any use of the retired `--color-accent-soft`.

### Iconography and control surfaces

**Four categories, picked by usage scenario.** A control is added by naming
its scenario, and the scenario picks the whole treatment — there are no axes to
compose and no per-button reasoning. Each category is one mechanism with one
home, `render/buttons.module.css`:

- **A glyph action in a row** — the ghost tier, chromeless at rest: the glyph
  is the only thing that marks the control as actionable. `dim` and `quiet` are
  this tier's ink steps for dense rows and labels, not categories of their own.
- **A worded action** — the outlined tier: a word cannot mark itself as
  actionable, so it owns the lightest compliant boundary at rest.
- **A control over content** — `floating` over uniform content,
  `floatingOnImage` over an image: a glyph-only ghost *by rule*, plus the
  container recipe that keeps it legible against what it floats on. It never
  carries words — a worded chip hovering over prose is a dialog pretending not
  to be one — so that combination is not discouraged but unnamed: the
  icon-contract gate fails a worded button that resolves to the chromeless
  tier, and `floating` composes ghost.
- **A surface's primary command** — the filled tier, a closed family: Send,
  Stop, a dialog's confirm, the compare menu's `Apply`, `Retry now`, the label
  panel's Save. One command per surface, at its edge; a new member is a
  decision made at review, recorded in the gate's allowlist.

Everything else in this section is detail *under* a category — glyph slots and
ink modes when a glyph is added, the container recipe and the reveal rules
when a chip floats, the tier states when a control carries words — consulted
after the scenario has named the control. The paragraphs that follow are that
detail, in the order a control is built: the glyph set, the box, the tiers'
ink, and the floating category's placement rules.

A control is a hit target carrying one glyph **or** one label, never both: the
two are alternative ways of saying what the control is, and a control that wears
both says it twice. A glyph-only control paints no background and no border at
rest, so its only ink is the symbol; a control that carries words takes a
boundary, because a word has nothing else marking it as actionable. Chrome that
exists to announce clickability competes with `--color-border`'s single job — hairlines between
surfaces — so the boundary a control may own is the outlined tier's
`--color-border-control` and nothing else.

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
  label), 14 in compact control rows (card toolbars and turn headers, row menus), 16 for
  full-size icon controls (composer row, dialog and portal actions, the
  fullscreen viewer's close), 20 for chrome (TopBar and pane-header toggles).
  "The row" outranks "the label": a mark that leads words takes its row's slot,
  not the words' step — the changes badge's branch is a 20px mark in a pill of
  `--fs-xs` words, because the pill is a TopBar sibling and a meta-sized mark
  beside 20px neighbours reads as a clipped glyph. A
  feature picks a slot, never a number; 11, 13, and 18 are drift, and so is a
  per-call-site size.
- **Two ink modes, assigned by family.** Outline is the default. Solid is a
  closed set of three families with their own slot rules. **Object marks** (Copy,
  Check, Eye, Wrap, Markdown) were drawn to match Streamdown's solid copy
  pair and now ARE the pair it renders — the renderer draws this set's
  `CopyIcon`/`CheckIcon` through its `icons` prop, so the copy art cannot
  fork between ours and its; they are legal at 12 and 14 only, because a
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
- **Shell coordinates are names, not numbers.** The frame has one action column
  (`--action-col`, a list's `--pane-inset` plus an `--action-gap`), one
  TopBar-band control box (`--control-box`, with `--control-box-sm` and
  `--control-box-xs` below it), and one band height (`--topbar-row`, the band's
  height minus twice `--topbar-pad-y`). They are declared in `app/index.css`
  under "Shell coordinates" and consumed by name: a pane header's action and the
  TopBar toggle it replaces are the same two names, so the corner control cannot
  drift between the hover target and the drawer it opens. This exists because
  the numbers used to be restated: one x-coordinate was derived five ways (a
  list inset, a row padding, a slot offset, a header padding, a group padding)
  and one control box was written eight times, which is the same bug five times
  — alignment prose in the doc, five copies of the arithmetic in the CSS.
  `scripts/check-bridge-styling-tokens.mjs` fails a rule that restates a listed
  coordinate instead of consuming the token, and fails when a listed rule
  disappears, so the table cannot rot silently. The sidebar list does not use a
  `subgrid` column for the same alignment: the trees' rows are buttons with their
  own fills and absolutely positioned menus, so a grid restructure would add
  structural risk without removing a remaining way to disagree — the column is
  one token and the gate holds every consumer to it. Revisit only if a third
  pane needs the same column, where a shared grid would be cheaper than three
  consumers of one token.
- **One anchored panel, positioned by CSS.** `render/Popover.tsx` is the only
  anchored surface: it owns the dismiss backdrop, Escape, and the chrome in
  `render/Popover.module.css`, and a consumer supplies the trigger element, a
  placement (`below` / `above`), an alignment, and its own item geometry. The
  trigger carries an `anchor-name` while the panel exists
  (`render/useAnchorName.ts`, a layout effect so the panel never paints at its
  static position); the panel declares `position-anchor`, `anchor(bottom)` /
  `anchor(left)` insets, and `position-try-fallbacks` for the flip. A `DOMRect`
  snapshot went stale on the first scroll, and the clamp arithmetic it needed was
  restated per popover — four backdrops and four chromes whose only difference
  was the pigment. The sides are physical (`left: anchor(left)`):
  `<anchor-side>` is a closed set with no `inline-start`, and an invalid side is
  silently dropped — the inset then falls back to `auto` while the block offset
  stays anchored, so the panel opens in the right column at the wrong place.
  `check-bridge-styling-tokens.mjs` validates every `anchor()` argument and fails
  a fixed `--shadow-2` panel declared outside the named exceptions, for the same
  reason. Escape belongs to the innermost panel (`dismissOnEscape={false}` stands
  an outer one down), because two capture-phase document listeners cannot be
  ordered by nesting. Two surfaces still take rects: `PathCompletion` anchors to
  a textarea caret (not an element, so it needs a zero-width anchor element
  rather than a token) and the model picker receives one from its host.
- **An anchored panel is one surface with two content anatomies.** The panel's
  box is chrome and is identical everywhere: `--color-popover-bg` (the raised
  tier, one step above the portal surfaces), `--color-portal-border`,
  `--radius-md`, `--shadow-2`, and a 4px outer pad. The tone is not the host's,
  because the chrome tier's direction flips between themes — light puts
  `--color-card` below the page, dark puts it above — so a floating surface that
  inherited it would be recessed in one theme by construction; the gate asserts
  both that `--color-popover-bg` aliases `--color-surface-raised` and that the
  raised tier stays lighter than the page in each theme. What a consumer adds is
  content, not chrome: **action rows** (one line: a label and an optional inline
  detail at `--fs-sm` and `--fs-xs`, a hover fill, `role="menu"` with `menuitem`
  children; an unavailable row keeps its place with `aria-disabled` so its
  detail can name the reason — touch has no tooltip) or a **ledger** (labelled
  sections and key/value rows at `--fs-xs`, `role="dialog"` with a name, no
  focus management, and at most one `role="switch"` row).
  A row is one line because the item count is the line count: a wrapped label
  over a detail line renders as three rows, and a four-item menu was read as
  six. There is no checkable row. A state that a press *changes* is an instant
  effect, and a `menuitemcheckbox`'s only cue is a mark that is absent when the
  setting is off — so an off toggle looks exactly like a command, which is
  NN/g's toggle-switch anti-pattern ("separate controls that produce instant
  results from those that require clicking a command button"). The ARIA menu
  pattern leaves no middle ground: menu children are `menuitem*`, so a setting
  belongs in a `role="switch"` row of a dialog ledger instead. The ledger owns
  its inner padding in a body wrapper rather than widening the panel, and
  in-panel separators are `--color-border` like every other in-panel edge. The History
  pane's superseded list composes the shared surface (`composes: surface`) while
  keeping its own position: it is an in-flow disclosure inside the scrolling content, so it comes
  This assumes the client's browser floor (`anchor()`, `subgrid`, `color-mix()`,
  cascade layers) — a 2026 baseline, not a 2021 one.
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
- **A worded control carries no glyph.** The converse, and the rule the value
  readouts broke: a text-based control is text and nothing else — no leading
  mark, no trailing caret, no badge glyph. A wording control's marks are the
  hover fill, `aria-expanded`, and its own boundary where the tier gives it one
  (the outlined tier, because a word cannot mark itself actionable). Two glyphs
  are content rather than decoration and stay: a **fold caret**, whose direction
  *is* the open/closed state — `sidebarSectionToggle`, the folder row, a tool
  card's fold, expand-all-lines, the output cap, load-more — and a glyph that
  carries the **value's own meaning** where the text cannot: the unknown
  instant's clock, and the branch mark that names what the uncommitted count
  counts. A chip or readout that states a value and decorates it with a chevron
  says the value twice, and the cheaper half never carried information.
  `check-bridge-icon-contract.mjs` holds the line: a recorded text control
  (`TEXT_CONTROLS`) may not render an `<…Icon>` unless its glyph is one of the
  named content cases (`TEXT_GLYPH_OK`).

**State is ink, not chrome.** A ghost control — and the outlined tier, which
composes it — has five states and one ink channel each:

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
`border-color` change, which it cannot do anyway once it has no border. This
section is about controls: a row's identity *is* a surface, and its two
channels are specified under Row states above.

**The tier owns the ink; the host composes a variant to move it.** Two variants
step the ghost's rest ink down to the meta level for the row it lives in. `dim`
is a glyph-only control at `--color-muted-foreground` with the fill intact — a
glyph in a dense row reads dimmer than the tier's rest ink, and the fill is
glyph-only control's own channel. `quiet` is the same ink for a fold label, and
it drops the hover fill so a label inside a section header paints no rectangle.
A host must not state that ink itself: `composes` inlines the tier into the
`control` layer, so a host `color` is unlayered and outranks `.ghost:hover` —
the ink then freezes at rest while the fill keeps moving, which is how the
`Projects` label came to paint a hover rectangle over unmoving caps. A hue the
tier cannot know stays a host decision: the error hue on a recovery verb, or a
value already at `--color-foreground`, where the ink is the signal and has no
step left to take. `check-bridge-styling-tokens.mjs` fails a tier host that
restates `--color-secondary` or `--color-muted-foreground`, or inherits its ink,
for that reason.

**Glyph-only is chromeless; words take the boundary.** `quiet` serves the one
control that is words without being a verb-style button: the `Projects` fold-all
label, which has to sit in its header as a label and not as a chip. Every other
text control is `outlined` — the file browser's header verbs and its review
bar's, `Load failed — retry`, the whole-file toggle, the git card's
`Review`, RecoveryBar's `Retry` and `Edit`, a dialog's cancel — so the boundary
is a property of carrying words rather than of the host that happens to contain
the control. Fills stay with the glyph-only controls and with the rows, which
own the fill channel for position and identity: the icon controls beside those
verbs keep theirs, because a glyph has no words to carry the change. The
conversation's fold headers are the standing exception, deliberately: they are
card heads that already sit on the action hue, so their hover darkens the hue
they sit on instead of restating the outlined verbs' signature inside a card
whose anatomy is a tint.

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
state. Everything else is a ghost when it is glyph-only and outlined when it
carries words. A new filled control has to be that same
thing — a command issued at the edge of a surface whose state changes something
— and Send and Stop are the only two whose glyphs are also transport solids, in
`--color-on-accent`, so box and symbol never disagree about weight.

**A boundary belongs to the container, or to the words.** This is the rule the
rest of this section follows from. A glyph-only control earns a line or an edge
by being a container or by floating over content — never because of what the
glyph is; the proof is in the app twice: the turn header's Copy and the
per-message Copy chip are the same glyph in the same box, and only the floating
one has an edge. Their boxes agree because they are one token: `--chip-box`
(`app/index.css`), which the compact copy controls consume by name — the
composed `.floating` recipe and the attribute override for Streamdown's own
code-block button. The header's Copy takes it too, even though its row's ladder
would say 28: a glyph-only control's box follows its ink, and the Copy mark is
wide and squat enough that 28 leaves it undersized. Words are the other case:
nobody can tell that a bare `Review`
is clickable, so a text control owns its boundary at rest and does not depend on
a host container lending it one.

**The tiers behind the categories.** The category decides which tier a control
takes; this table is the detail — what each tier looks like and the ink steps
between them. The tiers differ in *kind*, not degree. Each tier is a class in
`render/buttons.module.css`, so a feature composes it rather than restating its
states:

| Tier | Shape | When |
| --- | --- | --- |
| ghost | no box, ink `secondary` → `foreground`, `--state-fill-alpha` fill | a glyph-only control's default — card toolbars, the composer's attach, the turn header's Copy |
| `dim` | ghost at meta ink (`--color-muted-foreground` → `foreground`), fill kept | a glyph-only control that should read dimmer than the tier's rest ink in a dense row — card toolbars, the header's fold carets, the topbar's changes badge |
| `quiet` | `dim` without the hover fill | the one text control that is a label rather than a verb — the `Projects` fold-all toggle |
| outlined | 1px `--color-border-control`, surface's radius | every control that carries words — `Review`, `File`, `Load failed — retry`, `.recoveryBtn`'s `Retry`/`Edit`, a dialog's cancel |
| filled | accent fill, `--color-on-accent` | the primary command *of the surface* — Send, Stop, `Retry now`, a dialog's confirm, the compare menu's `Apply` |

The two variants are the tier's ink steps, not tiers of their own: they declare
the rest ink *inside* the `control` layer, which is the only place a host can
dim a control without outranking its own hover rule (see
[State is ink](#iconography-and-control-surfaces)). Ink dimmer than the meta
level is not a smaller step of the same thing — a glyph that dims further stops
reading as a control at all.

The tiers are enforced, not just described: `check-bridge-icon-contract.mjs`
fails a `<button>` whose class resolves to none of them, unless its class is in
the gate's role table (backdrop, row, menu item, fold header, chip, floating
control, inline link) with the reason — and it fails a `<button>` whose own
children are literal words but which composes the chromeless tier instead of
`outlined`/`filled`. The one sanctioned worded chromeless control is the **value
disclosure** — a readout whose words *are* a value (the composer's model and
cost, the turn's date, the comparison chip, the uncommitted count) and not a
verb; those are recorded in the gate (`TEXT_VALUE_OK`, `TEXT_CONTROLS`) and, by
the rule above, carry no glyph of their own. That second check is what the
earlier sweeps lacked: a text control that composes no box at all is either a
declared role or a bug, and
`review`/`file` were the bug. The same gate closes the filled family (a file
composes `filled` only when the gate's allowlist records the command it is the
primary of, and a stale entry fails) and gives the chip's edge one home
(`--shadow-chip` may appear only in the recipe and the Streamdown override
seam).

The outlined tier is the boundary's home, and it is the lightest compliant one:
`--color-border-control` sits at 3.18:1 on the page and 3.35:1 on the raised
composer, the warmest grey that clears WCAG 1.4.11 — where `--color-border`
(1.47:1) separates surfaces and cannot define a control. A button is never both
outlined and filled, and a destructive verb takes the error hue in whichever tier
it uses. The cost is real and is paid in scale rather than in compromise: a text
verb owns a hairline at `--fs-xs`, and because each one is a bounded box the
transcript's verbs no longer compete with the tool rows and error lines that
carry the meaning — the boundary is what keeps a label from being read as prose,
not what makes it loud. That is why the tier's padding stays at the chip scale
(`1px 6px`, `2px 8px`) and why the box is never filled, shadowed, or resized on
hover.

**A control that floats over content keeps a container.** The attachment remove
button sits on a thumbnail, the jump button floats over the conversation, and the
per-message copy chip and the Markdown code-block copy chip float over content:
what is beneath them is content, not a row, so each keeps a container to stay
legible against it. That is a legibility requirement, not chrome. The whole
category is one mechanism with one home — `render/buttons.module.css` composes
it as `floating` (and `floatingOnImage`), a glyph-only ghost tier plus the
container below, so a host states only placement, box, and reveal. Streamdown's
own code copy button is ported onto the same recipe through the unlayered
`[data-streamdown]` override seam in `app/index.css`, because its class cannot
be composed; it carries the same ink, hover, box, reveal (including the
keyboard focus branch), copied-check duration, and glyph — Streamdown renders
the icon set's own `CopyIcon`/`CheckIcon` through its `icons` prop
(`render/markdown.tsx`) — as the per-message chip, so the two Copy controls
read as one control. The one confirmation detail every copy control shares is
`COPIED_FEEDBACK_MS` (`infra/lib/clipboard.ts`), the Check-swap duration — and
the same module announces "Copied to clipboard" through a visually hidden
polite live region, because the swap and the button's `aria-label` change are
invisible to a screen reader and a label change is not announced.

The container has one recipe with two variants, chosen by what is underneath:

- **Over a uniform surface** (page tone, a card): opaque `--color-surface-raised`
  fill plus `--shadow-chip`. The fill alone is 1.05:1 on the page, which is why a
  semi-transparent or bare surface reads as a hole punched in the text; the
  half-pixel ring in `--shadow-chip` is what makes it a shape.
- **Over an image**: opaque fill plus a 1px `--color-border-control` ring and no
  shadow. An image's luminance is arbitrary, so the boundary must clear 3:1 on
  its own, and a drop shadow says nothing against a photograph.

Two placement rules follow. A floating control stays inside the element it
belongs to and never crosses that element's top edge upward — the copy chip's
earlier `-8px` offset put it behind the fixed TopBar whenever its line sat at the
top of the viewport, which reads as clipping (the attachment remove's corner hang
is the scoped exception: a badge on media, where no fixed chrome sits above it).
And the box takes the slot its glyph fills: the copy mark is wide and squat, so
24 rather than 28 is what makes a 14-slot glyph read at size. Elevation is never
nested — a control inside a dialog, menu, or toast carries none, because its host
already floats.

**Hover is a state layer plus the ink step, never the ink alone.** A control is a
surface, so the surface answers the pointer: the chip's fill moves to
`--color-surface-raised-hover` while the glyph steps `secondary` → `foreground`.
That layer is the surface mixed with `--state-fill-alpha` of the ink
(`app/index.css`), which is what makes it both opaque (a chip over content may
never show the text beneath) and hue-correct: naming a chrome surface token
instead — `--color-muted` — put a warm block over the cooler page tone and the
chip read as a different, dimmed control rather than the same one under the
pointer. Material's proportions put a pointer hover at an 8% layer and focus or
press at 12%; the app's 20% is the same idea, and it is one weight for every
control so a chip and the ghost beside it answer the pointer equally.

The failure the rule exists to prevent is one channel doing the work of two: a
chip that restated `--color-surface-raised` on hover changed nothing visible,
and the only feedback was a glyph darkening, which reads as the control being
*off* rather than under the pointer. The persistent member (the jump button)
adds an elevation step on hover — it is visible whether or not it is hovered, so
hover has to read as liveness rather than as the reveal.

**Shape is the one place the category has a variant, and it is one member.** The
copy chips are squares at `--chip-box`: their job is to look like a thing
stamped onto content the reader is already looking at. The jump button is round,
and is the app's only round control, because it is the only member that is not an
annotation — it is a free-floating transport over the whole conversation, it never
sits inside a text box, and it has no neighbours to align with. The circle is
what distinguishes it from a chip at a glance without spending a colour or an
edge on the distinction. Surface, edge, ink, and hover it shares with the
category; only its shape and its hover elevation step are its own.

**A transport glyph is not a disclosure glyph.** The jump button draws
`ArrowDownIcon` (a shaft with a head), not a chevron: a chevron is the disclosure
mark that opens something in place, and this control moves the reader through the
document. The same reasoning that gives Send an arrow instead of a paper plane
(`ArrowUpIcon`) applies in the other direction, and it keeps one mark meaning one
thing across the app.

**A hidden control takes no hit area.** Opacity is a paint channel, not an
interaction channel: a control revealed by fading in must also disable
`pointer-events` while hidden and restore both from the same ancestor rule
(`:hover`, `:focus-within`, focus-visible). Otherwise the invisible box keeps
answering clicks, and on a fading chip that sits over prose the reader who taps
the line's right end to place a caret copies the message instead, and a drag
selection begun there never starts. When the input cannot hover at all, the
control is visible and interactive unconditionally, so the faded state is never
reached. This rule is gated, and the gate is not scoped to buttons: the icon
contract fails any rule that fades a class- or attribute-selected element to
`opacity: 0` without taking it out of hit-testing — a wrapper that fades a
cluster of controls (`cardControls`) and a mark that yields its slot (the
sidebar timestamp) are the same bug on a `div` and a `span`, so the scan covers
every element. Keyframe steps and pseudo-elements are out of its scope: the
former is animation, not a reveal, and a pseudo-element's hits bubble to the
element it hangs from.

**A chip that cannot be hidden keeps one box and changes only its placement.**
On coarse pointers the copy chip is visible and interactive at all times, so it
cannot be an overlay on the first line — that corner must place a caret, and a
tap there would copy instead. It leaves the overlay and enters the flow as a
float at the segment's top-right, so the paragraph wraps beside it and no text
is painted over; scroll containers (the code-block body, the table wrapper)
establish their own formatting context and shift beside the float rather than
sitting under it. The code-block copy chip takes the same float idiom on coarse
pointers (`app/index.css`): Streamdown's hover-only reveal would strand it
unreachable without hover, so the pill enters the flow beside the code. The
width stays the hover-revealed chip's 24px, and the touch target comes from the
`::after` overlay every `.toolbarBtn` grows on a coarse pointer — a 40px box
here would read as a different control from the turn header's Copy even though
both carry the same glyph.

The float's *height* is the one value that must differ, and it is a line-height
rather than a slot: a float shortens every line box it intersects, so a box
taller than one prose line trims the opening line and nicks the second, leaving
two ragged line ends and a visibly empty wedge beside the chip. One line of the
chip's own type (`1lh`, and the chip is `--fs-xs` inside body prose) stays inside
the first line box, so exactly one line wraps and the waste is one ragged line
end, which is what wrapping prose around a control costs.

**A coarse-pointer target borrows only the flow's own gap — unless the control
floats over nothing.** The annotation chips' target is the 24px box plus a 6px
transparent overlay (36px, clearing the WCAG 2.5.8 floor with room): the chip
sits inside text, and every invisible pixel the target adds is taken from the
caret placement and selection that text needs, so the target stops at the
flow's own gap rather than growing to the 44px of WCAG 2.5.5. The jump button
is the other case — it floats over the conversation, not over characters, so
its coarse-pointer target is the full 44. Both copy chips offer the same 36
(the code-block chip through the Streamdown seam), because one control split
across two hosts is exactly the drift the box ladder exists to forbid.

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
operation's *object and scope*. The table is keyed by **surface and control**:
grouping by the verb alone is how the composer's `Cancel` and a dialog footer's
`Cancel` were once treated as one case when they are two.

| Surface | Control | Why words rather than a glyph |
| --- | --- | --- |
| File browser header | `Review`, `File`/`Diff`, `Changed (3)`/`All files`, `Compare…`, `Refresh` | The words name which rendering, which state pair, or which read is being re-run. No glyph distinguishes two renderings of the same object without inventing a vocabulary for it, and a lone circular arrow among four text chips in one header would be the only glyph in the row. |
| File browser review bar | `Collapse files`/`Expand files` | A second chevron pair in the same bar collides with the lines toggle below it; the words are the only thing carrying the scope. |
| Tool card | the `Full output` chip, the uncommitted count | Values, not actions. |
| Sidebar folder, dead-turn error row | `Load failed — retry`, `Send "Continue."`, the recovery bar's `Retry` and `Edit` | The label is the mechanism: it says what will happen (`Retry` re-requests from a clean boundary, `Send "Continue."` adds a turn, `Edit` forks and resends), and that difference is the whole reason the row exists. This is why the recovery row is words even though the turn header draws `Edit` as a pencil. |
| Dialog footer | `Cancel`, `Done`, `Open link`, `Open comparison` | A footer is a decision surface rather than a tool surface: two verbs of unequal emphasis, where both must be the same kind of thing. The composer's own `Cancel` is the close glyph instead, because that card already draws "abandon what is in here" that way for steers and attachments. |
| Composer hint line | `Browse files` | A link inside running prose; a glyph inside a sentence is a different problem from a glyph in a row. |
| Sidebar row menu | `Close`, `Archive` | One glyph on one item and none on its sibling is worse than no glyphs; menu rows are a text surface. |

Four rules keep the glyph rows honest. **One kind per surface**: a tool surface
(the composer card, a card toolbar, the file browser header) is all glyphs, and a
decision surface (a dialog footer) is all words, because a single glyph beside a
single word reads as a mistake in one of them. **A glyph whose meaning is
universal is legal in a words surface**: the sidebar list's continuation is a
chevron while its failed-load row stays `Load failed — retry`, because the
chevron states only "more of the same, below" — a meaning it cannot get wrong —
whereas the retry row has to name the failure and the mechanism. **A pane name
pairs with a close glyph, never with a word**: the file tree is `Files` while it
is closed and its dismiss is the `CloseIcon`, because a name and a verb are
different kinds and a pair must be one. **One consequence per glyph**: the
dictation row discards a recording with `CloseIcon` (the audio is gone) and
cancels a pending polish with `StopIcon` (the transcript is intact), because a
single glyph for both would leave the row unable to say which of the two a click
performs.

**Implementation.** One spec, one file: `web/src/render/buttons.module.css`
holds the ghost control, its two ink variants, and the outlined and filled
tiers; feature modules adopt them with CSS Modules `composes`
(`composes: quiet from "../../render/buttons.module.css"`), never by restating
states or inks. That keeps one declaration site without a global utility
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

**These rules are gated, not just written.** The styling gate also rejects a
`composes: ghost` rule that draws `--color-border` (a hairline cannot define a
control) or carries any elevation other than `--shadow-chip` (a control in a row
does not float).
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
there is no `<style>`-themed asset, because the OS chrome and the launcher
tile are painted before any stylesheet or media query of ours runs and cannot
follow the app's ladder. The manifest carries install-time tones
(`background_color` is the light page tone for the install splash;
`theme_color` matches `--color-sidebar` so an installed app's status bar
blends with the top bar) and the icon generator carries the brand pigments
(`web/build-icons.ts`, next to the mark's 4×4 cell grid); both are install
metadata consumed outside the document, not renderable colors, so neither
belongs in `@theme`. `web/index.html` adds a `theme-color` meta pair split by
`prefers-color-scheme` with the same `--color-sidebar` values: browsers honor
`media` on it, so the toolbar tint — and, in installed Chromium apps, the
status bar — follows the OS ladder without script-controlled theme state.
The literals duplicate `@theme` deliberately: they address browser/OS chrome
outside the cascade, so `scripts/check-bridge-styling-tokens.mjs` (scoped to
`web/src`) does not see them. The last piece is
`apple-mobile-web-app-status-bar-style: black-translucent`: in an installed
iOS web app the view extends under a transparent status bar, and `PaneShell`'s
`env(safe-area-inset-top)` padding lets the top bar paint that strip. In
normal Firefox browsing none of this reaches the OS status bar — it belongs
to the browser, not the page.

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
- Alt+Up and Alt+Down cycle the work queue (queue order). Alt+N opens the only Project's
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
  clips the live model label to its first characters with an ellipsis. Primary
  Send and Stop targets retain their touch size. The model picker flips below
  its anchor when there is insufficient space above.
- Hover-only card controls become visible on touch-capable inputs, and
  coarse-pointer targets grow. Safe-area insets protect overlays, the drawer,
  and the fixed composer from notches and the home indicator.
- The turn header is not governed by this breakpoint: its control tier follows
  the measured conversation column (see [Turn headers](#turn-headers)), because
  a narrow desktop pane has the same width problem as a phone. The menu carries
  the commands the column cannot hold.

The 640px composer breakpoint only changes compact control presentation; the
768px breakpoint changes pane topology. The document remains the scroll
container on mobile so browser URL-bar collapse and soft-keyboard behavior
remain coherent.

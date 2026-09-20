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
  current sibling position and navigates to the newest leaf below the chosen
  sibling. `h` and `l` perform the same previous/next sibling action for a
  focused user turn. There is no separate regenerate button: regeneration is
  represented by edit-to-fork plus the sibling pager.
- Navigate to Sessions and branches. Opening another Session is allowed while
  the current Session streams; the old stream continues without the tab
  attached. Branch navigation through a pager, History, or `h`/`l` is blocked
  while streaming or compacting because it would race the in-flight turn.
  Closing a live Session is destructive and unconfirmed: it stops and flushes
  the live runtime while preserving its history file. Closing the currently
  viewed Session lands on that Project home.

The UI distinguishes three busy cases. Streaming permits steering and
Session switching, shows Stop, and drives live conversation updates.
Compacting shows Stop but disables Send, edit, and branch navigation.
Disconnected state makes Send, attachments, and model selection unavailable;
drafts remain local and are kept for retry.

## Shell Layout

The shell uses the viewport as the document scroller. The fixed TopBar and
side surfaces do not scroll with the conversation. On desktop the usual
composition is a left Sidebar, a middle conversation column, and an optional
right History pane. The conversation column clears the side-surface gutters
and reserves the live composer footprint at its bottom.

### Launcher and Project home

The global launcher at `/` lists configured Projects with their working
directories and active Sessions. Active rows show a liveness dot, name or
first-message fallback, Project, relative time, and a first-message preview;
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

The attached topbar mirrors these states with a compact clickable connection
chip; the launcher panel remains the full explanation when no Session is
attached.

### Sidebar

The Sidebar is a Project tree with two kinds of children in each expanded
Project folder:

- Active Sessions are pinned first and always remain visible when the folder
  history is folded. A green dot means active and an orange pulsing dot means
  streaming. The attached `(Project, stem)` row is the only selected row and
  uses the accent tint.
- Dormant Session history is fetched when a folder expands, ordered into
  `Today`, `This week`, and `Earlier`, and shown with relative timestamps.
  `Load more` requests the next page. A dormant row has a muted status dot and
  no close action.

The Project name opens the Project home; its chevron only folds the history.
The active rows and history rows open Sessions. A live row menu exposes
`Close` without confirmation. The Projects header returns to the global
launcher. Empty, loading, failed-with-retry, and no-session states occupy the
same quiet message position in the folder.

On desktop the Sidebar has three modes: hidden, a docked resizable rail, and
full-screen overlay. The rail width is persisted and bounded for readable
rows. Dragging below its minimum hides it; dragging above its maximum previews
and enters the overlay. While hidden, hovering the topbar hamburger opens a
temporary peek drawer; clicking the drawer pins the rail. A 12px left-edge
drag zone can reveal and size the rail. Selecting a Session dismisses a peek
or mobile overlay.

On mobile the Sidebar has only hidden and full-screen overlay modes. The
overlay covers the shell, closes from its corner button or Escape, and uses
safe-area insets. The selection model and folder contents are unchanged.

### Topbar

The TopBar is fixed between the Sidebar and History gutters. Its left control
is the Sidebar hamburger when the Sidebar is hidden or on mobile. Its center
is the editable Session name, falling back to `pi-bridge`. Its right control
opens History. A down-state connection chip sits beside the name and retries
when clicked. In desktop rail mode the Sidebar edge is the close affordance;
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
does not. The jump button returns to the live end. History anchors and
keyboard focus scrolls account for the fixed TopBar and composer.

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
clock control and Ctrl/Cmd+H toggle it. On desktop it is a docked, resizable
right pane that publishes `--history-w`; the TopBar and conversation clear the
same gutter. On mobile it is a right drawer with a dismiss backdrop and
safe-area insets, so it contributes no layout gutter.

The pane renders a git-log-style graph of user-message branches. SVG vertical
lineage and cubic fork curves sit beneath fixed-height DOM rows containing a
dot, time, and message preview. The active path uses the accent treatment;
the current deepest user message is filled. A `+N` badge groups consecutive
off-path aborted re-edit drafts; opening it reveals the individual drafts.
The pane scrolls to the active row when opened but does not keep repositioning
the reader on every new leaf.

Selection separates looking from branching:

- When idle, selecting any row anchors the conversation to it and navigates to
  the newest leaf in that subtree.
- During streaming or compaction, an on-path row remains usable for
  look-only anchor scrolling. Off-path rows and their draft rows are disabled
  with a `Jump after reply` title until the reply settles.

### File viewer

File-path Markdown links open the in-app `FileViewer` instead of navigating to
the daemon origin. Each open performs a fresh read from the attached
Project's working directory. The viewer shows the resolved absolute path,
loads Markdown as rendered prose and other files as syntax-highlighted code,
and reports the server's 256 KB truncation. Escape, the close button, or the
dimmed backdrop closes it.

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
  shown beside `$`; output uses the shared status and result controls and
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
`show all` control; the normal details region is capped at 300px and signals
clipping with a fade. Touch inputs keep hover controls visible.

Action rows use four semantic hues: edit and write share the mutate hue,
bash uses the streaming hue, thinking uses the neutral think hue, and read
uses the dimmed read hue. Each row has the same uniform tinted background and
3px left strip. The group legend and row strip use the same hue tokens. There
is no per-action status dot; status is carried by timing and the card status
line.

Expanded tool cards have a status line, full path or command header, error or
truncation notices, and a content region on the page surface. Read shows
highlighted file content; write shows written content; edit shows a unified
diff; bash and PowerShell show command output with tail/full controls; grep,
find, and ls show argument and result rows; unknown tools use the fallback
argument and output renderer. Copy, line wrapping, Markdown rendering for
Markdown files, and `show all` are card-local controls. Tool arguments and
results can arrive while a call is streaming, so a card renders available
content without waiting for a path or command annotation.

Thinking is prose rather than an operation card. A non-empty block collapses
to a one-line first-line preview and expands inline as Markdown beside its
triangle. Redacted or empty thinking is a static muted label. Git-change cards
can appear inside an action group after the action that observed the change;
the group summary and legend include the git hue.

## Styling Invariants

This section is normative for additions to the web UI. It is the authority
for new buttons, chips, action rows, and Markdown hosts.

- **Tokens are authoritative.** All design colors, surfaces, text levels,
  accents, status colors, action hues, overlay colors, radii, and font sizes
  are declared in the `@theme` block in `web/src/app/index.css`. Components
  consume `var(--color-...)`, `var(--kind-...)`, `var(--radius-...)`, and
  `var(--fs-...)`; they do not introduce raw hex colors. Shadow rgba values
  are structural elevation, not a second color palette.
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
  negative letter spacing; the existing compact uppercase section labels use
  only their established small positive tracking.
- **Surface hierarchy is restrained.** The page is warm off-white, the
  Sidebar/TopBar are a warmer chrome surface, user turns have a light blue
  tint, and the composer is the raised white surface. Cards are reserved for
  individual actions, dialogs, file viewing, and repeated rows; page sections
  are not nested cards. Radius stays in the token scale, with the composer as
  the deliberate larger-radius exception.

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

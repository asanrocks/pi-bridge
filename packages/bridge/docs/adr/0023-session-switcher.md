# ADR 23: The Session Switcher

**Status:** Implemented. All four commits landed; the file stays until the
manual narrow-viewport pass verifies the compact switcher on a real device,
after which its current-truth content is folded into the permanent docs and
this file is deleted (the Code Quality rules' ADR progression).

Builds on the durable session model this record shipped with — four states
(`inactive | notified | busy | deferred`) in
`<sessionDir>/.pi-bridge/states.json`. That model has since been replaced by
Session locations (Inbox / Later / Archive) plus a runtime `running` attribute
— see [host runtime](../host/runtime.md) "Session locations" and
`src/host/session-locations.ts`. Read `inactive` as Archive, `notified` as
Inbox, `deferred` as Later, and `busy` as Inbox + running; the affordances this
record decided (queue-ordered folders, the fold ladder, passive awareness, the
compact switcher) are unchanged apart from the row menu replacing the state
toggle. Its within-group ordering rule (`last activity descending`) is
superseded too: the queue is ordered by placement stamp, most recently placed
first, so a running turn cannot reorder the list. So is its visible-page
delivery (a per-completion toast): a visible page is announced by the badge
alone, whose ring marks the completions this page has not read, and only a
hidden page raises an OS notification. Current truth for all of it is
[web design](../web/design.md), with the order itself defined by the shared
comparator in `src/core/queue-order.ts`.

## Context

The session states shipped, but the affordances did not follow. Three gaps:

1. **No passive awareness.** A completion is observable only through the
   attached conversation (tab title, unread count, browser notification from
   `useStatusNotifications`, which watches `document.status.isStreaming`). A
   session finishing elsewhere updates the queue silently. The badge-free
   hamburger tells the user nothing while they work on another session.
2. **Monitoring costs too much.** Skimming a busy session means: expand the
   sidebar, find the row, click it (losing the current draft's surface),
   read, and reverse the whole path. On mobile this is two full-screen
   overlay round trips.
3. **State changes are hidden and incomplete.** The only state controls live
   in a hover-revealed overflow menu whose verbs (`Close`, `Defer`,
   `Archive`) mix attention management with history management. A dormant
   session cannot be promoted to `notified` or `deferred` from the UI at
   all — `setSessionState` already allows it (the Worker checks the durable
   file, not a runtime; `worker-local.ts` `setSessionState`), so the gap is
   purely a missing control.

## Decision

The Sidebar becomes **the session switcher** — one surface that finds and
organizes sessions. It keeps the project grouping and the shared side-pane
machinery (`render/PaneShell`, `useSidebarShell`); everything inside it is
re-ordered around the durable states:

1. **Rows are state-ordered.** Within each project folder, sessions render in
   the order `notified → busy → deferred → inactive`, each group by last
   activity descending (superseded: within a group the queue now orders by
   placement stamp, most recently placed first — see the status note). Queue
   rows (notified/busy/deferred) come from the
   `queue` store slice; inactive rows come from the lazily fetched history
   page, filtered by queue membership as today.
2. **Folder folds are state-scoped.** The tri-state fold becomes
   `collapsed → working → all`:
   - `collapsed` — project name only;
   - `working` — notified and busy rows only (the **default**);
   - `all` — working rows plus deferred and inactive rows (history fetch).
   A folder with no working rows skips the `working` step in the cycle, as
   the current no-active rule does. A `collapsed` folder that hides rows
   states the hidden count quietly (e.g. `+3 parked`) so deferred work is
   findable.
3. **The state indicator is the quick state control.** The row's dot becomes
   a control beside the row button (the `sidebarMenuBtn` pattern — a sibling,
   never a nested button):
   - `inactive` → click promotes to `notified`;
   - `notified` ↔ `deferred` — click toggles;
   - `busy` — read-only; the tooltip says why.
   The row menu keeps only **Mark inactive** (renamed from Close) and
   **Archive**. Archive is history management, not a session state, and stays
   in the overflow menu.
4. **Working rows carry a preview line.** A `notified` row shows the latest
   assistant reply (one clamped line). A `busy` row shows current activity —
   the running tool with its elapsed time (`Bash · 15 min`), falling back to
   `Responding…` / `Compacting…`. Deferred and inactive rows stay compact.
5. **Mobile gets a compact switcher.** On a narrow viewport, the TopBar
   hamburger opens a popover (anchored to the button, `render/Popover`)
   listing only notified and busy rows, project-grouped, with the same
   order, preview lines, and state controls; a **View all** row at the end
   opens the fullscreen switcher. Picking a row opens the session and
   dismisses the popover. Desktop behavior (rail, hover-peek, overlay) is
   unchanged.
6. **The hamburger carries a waiting badge.** The badge equals the global
   count of `notified` sessions (including sessions in collapsed folders),
   updating via `queue_changed`. Completion signaling becomes queue-derived:
   a `busy → notified` transition the user did not cause fires an in-app
   toast when the page is visible (and the session is not the attached one),
   or a browser notification when the page is hidden — carrying the session
   address so the click opens it.

UI wording uses the plain labels: **Waiting / Running / Parked / Inactive**
for display; `notified/busy/deferred/inactive` remain the wire and state-store
names.

## Non-goals

- No change to the state machine, its persistence, or its transition rules
  (`src/host/session-state.ts` is untouched except as noted for activity
  metadata).
- No second session-list surface: the launcher's work-queue section and the
  sidebar show the same rows and the same controls — the launcher section is
  restyled to match, not duplicated logic (it already reads `store.queue`).
- No conversation-surface state control and no in-conversation preview
  sheet; the switcher covers both. Bulk history → deferred marking is
  deferred itself until the single-row flow proves out.

## Implementation

Four commits, each independently shippable. Acceptance criteria are the
agreed contract for each; the general gates for every commit are: focused
tests for changed behavior, `npm run check` from the repository root
(includes the web TypeScript gate and the styling-token check), and the
owning docs refreshed in the same change.

### Commit 1 — Project-grouped session switcher

**Scope.** Row ordering, fold states, quick state control, promotion.

Web, `web/src/features/sidebar/`:

- `useFolderExpansion.ts` — the fold union becomes
  `collapsed | working | all` with cycle
  `collapsed → working → all → collapsed`; migrate the persisted
  `localStorage` record (`folded → collapsed`, `active → working`,
  `open → all`); default stays the working-equivalent. The header's
  fold-all ladder and the boot-expand effect follow the renamed states.
  The "skip the working step when no working rows" rule replaces
  `nextFoldState`'s `hasActive` input (same shape, new name).
- `ProjectFolder.tsx` — children render as one state-ordered list:
  queue rows (from props, already ordered by `compareQueueRows`) followed by
  the history page's non-queued rows. The `Today / This week / Earlier`
  grouping is replaced by the state grouping — inactive rows sit under the
  inactive tail of that order. The hidden-count affordance renders on
  `collapsed` folders that hold rows (`+N parked`).
- `SessionRow.tsx` — the dot becomes a sibling control in
  `sidebarItemWrap` (the `sidebarMenuBtn` positioning pattern): always
  visible, minimum touch target via a padded hit area (the 6px glyph is not
  the target), `aria-label` names the action ("Mark as waiting", "Park this
  session", "Running…"). The row menu drops `Defer`/`Restore` (moved to the
  indicator) and renames `Close` to `Mark inactive`.
- `Sidebar.module.css` — hit area, two-state dot styles carry over; the
  token boundary rules apply (`scripts/check-bridge-styling-tokens.mjs`).
- `Sidebar.tsx` / `SidebarContent.tsx` — prop plumbing only
  (`onSetSessionState` reaches history rows too; `hasQueued` becomes
  `hasWorking`).

Host: none. `setSessionState` already accepts dormant sessions.

**Acceptance criteria.**

- Each project folder orders sessions notified → busy → deferred →
  inactive, newest activity first within each state (the ordering half is
  superseded; see the status note).
- Folder cycles collapsed → working → all, defaults to working, and a
  collapsed folder with hidden rows states the count.
- The indicator applies inactive → notified and notified ↔ deferred; busy is
  read-only with an explaining tooltip. The actions are available on history
  rows without opening the session.
- State changes persist (reload + Worker restart) and converge across tabs
  via `queue_changed`.
- Opening or skimming a session never changes its state.
- Mark inactive and Archive remain available and distinct in the overflow
  menu.

**Tests.** `useFolderExpansion` unit tests (cycle, skip rule, migration);
a `ProjectFolder` ordering test over hand-built `SessionInfo` rows; the
existing `test/suite/session-state-wiring.test.ts` extended with a
dormant-promotion case through the verb (busy refusal, dormant notify).

### Commit 2 — Session previews and live activity

**Scope.** The busy/notified second line, with host-side metadata for
sessions that are not open.

Core wire (`src/core/types.ts`, `docs/core/protocol.md`):

- `SessionInfo` gains an optional `activity` summary — a tagged value:
  `{ kind: "tool", name: string, startedAt: string }` for the running tool
  (the most recently started in-flight tool when several run),
  `{ kind: "responding" }`, `{ kind: "compacting" }`. `startedAt` is derived
  at emission (`now − elapsed`); the client renders elapsed against its own
  clock, the same rebase rule the conversation view applies to
  `status.inFlightTools`.

Host (`src/host/session-actor.ts`, `src/host/worker-local.ts`,
`src/host/session-catalog.ts`):

- `ActorMetadata` gains the same `activity` field; `metadata()` derives it
  from the canonical Document: in-flight tool calls (name from the live
  tool-call form, elapsed from `status.inFlightTools`) while streaming with
  tools, `responding` while streaming without, `compacting` while
  compacting.
- `emitQueue` triggers extend to activity changes: tool start/end and
  streaming/compaction transitions emit a `queue_changed`. Text deltas must
  not — the activity value changes only at those boundaries, so the push
  rate is bounded by tool cadence, not token cadence.

Web:

- `SessionRow` renders the second line for notified (clamped
  `lastMessageText`) and busy (`activity`) rows; the row grows to two lines
  only for those states. The launcher's queue rows render the same second
  line (`Launcher.tsx` already has the preview field; add activity).

**Acceptance criteria.**

- Notified rows show a one-line latest-reply preview; busy rows show the
  running tool with live elapsed time, falling back to Responding… /
  Compacting….
- Activity updates arrive for sessions that are not currently open, without
  opening them, and at bounded push rate (no per-delta queue pushes).
- Elapsed stays correct across switching and reconnect (client-clock
  rebase).
- Deferred and inactive rows stay compact (no second line).

**Tests.** `metadata()` derivation unit tests (tool running, parallel tools,
responding, compacting, idle); a wiring test asserting `queue_changed` fires
on tool start/end and does not fire per streamed delta (faux provider,
`test/suite/harness.ts`); a client formatting test for the elapsed line.

### Commit 3 — Compact mobile switcher

**Scope.** The TopBar popover and the View-all handoff.

Web (`web/src/features/topbar/`, `web/src/features/sidebar/`):

- On a narrow viewport (`useMediaQuery`, the 768px boundary the panes use),
  the hamburger click opens a `Popover` anchored to the button instead of
  the fullscreen overlay. The popover lists notified + busy rows,
  project-grouped, in the switcher's order, reusing the row markup (extract
  the working-row presentation from `SessionRow` so the popover and the
  sidebar share it) including the preview line and the quick state control.
- A **View all** row at the end (also when the compact list is empty —
  "Nothing waiting" plus the button) opens the fullscreen switcher.
- Picking a row opens the session and dismisses the popover. The hamburger
  badge (commit 4) rides the same button.
- Desktop is untouched: rail, hover-peek drawer, and fullscreen overlay keep
  their current triggers.

**Acceptance criteria.**

- On mobile, the topbar button opens the compact list (not the fullscreen
  overlay); View all opens the fullscreen switcher, including when the
  compact list is empty.
- The compact list shows only notified and busy rows, project-grouped, with
  previews and working state controls identical to the sidebar's.
- Picking a session dismisses either surface and opens the session;
  repeated switches preserve per-session drafts and restore reading
  positions (the navigation actor and per-scope draft slots already own
  this — the test pins it).
- Desktop sidebar modes are unchanged.

**Tests.** A store/interaction test for the popover's open/pick/dismiss
flow and the View-all handoff; a manual narrow-viewport pass (real device
or devtools) recorded in the PR notes — the popover's anchoring and safe-area
behavior are not fully covered by jsdom.

### Commit 4 — Attention badge and completion notifications

**Scope.** The waiting badge and queue-derived completion signaling.

Web:

- **Badge.** A count chip on the TopBar hamburger, derived from
  `store.queue` (`state === "notified"`), rendered wherever the hamburger
  renders; while the sidebar has an open surface of its own the rail's rows
  are the indicator, so the badge is not duplicated there. Updates via
  `queue_changed` pushes (already wired into the store).
- **Completion decision.** `web/src/infra/lib/queueAttention.ts` folds over
  queue snapshots: a `busy → notified` edge of one session between
  consecutive snapshots is a completion, except on the first snapshot of a
  connection (initial sync / reconnect reseeds). Manual promotion
  (`inactive → notified`) and restore (`deferred → notified`) are not
  completions by construction — the fold only watches `busy → notified` —
  and the designed ignore-set proved unnecessary: no client verb turns a
  busy session notified (`setSessionState` refuses busy, `markInactive`
  writes `inactive`, and Stop is reachable only on the attached session).
  The attached session's completions are skipped by address, because its own
  tab title and unread count already report them.
- **Delivery.** Page hidden → browser notification (permission-gated,
  service-worker path, as today) carrying the session address in
  `notification.data`; page visible and not the attached session → one
  quiet in-app toast (superseded: the badge's novelty ring carries that case,
  see the status note); attached-session completions keep the existing
  title/unread flow in `useStatusNotifications` (which continues to own the
  attached document's streaming transition — the queue fold covers the
  rest).
- **Click-through.** `web/public/sw.js` `notificationclick` focuses (or
  opens) a client and posts the address to it; `main.tsx` (or the store
  wiring) receives the message and sends a navigation open intent through
  the existing RPC wrapper — never a direct route write (the navigation
  actor owns the route).
- Multiple waiting sessions surface together: the badge count is the
  aggregate; the notifications remain per-completion.

**Acceptance criteria.**

- The badge equals the global notified count — including sessions in
  collapsed folders — and converges across tabs.
- Reading a session does not clear the badge; replying, deferring, or
  marking inactive updates it.
- A session completing while another is open produces one in-app toast
  (superseded by the badge's novelty ring; see the status note); while the
  page is hidden, one browser notification whose click opens that session.
- The initial queue snapshot after load or reconnect produces no
  notifications; manual promotion and restore produce none; a completion
  caused by the local client's own action (Stop → notified) is not
  double-signaled beyond the existing attached-session flow.

**Tests.** Unit tests for the fold (busy→notified fires; snapshot, restore,
local-action suppression; per-session identity); a `sw.js` test extending
the existing `sw-fetch-policy.test.ts` pattern for `notificationclick`;
an end-to-end-style wiring test in `test/suite/lifecycle-trace.test.ts`
style if the faux provider admits it (two sessions, one completing while
the other is attached), else a store-level test with injected queue pushes.

## Documentation updates

| Commit | Owning docs |
| --- | --- |
| 1 | `docs/web/design.md` (Sidebar section: fold states, row order, indicator control, menu verbs); `docs/web/architecture.md` (folder-expansion slice) |
| 2 | `docs/core/protocol.md` (`SessionInfo.activity`), `docs/host/runtime.md` (ActorMetadata activity, `queue_changed` triggers), `docs/web/design.md` (preview line) |
| 3 | `docs/web/design.md` (Topbar, mobile switcher), `docs/web/architecture.md` (feature area) |
| 4 | `docs/web/design.md` (badge, notifications), `docs/web/architecture.md` (queueAttention module, SW click-through) |

Glossary: no new coined terms. "Working rows", "compact switcher", "waiting
badge" are composed phrases; the switcher itself is the Sidebar's role, not a
new module name.

## Risks and open items

- **Two-line rows change sidebar density.** The rail's 220px default and the
  `Today/This week/Earlier` removal both land in commit 1–2; a quick visual
  pass on real data should confirm the rail stays readable, and the min
  width bound may need one step up.
- **Activity derivation parallelism.** Several tools running at once: the
  guide pins "most recently started wins"; if that reads poorly in practice,
  a count suffix (`2 tools · Bash`) is a rendering-only change.
- **`queue_changed` push rate.** Commit 2 adds tool-boundary triggers. If a
  tool-heavy session produces noticeable push churn on slow connections, a
  debounce (bounded, e.g. 2s) on the Worker's emit is the containment — the
  activity *value* still changes only at boundaries.
- **SW click-through navigation** must not bypass the navigation actor; the
  message handler sends the open intent, and a superseded/cancelled intent
  follows the actor's existing rules. This is the one piece of commit 4
  with real failure modes — it gets the most test attention.

## Final acceptance walkthrough

After all four commits: start two agents in different projects; from one
conversation, monitor the other via the switcher (preview line shows the
running tool); receive the completion as a badge update and a toast; defer
one session from the indicator; mark an old history session Parked without
sending anything; restart the Worker; confirm every state, the badge, and
the switcher recover to the same view.

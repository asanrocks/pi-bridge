# Glossary migration log

Procedural companion to [glossary.md](glossary.md). The glossary is the
specification — it describes the desired, ultimate vocabulary and carries no
process state. This log owns all of the process: where current code and
prose still deviate, and the path to closing each gap. Each item is one unit
of work: do the procedure, run the verification, close the item with a dated
line. Items are independent unless noted; do them in priority order
(P1 collisions → P2 demotions with identifiers → P3 prose-only).

**When every item below is closed: delete this file.**

## Code today

Canonical term → the identifiers and prose that still carry retired or
pre-canonical words. Rows are removed as their items close.

| Canonical | Code today | Item |
| --- | --- | --- |
| a projection of | `projectEntry`, `projectSnapshot`, `projectCacheEntry` | M2 |
| header | `CardIdentity`, `BashIdentity` | M3 |
| the group's vertical line | `styles.spine`, "spine" prose | M4 |
| elide | `foldPathWord`, "fold" prose | M5 |
| tinted row | `GitChangeBand`, `BandPreview` | M6 |
| inline git stamp | `GitChangeMark`, "mark" prose | M7 |
| hue / kind-colored dot | `ActionFamily`, `kindFamily`, `groupSwatches` | M8 |
| pending pulls | `wants`, `wants-outbox`, `wantPull`, `takeWants`, `setWantsDrainer`, `stepWants` | M9 |
| action | `ActionStepVM`, `ToolActionStepView`, `expandedSteps`, `stepFold`, … | M10 |
| turn | "run" (`run merging`, `run-anchor`, `mid-run`) | M11 |

Common verification for any item that touches code (`packages/bridge/`):

```sh
npm run build                                              # core/host build
node ../../node_modules/.bin/tsgo --noEmit -p web/tsconfig.json
node ../../node_modules/vitest/dist/cli.js --run test/suite
npm run check                                              # from repo root, before closing
```

Status legend: `[ ]` open · `[~]` in progress (name + date) · `[x]` closed
(name + date + evidence line).

---

## [x] M1 — Adopt glossary v2 *(done with this change)*

- [x] Rewrote `docs/glossary.md` into the three-tier model (coined /
  bound / composed); coined budget reduced to **Activation**, **seal**,
  **git stamp**; added the retired-words table. The glossary is pure
  specification — process state (this log, the "Code today" table) lives
  here only.
- [x] Split the **seal** / **settle** claim (C.4): settle is the event
  (turn end, streaming stops); sealing is what reconcile does to
  provisional identity there. Verified against code usage (`onSettled`,
  `ui.ts` "provisionally sealed → durable move", `tools/timing.ts`
  "post-seal remount").
- [ ] If ADR 02 conflates seal and settle, amend its §reconcile/seal to
  match C.4. *(docs-only; read ADR 02 first)*

## [ ] M2 — Rename the `project*` verb (P1)

Canonical: "Project" is a noun only; the operation is "a projection of".

Rename (`core`, public exports — update `src/index.ts` and
`src/core/index.ts` re-exports and all call sites):

| Old | New |
| --- | --- |
| `projectEntry` (`src/core/document.ts`) | `toEntry` |
| `projectSnapshot` (`src/core/document.ts`) | `snapshotForWire` |
| `projectCacheEntry` (`src/core/cache.ts`) | `entryForCache` |

Prose: comments in `document.ts` (~L703), `cache.ts`, `sync.ts`.
Verify: `rg -n 'projectEntry|projectSnapshot|projectCacheEntry' src web` → 0
hits; then common verification.

## [ ] M3 — Card identity → header (P1)

Canonical: "identity" is reserved to the git sense (C.10); a card's title
line is its header.

Rename (`web/src/features/conversation/`):

- `CardSkeleton.tsx`: `CardIdentity` → `CardHeader`
- `BashIdentity.tsx` → `BashHeader.tsx`: `BashIdentity` → `BashHeader`
- `ToolActionStepView.tsx`: imports + usage at ~L191–193
- `tool-card-streaming.test.ts`: stub imports (~L52–53)

Verify: `rg -n 'CardIdentity|BashIdentity' web/src` → 0 hits; run
`test/suite`… not applicable (web) — run the web typecheck and
`tool-card-streaming.test.ts` via `node --test`.

## [ ] M4 — Remove "spine" (P1)

Canonical: the action group's **vertical line**; the history tree's
**active path**. Two unrelated elements were both called a spine.

- CSS: `actionSteps.module.css` `.spine` → `.groupLine`
- Code: `ActionGroupView.tsx` (`styles.spine` ~L160)
- Comments: `ActionGroupView.tsx` ~L66, `GitChangeCard.tsx` ~L2,
  `GitChangeShared.tsx` ~L2, `ConversationArea.tsx` ~L4,
  `AssistantTurnView.tsx` ~L5, `src/viewmodel/index.ts` ~L8
- Prose: ADR 10 ("in the spine", "band and the following steps"),
  PRD 04 L252 ("active path = straight spine" → "active path = straight
  line")

Verify: `rg -n -w 'spine' src web docs AGENTS.md` → 0 hits (except
`glossary.md` retired-words table).

## [ ] M5 — fold → elide / collapsed (P2)

Canonical: UI states are **collapsed/expanded**; abbreviating a shell path
to its last two segments is **eliding**. (Sidebar folder "fold" is
established file-tree vocabulary and stays.)

- `src/viewmodel/index.ts`: `foldPathWord` → `elidePathWord` (~L1567);
  local `folded` → `elided` (~L1523); comment "Fold a shell command"
  (~L1439) → "Elide a shell command"
- CSS: `actionSteps.module.css` `.stepFold` → `.stepCollapsed` (and the
  `stepFold` usages in `ToolActionStepView.tsx` / `ThinkActionStepView.tsx`)
- Prose: "folded"/"unfolds" in ADR 07, PRD 04, `web/src` comments →
  collapsed/expanded

Verify: `rg -n 'foldPathWord|stepFold' src web` → 0 hits;
`rg -n -w 'folded|unfolds' web/src docs` → only sidebar-folder senses.

## [ ] M6 — band → tinted row (P2)

- `GitChangeShared.tsx`: `GitChangeBand` → `GitChangeRow`
- `tools/BandPreview.tsx` → `RowPreview.tsx` (update importers)
- Prose: "band" throughout ADR 10, PRD 04, `viewmodel/index.ts` comments
  (~L1689, ~L2130–2141), `GitChangeCard.tsx` / `GitChangeView.tsx`
  comments → "tinted row"

Verify: `rg -n -w -i 'band' src web docs AGENTS.md` → 0 hits (except the
glossary retired-words table).

## [ ] M7 — mark → inline git stamp (P2)

Canonical: a git stamp inside a group "renders inline after the action it
follows" (D.10); the positioned render is an **inline git stamp**.

- `src/viewmodel/index.ts`: `GitChangeMark` → `InlineGitStamp` (public
  export — update `src/index.ts`); "git marks"/"in-group mark" comments →
  "inline git stamps"
- `web/src/features/conversation/`: `GitChangeMark` usages
  (`ActionGroupView.tsx`, `GitChangeShared.tsx`, `formatGroupSummary.ts`
  and its test)
- Prose: ADR 10 §rendering, PRD 04

Verify: `rg -n -w 'mark' src/viewmodel web/src/features/conversation
docs/10-adr-git-stamp.md` → only non-term senses (e.g. "landmark", none
expected).

## [ ] M8 — swatch/family → dot/hue (P3)

Canonical: the header shows one **kind-colored dot** per kind present;
kinds **share a hue**.

- `src/viewmodel/index.ts`: `ActionFamily` → `ActionHue` (public export),
  `kindFamily` → `kindHue` (~L2166)
- `ActionGroupView.tsx`: `groupSwatches` → `groupDots`, `styles.groupSwatches`
- CSS: `.groupSwatches` → `.groupDots`; `data-family` attributes →
  `data-hue` (tokens `--kind-*` stay — they are kind-scoped)
- Prose: ADR 10 "git swatch", PRD 04 "family" → dot/hue

Verify: `rg -n -w 'swatch|family' src web docs AGENTS.md` → 0 hits (except
glossary retired-words table).

## [ ] M9 — wants → pending pulls (P2)

Canonical: a Mirror declares **pending pulls**; the pull loop drains them.

- `web/src/infra/net/wants.ts` → `pullQueue.ts`:
  `wantPull` → `enqueuePulls`, `takeWants` → `drainPullQueue`,
  `setWantsDrainer` → `setDrainer`
- `src/core/client.ts`: `needsPull(wants)` → `needsPull(pending)`;
  `planPull` comment "wants outbox" → "pull queue"
- `src/viewmodel/index.ts`: `stepWants` → renames with M10 to `actionPulls`
- `web/src/infra/state/ui.ts`: "Want-registering components" →
  "Pull-requesting components"
- Prose: ADR 09, `architecture.md` §Pull orchestration,
  `pullLoop.ts` / `wants.ts` headers

Verify: `rg -n -w 'wants?' src web docs` → 0 hits (except glossary
retired-words table).

## [ ] M10 — step → action (P2; largest rename)

Canonical: members of an action group are **actions** (D.5). Do after
M5/M7/M9 so their step-named identifiers are already touched once.

`src/viewmodel/index.ts` (public exports — update `src/index.ts`):
`ActionStepVM` → `ActionVM`, `ToolActionStepVM` → `ToolActionVM`,
`ThinkActionStepVM` → `ThinkActionVM`, `StepSummaryItem` →
`ActionSummaryItem`.

`web/src`:
- `ToolActionStepView.tsx` → `ToolActionView.tsx`,
  `ThinkActionStepView.tsx` → `ThinkActionView.tsx`
- `actionSteps.module.css` → `actions.module.css`; `.actionStep` →
  `.action`; `stepHead`/`stepDetails*`/`stepSummary` → `actionHead`/…
- `web/src/infra/state/ui.ts` + `store.ts`: `expandedSteps` →
  `expandedActions`, `frozenSteps` → `frozenActions`, `toggleStep` →
  `toggleAction`; same for `ExpandKeySets` fields and `migrateExpandKeys`
  docs
- `onToggleStep` props through `ActionGroupView` / `AssistantTurnView` /
  `ConversationArea`

Prose: ADR 07, PRD 04, `AGENTS.md` entry map ("step-summary extraction",
`stepWants`).

Verify: `rg -n -w 'step|steps' src web docs AGENTS.md` → only non-term
senses (footstep-type compounds; "steps" as ordinary English in ADRs is
acceptable in narrative sentences — judge per hit); common verification.

## [ ] M11 — run → turn (P2; audit first)

Canonical: an **assistant turn** merges consecutive assistant entries
(D.3). The code calls the merged unit a "run".

1. Audit first: `viewmodel/index.ts` distinguishes `turnKey` (equals
   `entryId` unless a turn starts mid-entry) from the merged run. If the
   distinction is real, encode it as a D claim; if not, "run" is a pure
   synonym.
2. Then rename prose: `run merging`, `run-anchor`, `mid-run` (~60 hits in
   `viewmodel/index.ts`, 19 in ADR 10, 10 in `AGENTS.md` entry map) →
   turn-based phrasing ("merged turn", "turn-anchored stamp", "mid-turn").
3. No type is named `Run` — comments and ADR prose only.

Verify: `rg -n -w 'run' src/viewmodel docs/10-adr-git-stamp.md AGENTS.md`
→ only ordinary-verb senses.

## [ ] M12 — Drop the topology "lane" noun (P3)

Canonical: B.6 — "a Connection processes verbs one at a time, in order";
the mechanism has no name. Frees "lane" for the history tree's code-local
`LaneLayout` (which stays unclaimed, D-external).

- ADR 12 prose: "state-transition lane", "lane-serialized", "the lane
  holds…" (~10 hits) → serialization described in words
- `AGENTS.md` entry map: "never holding the per-Connection lane for a
  turn" → "never blocking per-Connection ordering for a turn"

Verify: `rg -n -w 'lane' docs AGENTS.md` → only `tree.ts`-related history
-tree senses.

## [ ] M13 — Tree cluster: keeper / typo-fan / ghost vertical (P3)

Canonical: the mechanism is **draft collapse** (composed, free): aborted
sibling runs collapse into the following node. Comments in
`src/viewmodel/tree.ts` (~L46, ~L191–195, ~L490) use the plain phrases:
"the following node", "aborted sibling runs", "bare vertical". No
identifier renames (`collapseDrafts` stays).

Verify: `rg -n -w 'keeper|typo-fan|ghost' src` → 0 hits.

## [ ] M14 — `HomePick` (P3)

Verify what `HomePick` selects, then rename to a name that says so (e.g.
`RecentSessionPick`). `web/src/features/launcher/`, `sidebar/timeUtils.ts`.

## [ ] M15 — Final sweep and closure (P3; after M1–M14)

1. `rg -n -w 'project|identity|spine|band|mark|fold|swatch|family|lane|
   wants|step|run' docs AGENTS.md` — judge each hit: retired sense, or
   ordinary English?
2. Update the bridge `AGENTS.md` entry map to the canonical vocabulary.
3. Confirm every row of the "Code today" table above is closed, then
   delete this file.

---

## Log

| Item | Status | Closed by | Evidence |
| --- | --- | --- | --- |
| M1 | [x] | glossary v2 rewrite | `docs/glossary.md` three-tier model; seal/settle split verified against `ui.ts`, `manager.ts`, `tools/timing.ts` |
| M2 | [ ] | | |
| M3 | [ ] | | |
| M4 | [ ] | | |
| M5 | [ ] | | |
| M6 | [ ] | | |
| M7 | [ ] | | |
| M8 | [ ] | | |
| M9 | [ ] | | |
| M10 | [ ] | | |
| M11 | [ ] | | |
| M12 | [ ] | | |
| M13 | [ ] | | |
| M14 | [ ] | | |
| M15 | [ ] | | |

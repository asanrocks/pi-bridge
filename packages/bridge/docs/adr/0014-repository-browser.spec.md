# Functional Spec: Repository Browser

**See also:** [ADR 14: Repository Browser](./0014-repository-browser.md) — the
change record: the technical decision, alternatives, and consequences.

Specifies the user-facing behaviour of the repository browser as scenarios:
who uses it, the concrete flows they run, and the surface they run them on.
A scenario is one `Given / When / Then` with concrete values, so it can be
checked by hand or turned into a test. Capability groups carry their status;
scenarios are shipped unless a group is marked deferred.

Three documents, three jobs:

- **[ADR 14](./0014-repository-browser.md)** — the change record: the technical
  decision, alternatives, consequences.
- **This spec** — the behaviour and flows, with shipped/deferred status.
- **Permanent docs** ([web design](../web/design.md),
  [host runtime](../host/runtime.md), [glossary](../glossary.md)) — current
  truth.

Nothing here is current truth. On landing, this spec and the ADR are deleted:
the flow and surface rules move into web design, the mechanism into the host and
core docs, and any new term into the glossary first. Vocabulary is the
glossary's (`browser`, `snapshot state`, `baseline`, `git stamp`, `identity`).

## Status

| Group | State |
| --- | --- |
| Reviewing changes | shipped |
| Reading files | shipped |
| Comparing states | shipped |
| Freshness and honesty | shipped |
| Structure and navigation | shipped |
| Undoing | deferred |
| Orienting | deferred |
| Keyboard and assistive access | partial |

## Actors

One: **the supervising developer** — a person watching an agent edit a
repository, reading in a browser rather than a terminal. The browser is
read-only, so no other actor participates in its scenarios.

## Model

Everything the browser does is one pair of snapshot states and one optional
comparison:

- **`state`** — what the content pane reads. The developer's "new".
- **`baseline`** — what `state` is compared against. The developer's "old". The
  header names the task and carries the pair as metadata; without a baseline the
  browser reads a single state and offers no comparison.
- A snapshot state is a recorded commit, `head`, `index`, or `worktree`.
  `worktree` is a sampling point, not a fixed snapshot, and cannot be a
  baseline.

The pair is filled from context, never asked for: an entry point decides root,
state, baseline, and presentation. The developer can re-point either end
afterwards (`Compare…`) but never has to in order to see something useful.

A target is a **selector, not a snapshot** — every open and every state change
refetches. The root bounds the *view*, not filesystem access: a file outside the
Project is still readable, rooted at its own directory.

What the pair can and cannot answer:

| Question | Answerable | Why |
| --- | --- | --- |
| What did the session's commits change? | yes | One row per observed git-stamp transition (`old commit → new commit`). |
| What did one turn change? | **not reliably** | Stamps observe identity at boundaries; a turn may edit without committing or commit several times. |
| What has changed and is not committed? | yes, **now only** | `head → worktree`; the worktree is a sampling point. |
| What did this turn leave uncommitted, historically? | **no** | Stamps record identity, not worktree contents. Nothing archives the worktree. |
| What changed between these two recorded commits? | yes | Both ends are recorded. |

The historical-uncommitted limit is hard, not a backlog item. An uncommitted
change is shown as it exists now; the live worktree row says nothing about
which turn produced the dirt.

How a target is derived — stamps give the timeline, each adjacent pair of
distinct identities becomes a transition, a user turn's chip menu lists the
transitions observed during that turn, and picking one opens the browser with
that pair:

```text
  git stamps on the active path                turn chip menu           browser target
  ─────────────────────────────                ──────────────           ──────────────
  ● c0  prompt    (the state "add the parser" begins in)
  │
  ● c1  tool_end  a1b2c3d   ────────────────►  Add parser        ─────►  state    = c1
  │                                               c0 ▸ c1               baseline = c0
  ● c2  turn_end  d4e5f6a   ────────────────►  Fix the tests     ─────►  state    = c2
  │                                               c1 ▸ c2               baseline = c1
  ○ worktree (the live tail) ───────────────►  TopBar badge       ─────►  state    = worktree
                                                  c2 ▸ worktree         baseline = c2
```

Each transition is labeled by the commit subject and grouped under the turn it
was observed during. The c1 and c2 stamps carry their own transitions (`c0 ▸
c1`, `c1 ▸ c2`), so each is listed once; a turn that commits twice contributes
two menu items, and a same-commit (branch-only) transition is dropped because
it has no content change.

## Scenarios

### Reviewing changes — shipped

**S1 · A recorded transition opens as a review.**
*Given* the active path observed `a1b2c3d` at a prompt and `d4e5f6a` at a later
`turn_end` (subject "Fix the tests") ·
*When* the developer picks the "Fix the tests" row in Changes ·
*Then* the browser opens with `state = d4e5f6a`, `baseline = a1b2c3d`, the
changed tree, and the stacked review ·
*And* its header reads "Fix the tests" over `2 files changed · a1b2c3d → d4e5f6a`.

**S2 · One turn that commits twice contributes two rows.**
*Given* one user turn observes `a1b2c3d` then `d4e5f6a` ·
*When* Changes renders ·
*Then* the two transitions are grouped under that turn's message, each with its
own `old → new` pair ·
*And* a same-commit (branch-only) transition in the same turn produces no row.

**S3 · The uncommitted delta is one live row.**
*Given* the worktree differs from `HEAD` across several turns ·
*When* Changes renders ·
*Then* a single `Uncommitted` row summarizes `head → worktree` (file count and ±
counts) ·
*And* it is not attributed to any turn.

**S4 · A commit card reviews a commit against its base.**
*Given* a git card for commit `d4e5f6a` whose first parent is `a1b2c3d` ·
*When* the developer picks its `commit` control ·
*Then* the browser opens `state = d4e5f6a`, `baseline = a1b2c3d`, titled
`d4e5f6a · <subject>` ·
*And* for a root commit the baseline resolves host-side to the repository's
empty tree.

**S5 · A git chip opens its transition; untracked files count without ±.**
*Given* a user turn carrying identity `a1b2c3d` and a later transition to
`d4e5f6a` ·
*When* the developer picks the turn's git chip ·
*Then* the browser opens `a1b2c3d → d4e5f6a` ·
*And* in the uncommitted review, untracked files count toward the file count but
carry no ± counts.

**S6 · The review is a stacked list navigated by the tree.**
*Given* a review with four changed files ·
*When* the developer opens it ·
*Then* sections start collapsed ·
*When* the developer picks a tree row ·
*Then* that section scrolls into view and expands, and the tree highlight
follows the section being read ·
*And* a section's `file` control shows the whole file at the read state.

**S7 · Honest gaps.**
*Given* a changed-file list the host capped ·
*Then* the review states how many files are not listed ·
*And* a pair whose two ends are identical says there is no content change ·
*And* an unreachable recorded commit reports an error while the stored label
stays intact.

### Reading files — shipped

**S8 · Read a file at one state.**
*Given* the browser is open with no baseline ·
*When* the developer picks `HEAD`, the index, or a recorded commit in the state
selector ·
*Then* the content pane reads that file at that state ·
*And* the working tree is the default state.

**S9 · Markdown and line anchors.**
*Given* a Markdown file ·
*Then* it renders as prose; other files render as highlighted code ·
*Given* a link `path.ts:98`, `path.ts:98:12`, or `path.ts#L98` ·
*Then* the browser opens the file, scrolls to that line, and tints it.

**S10 · Explicit content states.**
*Given* a file larger than the host cap ·
*Then* the pane reports truncation ·
*And* absent and binary files each get their own explicit note, never an empty
body.

**S11 · A tool card reads the file now.**
*Given* a tool card whose call arguments carry a `path` ·
*When* the developer picks its open control ·
*Then* the browser reads the file as it exists at click time, not what the call
produced.

### Comparing states — shipped

**S12 · The three common comparisons.**
*Given* any browser target ·
*When* the developer opens `Compare…` ·
*Then* it offers "Working changes" (`HEAD → working tree`), "Staged changes"
(`HEAD → index`), and "Unstaged changes" (`index → working tree`).

**S13 · A custom comparison.**
*Given* the `Compare…` menu ·
*When* the developer picks a `From` and a `To` from the recorded commits and the
floating states ·
*Then* the browser opens that pair ·
*And* the `From` end cannot be the working tree, which the host rejects.

**S14 · Re-pointing drops the origin.**
*Given* a browser opened on a recorded transition ·
*When* the developer applies a comparison ·
*Then* the target refetches and the transition's origin label is cleared.

### Freshness and honesty — shipped

**S15 · A worktree endpoint is a sampling point.**
*Given* a target whose `state` or `baseline` is the working tree ·
*Then* the detail line carries an `as of` time and a `Refresh` control ·
*And* the view refetches when a turn settles, never on every streamed entry.

**S16 · Commit-addressed content is immutable.**
*Given* a target whose ends are pinned commits ·
*Then* there is no `as of` time, no `Refresh`, and no automatic refetch.

**S17 · Historical uncommitted state is never implied.**
*Given* a turn that edited files without committing ·
*Then* those edits appear only in the live `Uncommitted` row, never as a
recorded transition ·
*And* no stored commit id or subject is re-resolved against the current
checkout.

### Structure and navigation — shipped

**S18 · Tree scope.**
*Given* a review with a baseline ·
*When* the developer clicks the tree pane's label ·
*Then* it toggles between the full tree ("All files") and the changed tree
("Changed (N)").

**S19 · Renames and deletions.**
*Given* a renamed file ·
*Then* its tree row and section carry both the old and the new path ·
*Given* a deleted file ·
*Then* the file view shows absence and the diff view shows its old content.

**S20 · Machine state and unreadable directories.**
*Then* `.git` never appears in any listing ·
*And* a directory that fails to list is marked unreadable and stays collapsed,
and the next toggle retries it, rather than rendering as empty.

**S21 · Narrow viewports.**
*Given* a viewport below 768px ·
*Then* the tree starts collapsed behind a `Files` control and opens as a
scrim-backed drawer ·
*And* a file choice, the scrim, or `Hide` dismisses it.

### Undoing — deferred

**S22 · Revert uncommitted paths.**
*Given* the chosen paths differ from `HEAD` and no turn is streaming ·
*When* the developer selects paths and confirms ·
*Then* the host restores them to their `HEAD` content, leaving other
uncommitted work untouched.
Needs a host mutation verb.

**S23 · Reset to a recorded state.**
*Given* a reachable recorded commit and no streaming turn ·
*When* the developer picks it and confirms ·
*Then* the host returns the worktree to it.
Open: hard reset only or a mode choice, and whether a backup ref is created
first.

### Orienting — deferred

**S24 · Step between windows.**
*Given* an open review ·
*When* the developer moves to the previous or next window on the path ·
*Then* the browser re-points without closing, with the origin turn visible.

## Surface

### Review: a stacked list of changed files

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Working changes                                   Compare…  Refresh   Review   ✕ │
│ 3 files changed since 32724bbb · as of 09:41                                     │
├────────────────────┬─────────────────────────────────────────────────────────────┤
│ Changed (3)        │ docs/adr/0014-repository-browser.spec.md        −0 +4   file│
│ ▾ docs             │ ▸  diff, three context lines                                │
│   ▾ adr            │ ─────────────────────────────────────────────────────       │
│     0014-repo…  M  │ docs/adr/0014-repository-browser.md             −2 +6   file│
│     0014-repo…  M  │ ▾                                                           │
│   log-raw          │    12  -one section per changed file                        │
│                    │    12  +one section per changed file, collapsed             │
└────────────────────┴─────────────────────────────────────────────────────────────┘
```

The header names the task; the tree lists the changed paths. The content pane
stacks one section per changed file. Clicking a tree row scrolls to and opens
its section, and the tree highlight follows the section being read, so the tree
is navigation over one list rather than a filter. `file` switches one section to
the whole file at the read state. `Expand files` and `Expand all lines` sit in
the content bar above the sections. Escape, the ✕, and the backdrop close the
browser.

### File: one state, no comparison

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Files                              Working tree ▾  Compare…                    ✕ │
│ /home/hugh/project/agenty/pi                                                     │
├────────────────────┬─────────────────────────────────────────────────────────────┤
│ Files              │ docs/adr/0014-repository-browser.spec.md                Diff│
│ ▾ docs             │ ────────────────────────────────────────────────────────────│
│   ▾ adr            │   1  # Repository Browser                                   │
│     0014-repo…  ◂  │   2                                                         │
│     0014-repo…     │   3  The browser pairs a file tree with file content.       │
│   log-raw          │   4  It reads one state, or compares two.                   │
└────────────────────┴─────────────────────────────────────────────────────────────┘
```

With no baseline there is one state and no `Diff` control — the browser reads a
file rather than comparing. The state picker still allows a read at `HEAD`, the
index, or a recorded commit.

### The Compare menu

```text
┌─ Compare… ───────────────────────────────┐
│ COMMON                                   │
│ Working changes        HEAD → Working tr…│
│ Staged changes         HEAD → Index      │
│ Unstaged changes       Index → Working tr…│
│ CUSTOM                                   │
│ [32724bbb ▾]  →  [Working tree ▾]        │
│ [ Open comparison ]                      │
└──────────────────────────────────────────┘
```

The header names the task; arbitrary endpoints live behind `Compare…`. The
common rows cover the three everyday deltas. The custom row re-points each end
from the same state list (the commits the session's stamps observed with their
subjects, plus `HEAD`, the index, and the working tree); the baseline end
cannot be the working tree, which the host rejects. Applying a comparison
rewrites the target, refetches, and drops the origin label. The single-state
read keeps a plain state chip in the header, because reading one file at one
state is not a comparison.

### Narrow viewports

```text
┌────────────────────────────────────────────┐    ┌────────────────────────────────────────────┐
│ Files   Working tree ▾                     │    │ Files        Hide                          │
├───────────────────┬────────────────────────┤    ├─────────────────┬──────────────────────────┤
│ 0014-repo…spec.md │ −0 +4   file           │    │ ▾ docs          │▒▒▒▒▒▒▒▒ scrim ▒▒▒▒▒▒▒▒▒▒ │
│ ▸ three context…  │                        │    │   ▾ adr         │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
│ ──────────────────│ ───────────────────────│    │     0014-…      │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
└──────────────────┴─────────────────────────┘    └─────────────────┴──────────────────────────┘
```

Below the 768px pane breakpoint the tree starts collapsed behind `Files` and
opens as a scrim-backed drawer; a file choice, the scrim, or `Hide` dismisses
it. The header wraps rather than clipping at the panel edge.

## Entry points

| Entry point | `state` | `baseline` | Tree | Presentation |
| --- | --- | --- | --- | --- |
| Turn chip menu, a recorded commit | transition `new` | transition `old` | changed | review |
| Turn chip menu, `Review all N commits` | last `new` | first `old` | changed | review |
| Turn chip menu, `Compare with the current worktree` (live tail) | worktree | send state | changed | review |
| TopBar changes badge | worktree | head | changed | review |
| Git card, `review` | the commit | its first parent, host-resolved | changed | review |
| Markdown file link, tool-card control, apply_patch label | worktree | — | all | file |
| Project home, `Browse files` | worktree | — | all | file |

## Invariants

Cross-cutting rules every scenario obeys:

1. **Never claim more than git knows.** Absent, binary, truncated, and
   too-large-to-diff are distinct explicit states. A capped file list states its
   remainder rather than presenting a partial review as complete. An unreachable
   recorded commit is an error while its recorded label stays intact. A pair
   with no content change says so instead of rendering an empty diff.
2. **Never imply historical uncommitted state.** The worktree is read as it
   exists now; a stored commit id or subject is a historical label and is never
   re-resolved for display.
3. **Never claim causality.** A change card's relationship to a nearby tool is
   positional and best effort, especially for parallel tools.
4. **Be honest about freshness.** A worktree endpoint carries an `as of` time, a
   Refresh control, and an automatic refetch when a turn settles — never a
   per-entry poll. Commit-addressed content is immutable and needs neither.
5. **Read-only.** The browser performs no mutation: no editor, no staging, no
   revert, no reset. Its verbs are `readFile`, `listDirectory`, and `gitDiff`.
6. **One surface.** Every entry point opens the same browser with a different
   target; there is no second viewer.
7. **A file choice dismisses transient chrome.** On a narrow viewport, choosing
   a file closes the tree drawer.

## Non-goals

- **Editing.** The browser never writes file content.
- **Archiving the worktree.** No `write-tree`, no stashes, no snapshot store.
- **A route.** The browser is ephemeral chrome, closed by an address change.
- **Free-form git.** No command box; each capability is a dedicated verb.

## Open questions

Findings from the implementation review, none of them blocking:

1. **A branch-only transition produces an empty row.** *Resolved:* a
   same-commit transition is dropped from Changes (it is an event, not a content
   change), so no empty row is listed.
2. **Absolute path in the file bar.** The tree is root-relative; the file bar
   shows the absolute path.
3. **A truncated suggestion.** A too-large diff says to open the whole file, but
   the whole file can be truncated too.
4. **Index semantics are unlabeled.** `head → index` (staged) and
   `index → worktree` (unstaged) are genuinely different reviews; the picker
   labels both only as `Index`.
5. **Resolved: the review timeline is no longer a History tab.** It was the
   History pane's second tab, behind a pane that opens on Branches; it is now
   the transcript's git affordances (turn chip menu, card `review`, TopBar
   badge), each naming its endpoint pair and needing no pane to discover.

## Verification

- **Automated:** the tree builders and path arithmetic, the section-key and
  viewport-follow rules, the state collection, and the host query layer
  (statuses, the three-state matrix, caps, base resolution).
- **Manual:** the browser's DOM effects — scroll-to-section, the tree's
  viewport-follow highlight, and the line anchor — and each entry point in the
  table above, at desktop and at the 768px boundary.
- **Not covered:** S22 and S23 have no verification until the mutation verbs
  exist.

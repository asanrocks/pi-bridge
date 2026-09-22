# ADR 0014: Repository Browser

**Status:** Implemented (pending merge into the permanent docs).

**See also:** [the accompanying functional spec](./0014-repository-browser.spec.md)
— actors, user stories, use cases, UI sketch, and the shipped/deferred status of
each flow.

## Context

The web client has two fullscreen viewers. `FileViewer` reads one path at a
repository state; `DiffView` reviews a git-stamp window as a stacked list of
changed-file sections. Neither can browse the surrounding directory. The
Changes tab, git cards, file links, and Project home should open files in one
place without making a conversation Session the address of the filesystem.

Git stamps supply the historical commits and diff windows shown in the UI.
They record commit identity, not worktree contents: uncommitted changes can be
reviewed only as they exist now. The browser reads files and git objects on
demand; it does not save a worktree snapshot.

## Decision

Replace the two viewers with one fullscreen repository browser. Its left side
is a file tree; its right side shows file content. Opening from a file link
selects one file. Opening from Changes reviews a window of changed files in
sequence, with the tree serving as navigation. Both use the same tree and
content renderers, not two copies of the viewer.

The browser has an absolute directory root, a state being viewed, and
optionally a baseline for comparison:

```ts
type StateRef = "worktree" | "head" | "index" | CommitOid;

interface BrowserOpen {
  root: string;                 // absolute directory path
  state: StateRef;
  baseline?: StateRef;
  path?: string;                // absolute initial file path
  line?: number;
  tree: "all" | "changed";
  presentation: "file" | "review";
}
```

`state` answers which file is being read. `baseline`, when present, permits a
diff from baseline to state and change markers in the tree. `presentation`
describes the right pane: one selected file or stacked changed-file sections.
It is an explicit view choice, not a property inferred from the source of the
tree. The tree is `all` for ordinary browsing and `changed` for review; the
user can switch tree scope when a baseline exists. A changed-files tree comes
directly from the diff query, never from walking a repository and filtering
it in the client.

The browser root bounds the *view*, not filesystem access. Project entry
points start at the Project cwd, but browser RPCs carry absolute paths rather
than a `projectId` or an attached Session. The daemon's sandbox is the
filesystem access boundary; this feature adds no `--allow` filter. A file
link outside the Project can still be read, with its parent directory as the
browser root. Relative links are resolved at the link entry point against the
Project cwd before opening the absolute-path browser target; a `~`-rooted path
is left as written and expanded host-side, which owns HOME. Existing link
behavior must not be dropped during migration.

### Host Queries

The browser uses three attachment-free operations:

| Query | Result |
| --- | --- |
| `readFile(absPath, snapshot?)` | One file's content, or an explicit absent/binary result. |
| `listDirectory(absPath, snapshot?)` | Immediate children of one directory, with a cap and omitted count. |
| `gitDiff(absDirectory, old, new)` | Changed paths relative to that directory, statuses, rename sources, binary flags, and line counts; no patch text. |

For the first two queries, an omitted snapshot means the live filesystem:
read the file or list the directory as it is, without applying gitignore.
Listing is lazy, one directory per expansion; it is not a recursive scan.
Snapshot values are `head`, `index`, or a pinned commit oid. For a snapshot
read or listing, the host finds the repository containing the absolute path
(using an existing ancestor when the target no longer exists), translates
the path relative to its root, and reads git's tree or index. A path outside
a repository has no snapshot view, but remains browsable on disk. Missing
files and directories at a valid snapshot are absent, not errors. `head` and
the index are live selectors; commit oids are fixed. A missing git object is
an error, not an empty directory.

`gitDiff` finds the repository from `absDirectory`, limits the result to that
subtree, and returns paths relative to `absDirectory` so each can be read by
joining it to the browser root. Its `old` and `new` states use the same
vocabulary, with `worktree` valid only for `new`. The existing directive
already uses `--relative` and lists untracked worktree files separately;
extend it to support index comparisons and to parse git's machine-readable
raw status alongside numstat (for example, `git diff --raw --numstat -z`).
Do not infer added/deleted/modified status by fetching every file. Cap the
result as well as the untracked list, and report incompleteness (`filesOmitted`
and `untrackedOmitted`) rather than silently presenting a partial review as
complete.

`listFiles(projectId, prefix)` remains the Project-scoped completion API;
it is not the directory browser. The existing attachment-bound reads and
diffs must be migrated to the absolute-path queries, not retained as a
second browser address scheme. Git-card commit details (`gitShow --stat`)
remain separate from file and diff queries.

### Tree and Content

One browser container owns the current root, selection, scope, request
invalidations, and presentation. It performs either a lazy directory listing
or a changed-files query and supplies normalized nodes to a presentational
`FileTree`. It does not need interchangeable source plugins. In the full
tree, change metadata overlays listed paths; in the changed tree, parent
folders are derived from changed paths without a directory walk. A deletion
appears as a node absent at `state`, and a rename carries both old and new
paths. Selecting a deleted file shows its absence in file view and its old
content in diff view.

The right pane reuses `FileContent` for whole files and `DiffSections` for
client-side diffs of the two fetched file contents. A truncated file is not
diffed, because that would present a false deletion. Binary and missing
files get explicit states. A baseline makes the diff toggle available on a
changed file; the file at `state` remains available without the baseline.
The diff defaults to three context lines, with an **Expand all lines** toggle
that shows the complete diff from the already-fetched contents.

In `file` presentation, clicking a tree file selects it for the right pane.
In `review` presentation, changed files form a stacked, lazily loaded diff;
clicking a tree file scrolls to and opens its section, while the highlighted
tree node follows the visible section. This preserves the current DiffView's
sequential review workflow. Each section can switch to the full file at
`state`. On narrow viewports the tree starts collapsed behind a toggle; it
does not occupy an empty column.

| Entry point | State | Baseline | Tree | Presentation |
| --- | --- | --- | --- | --- |
| Changes row or git-stamp diff window | Window's new state | Window's old state | Changed | Review |
| Git card for a selected commit | Commit | First parent | Changed | Review |
| Project home or browser control | Worktree | None | All | File |
| File link or tool path | Requested state, else worktree | None | All | File, with path and line selected |

For a selected commit, the host resolves the first parent to an oid before
comparison (`gitBase`); a root commit uses the repository's empty-tree oid as
an internal diff base and treats every old-side file as absent. That tree oid is not a
commit or a selectable file snapshot. Neither `commit^` nor the empty tree
is a picker value. Recorded stamp oids
populate historical state choices. Selecting another state or baseline
reissues the relevant queries; an unreachable historical commit remains an
error while its stored stamp label stays intact.

The worktree can change between listing, diff, and content reads; the browser
does not claim those operations form an atomic snapshot. Reads happen on
open or state/selection changes, when a turn settles for a worktree-valued
target, and by hand through the browser's Refresh control. Worktree-derived
results retain an "as of" time; there is no polling.

The browser is read-only. It has no editor, tabs, split view, comments, or
generic action registry. Future restore/reset commands need explicit host
operations and confirmations; they do not change the read-query contract.

## Alternatives

- Keep separate file and diff portals: duplicates the tree, state selection,
  file rendering, and navigation while leaving Project-home browsing separate.
- Model a virtual filesystem shared by disk, index, and commits: obscures the
  difference between a live directory, a fixed commit, and a deleted file
  that exists only relative to a baseline. Two explicit queries suffice.
- Make diff a compulsory `(old, new)` pair: plain file browsing then needs
  a meaningless old endpoint. A state with an optional baseline expresses
  both use cases without that placeholder.
- Use a source/action plugin registry: adds indirection before there are
  independent sources or mutating actions that require it.

## Consequences and Verification

`FileViewer` and `DiffView` become one portal with one browser-open target in
the UI store. The conversation's git affordances (the turn chip menu, a git
card's `review` control, and the TopBar changes badge) keep their
stamp-derived pairs and open it with review defaults. There is no new
route; the browser is an ephemeral fullscreen surface. The host gains
directory listing, changes file reads and diffs to absolute-path addressing,
and returns change statuses. No worktree content is archived.

Verify directory reads on disk (including ignored and untracked files), at
HEAD, in the index, and at a pinned commit; Projects rooted below the git
root; missing or deleted paths and directories; root and merge commits;
renames, binary files, status and count parsing, capped results, and
unreachable objects. Host tests cover the query layer, the three-state matrix,
the file-list cap, and base resolution (`test/suite/repository-query.test.ts`,
`browser-verbs-daemon.test.ts`); web tests cover the pure tree builders, the
path arithmetic, and the section-key/tree-follow rules (`browserTree.test.ts`,
`paths.test.ts`, `browserSections.test.ts`). The container's DOM effects —
scroll-to-section, the viewport-follow highlight, and the line anchor — are
exercised manually; they are the browser's only untested seam. Existing
file-link and review triggers must continue to open the appropriate content.

## Implementation Notes

Decisions taken where the Decision section was silent, recorded here rather
than folded into the ADR's own text:

- `.git` is never listed, live or at a snapshot: it is machine state, not
  project content.
- Directory listings cap entries at 2000 and report the remainder through
  `omitted`; an index listing over the 8 MB byte cap is refused rather than
  reported as complete, because a truncated flat path list cannot be converted
  into a trustworthy child set.
- The diff directive runs two spawns (`--raw -z` for statuses, `--numstat -z`
  for the file list) rather than the single combined invocation the Decision
  section names as an example. numstat stays the authority for which files are
  listed; the worktree can drift between the spawns, which the "no atomic
  snapshot" clause already covers.
- The changed-file list is count-capped (`MAX_DIFF_FILES`) with an exact
  `filesOmitted`. The argv is not byte-capped: numstat has one record per file,
  bounded by repository size, so the omitted count is trustworthy where a
  truncated byte stream's would not be.
- The commit review resolves its base host-side in one query (`gitBase`), so
  the client never builds `<rev>^` and never needs the repository's
  hash-algorithm constant for the empty tree.
- `gitDiff` keeps its `(old, new, directory)` argument order and adds the
  directory as a required absolute path; `gitBase` is attachment-free and
  directory-scoped like it, while `gitShow` remains attachment-bound (its
  commit resolves against the attached Project cwd).
- The browser root stays the Project cwd, as specified. Rooting at the
  repository root when the Project cwd is inside one remains a candidate
  follow-up: it would apply gitignore naturally and avoid a tree truncated
  mid-repository.
- Each diff directive stream is byte-capped as a memory guard (16 MiB). A
  byte-truncated numstat cannot supply an exact `filesOmitted`, so it is
  refused as an error rather than reported as a partial list; a truncated raw
  stream only costs the status letters past the cut, which fall back to
  `unknown`.
- A directory listing that cannot be read is an error, not an empty listing,
  and a failed blob read is only `absent` after the state itself resolves
  (`rev-parse <rev>^{tree}` for a commit, `ls-files` for the index). Otherwise a
  broken index or an unreachable commit would render as a directory and files
  that simply do not exist.

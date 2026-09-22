# Git Identity Stamps

A git stamp is a `custom` Session entry that records a repository identity
observed at a defined boundary. Its reserved custom type is
`pi-bridge.git-stamp`. A stamp records the full commit object id when HEAD
resolves, the short symbolic branch when HEAD is attached, an optional commit
subject, and the observation anchor. It is a historical observation, not a
worktree-status snapshot: dirty files, change counts, remotes, and causality
are not recorded.

The entry shape and the other `custom` entry rules are defined in [the core
data model](../core/data-model.md). The host writes stamps, the core module
owns the payload contract and parsing, and the viewmodel and web client own
projection and rendering. The stamp is ordinary Document data: it is persisted,
reconciled, cached, and synchronized like any other custom Entry, while
remaining inert in LLM context.

## Observation Boundaries

The host bundles one serialized git-stamp extension into each Manager runtime.
It samples the repository in the Manager cwd at four boundaries:

- `prompt`: `message_start` for a user message, before pi persists that
  message. This includes steering prompts. A prompt stamp labels the state in
  which the user message begins.
- `tool_end`: `tool_execution_end` after each agent tool completes. This is
  the primary agent-facing boundary and covers built-in and custom tools. With
  parallel tools, completion order supplies only positional ordering; the
  stamp does not claim that a particular tool caused a change.
- `turn_end`: `turn_end`, after the turn's assistant and tool-result entries
  have been persisted. It is a backstop for changes missed at tool boundaries
  or made by delayed subprocesses.
- `user_bash_end`: a host trigger after a persisted bridge user `!` or `!!`
  command appears as an `entry_appended` event with a `bashExecution` message.
  If the command was queued during streaming, this boundary is when its entry
  is persisted, not necessarily when the process itself finished.

Observations are serialized in one promise queue. A failed observation recovers
inside the queue so it cannot prevent a later boundary from being observed.
The host queries git with bounded plumbing commands in the Manager cwd:

```text
git rev-parse --verify --quiet HEAD
git symbolic-ref --short --quiet HEAD
git log -1 --format=%s --no-decorate HEAD
```

Each identity command has a 500 ms budget. Exit code 1 is meaningful for the
first two commands: it represents an unborn HEAD or detached HEAD,
respectively. Spawn failures, kills, timeouts, and other failed identity
queries produce no stamp. An unborn branch with a null commit and a detached
HEAD with a resolved commit are valid observations. The subject query is
best-effort: a subject failure leaves a valid identity with a null subject.

The writer finds its baseline by scanning the active Session branch from the
leaf toward the root and taking the last valid v1 or v2 stamp. It does not
keep a process-local baseline, so resume, branch navigation, and forked paths
use the same rule. When the observed identity is different from that baseline,
or no valid baseline exists, the writer appends a v2 stamp. Otherwise it writes
nothing. The sample is a bounded, asynchronous observation of git; it is not
an atomic snapshot across the three commands.

A prompt observation is awaited before the user message is persisted. A
tool-end observation is awaited in the tool lifecycle. A turn-end observation
runs after the turn entries are persisted. The user-bash trigger is enqueued
after the host applies and publishes the bash entry. A slow observation can
still encounter another append before it writes; the resulting parent is the
current leaf when the append occurs, so sequence placement is best effort.

A `tool_end` stamp parents on the persisted assistant entry, which mid-turn
the live Document holds only as its `pending:message` provisional. The
append therefore defers to the turn-end reconcile: clients see the stamp
when the turn settles, not during streaming.

## Payload Versions

New stamps use v2. Readers accept v1 and v2, and versions can be mixed in one
Session file. Unknown versions do not establish a baseline and do not render.

The v1 payload is:

```ts
interface GitStampDataV1 {
  v: 1;
  anchor: "prompt" | "turn_end";
  commit: string | null;
  branch: string | null;
}
```

The v2 payload adds the subject and the `tool_end` and `user_bash_end`
anchors:

```ts
interface GitStampDataV2 {
  v: 2;
  anchor: "prompt" | "tool_end" | "turn_end" | "user_bash_end";
  commit: string | null;
  branch: string | null;
  commitSubject: string | null;
}
```

Both versions are stored as the `data` of a `custom` entry with
`customType: "pi-bridge.git-stamp"`. The commit is either null or a lowercase
40- or 64-character hexadecimal object id. The branch is either null or a
non-empty single line with no control characters. A subject is either null or
a non-empty single line with no control characters.

`parseGitStampData` validates the version, anchor, commit, and branch. For v2,
an absent or null subject is null. A malformed subject is also cleared to null,
while the otherwise valid v2 stamp remains valid. Thus bad subject metadata
never erases a usable `{ commit, branch }` observation. Invalid identity fields,
invalid anchors, invalid versions, arrays, or non-object payloads invalidate
the stamp. `parseGitStampEntry` accepts both pi's `type: "custom"` entries and
bridge `kind: "custom"` Entries, but only for the reserved custom type.

The transition key is exactly the pair `{ commit, branch }`. The
`sameGitIdentity` comparison ignores the commit subject and the anchor. A
subject change at the same commit and branch is not a new git transition, and
two observations at different boundaries with the same pair are not repeated.
This also means a valid v1 stamp and a v2 stamp can represent the same
identity even though v1 has no subject.

## ViewModel Projection

The viewmodel walks the active root-to-leaf path and carries the last valid
stamp forward. The carried `{ commit, branch }` and the v2 subject become the
effective git fields on every subsequent `UserTurn` until another valid stamp
changes them. A path with no valid stamp has no effective git identity.
Stamps on another branch do not participate.

The stamp's position and anchor determine its display form:

- A `prompt` stamp produces no standalone item. Its effective identity is
  shown on the following user turn as the git identity chip; the v2 subject is
  the chip tooltip.
- A `user_bash_end` stamp, or a `turn_end` stamp reached with no assistant turn
  open, becomes one standalone `GitChangeTurn` at its path position. It is
  ordered like a transcript item but is not a user or assistant turn and does
  not participate in sibling navigation, editing, or tool-result joining.
- A `tool_end` or `turn_end` stamp reached while an assistant turn is still
  accumulating is carried as an `InlineGitStamp` on that assistant turn. It
  records the last accumulated block as `afterBlockKey` and does not split the
  turn. The first valid stamp on the path is flagged as an initial state;
  later identity transitions are change states.

Inline stamps are assigned to the action group containing their anchor block.
When the anchor is a text block, they attach to the nearest preceding action
group; if no such group exists, they remain unattached and render after the
turn's segments. This prefix-stable placement keeps a growing streamed turn
from moving an already-rendered card to another group.

Invalid stamps and unknown custom entries are invisible to this projection.
Commit subjects are never synthesized for v1 entries. A stored commit may no
longer be reachable from the current checkout; automatic projection still
uses the stored identity and subject without resolving the commit live.

## Web Rendering

The web client renders the two viewmodel placements with the same git change
card. A standalone `GitChangeTurn` appears between ordinary transcript turns.
An inline stamp appears inside its owning action group after the action it
follows. The group summary includes a git segment and its kind-dot list
includes the git kind when inline changes are present.

A user-turn chip displays a compact form of the effective branch and an
abbreviated commit. A change card displays the commit subject when available,
with branch and short commit metadata alongside it. Its expanded header
restores the full commit id, anchor, and timestamp, and uses neutral wording
such as `Git state observed`; position does not prove that a particular
parallel tool caused the change.

Cards with a commit can be expanded to request `gitShow`. The request is
attachment-bound and the host runs `git show --stat --no-color` against the
attached Session's Project cwd, with strict commit-id validation, a five-second
timeout, and a 128 KiB output cap. A missing or unreachable commit produces a
card error state while leaving the recorded labels intact. Unborn or unknown
identities have no commit to expand.

The renderer is web-owned; the host does not send a special git wire message.
The custom Entry travels through the ordinary Document, patch, initial-sync,
and lazy-pull mechanisms. The host-side viewer query is described with the
other host operations in [runtime.md](runtime.md).

## Enablement and Invariants

`createManager` enables the bundled extension by default through its
cwd-bound runtime services. Passing `gitStamps: false` omits the extension and
leaves the host user-bash trigger disabled; this is the test seam for runs
that must not write repository observations. Each Manager gets one extension
bundle, and the host trigger targets only that Manager's runtime.

The following invariants define the feature:

- New stamps are v2; valid v1 stamps remain readable.
- Only the reserved custom type is treated as a git stamp.
- A successful observation appends only when the `{ commit, branch }` key is
  new relative to the last valid stamp on the active path.
- Commit subjects and anchors never participate in transition suppression.
- Invalid v2 subjects clear to null without invalidating the stamp.
- Invalid payloads and unknown versions establish no baseline and render no
  card.
- A stamp is context-inert and does not enter the LLM prompt.
- Observation failures do not poison the serialized observation queue.
- A stamp's relationship to nearby tools is positional and best effort; no
  causal claim is made, especially for parallel tools.
- Stored commit ids and subjects are historical labels; automatic rendering
  does not replace them with current repository state.

# ADR 10: Git Identity Stamps

**Status:** Decided. Implemented — writer extension (`src/host/git-stamp-extension.ts`,
enabled by `createManager`), shared payload module (`src/core/git-stamp.ts`),
viewmodel fold, and web chip. Adds bridge-owned metadata using existing pi
extension and session primitives. No changes to pi-core, the pi session
format, or the wire protocol. Bridge-scoped in v1: only bridge-created
instances write stamps. Extraction into a shared or built-in pi extension is
deferred until the feature proves useful outside the bridge.

## Context

When reviewing a long session, the reader wants to know which repository
identity each prompt used: for example, "this message ran against `main` at
`a1b2c3d`, before the rebase." The session header records only the working
directory, and the transcript currently carries no repository identity. The
information is otherwise available only from the reader's memory or from the
current checkout.

The bridge should record the repository's **Git identity** at session
boundaries as ordinary pi `custom` entries:

- the full `HEAD` commit, when one exists;
- the symbolic branch, when `HEAD` is attached;
- the boundary at which the observation was taken.

This ADR deliberately does not define a complete `git status` snapshot. Dirty
state, change counts, remotes, and descriptions are excluded from v1 because
they require a worktree scan or additional Git queries and change frequently.
The feature is therefore called Git identity stamps rather than Git status.

## Decisions

### 1. Use a bridge-bundled extension

The implementation is an inline extension owned by `pi-bridge`, registered
through `resourceLoaderOptions.extensionFactories` when the bridge creates an
`AgentSession`. It is enabled by default for bridge-created instances. User
discovered extensions continue to load alongside it.

This keeps repository observation out of pi-core and out of ordinary pi TUI
sessions. It also reuses the existing extension lifecycle, `custom` entry
persistence, and `entry_appended` event path.

The extension uses the reserved custom type:

```text
pi-bridge.git-stamp
```

The namespace prevents collisions with user extensions that also register
custom entries or renderers.

### 2. Record transitions, not repeated snapshots

Most boundaries have the same commit and branch as the preceding boundary.
The extension persists a stamp only when the identity changes or when the
active path has no known stamp. The bridge viewmodel carries the last stamp
forward so every user turn can still display its effective identity.

This is a storage optimization, not an audit guarantee. A commit and subsequent
reset between two observations may be invisible. The feature answers which
identity was observed at the session boundaries, not every Git mutation.

### 3. Observe two boundaries

The extension samples one shared transition stream at two boundaries:

- `message_start` for user messages, before pi persists the user message;
- `turn_end`, after the assistant message and tool results for that turn have
  been persisted.

The prompt observation records the identity the prompt is about to use. The
turn observation records the identity left behind by the turn, including a
commit made by an agent tool. Steering prompts are user messages and use the
same prompt boundary.

There are no observations on session start/resume, assistant streaming events,
compaction, or user `!bash` entries. A Git mutation made by `!bash` is observed
at the next prompt or turn boundary.

### 4. Derive the baseline from the active path

The baseline is the last parseable v1 stamp on the current active branch of the
session tree. The extension obtains that path with
`ctx.sessionManager.getBranch()`, then scans it from the leaf toward the root.
It does not keep a process-local identity baseline.

This is required for resume and navigation:

- reopening a session without a repository transition does not duplicate a
  stamp;
- forking from an older entry ignores stamps on the abandoned path;
- a new repository created in the same working directory establishes its first
  stamp at the next successful observation;
- unknown or malformed stamp versions do not establish a baseline.

The writer and reader use the same path definition: the transition key is
compared against, and the fold is computed from, the last valid v1 stamp on
the active path.

### 5. Keep stamps context-inert

Plain `custom` entries do not participate in LLM context. Git identity is
reader-facing metadata and must not consume tokens or alter agent behavior.

## Data Model

The persisted payload is versioned because session entries outlive the
extension implementation that wrote them:

```ts
interface GitStampData {
  v: 1;
  anchor: "prompt" | "turn_end";
  commit: string | null;
  branch: string | null;
}
```

`commit` is the full lower-case object ID returned by Git. It is normally 40
hexadecimal characters, or 64 for a SHA-256 repository. It is `null` for an
unborn or otherwise unresolved `HEAD`.

`branch` is the short symbolic branch name and is `null` for detached `HEAD`.
An unborn branch therefore has a branch name with a `null` commit. A detached
unborn or otherwise incomplete state may have both values `null`.

`anchor` is explicit because delta storage makes position alone ambiguous. A
stamp between a turn's final entry and the next user message could have been
written by either adjacent boundary; consumers must use `anchor`, not infer it
from neighboring entries.

The complete entry is:

```ts
{
  type: "custom",
  customType: "pi-bridge.git-stamp",
  data: GitStampData,
  id: string,
  parentId: string | null,
  timestamp: string,
}
```

## Semantics

### Observation algorithm

For each eligible event, the extension enqueues one observation. The queued
critical section is:

1. read the active path with `ctx.sessionManager.getBranch()`;
2. locate the last parseable `pi-bridge.git-stamp` with `v: 1`;
3. query the current Git identity;
4. compare `{ commit, branch }` with the baseline;
5. append a custom entry only for a missing baseline or a changed key.

The queue is a promise chain. Each task must recover from Git or append errors
before resolving the chain, so one failed observation cannot prevent all later
observations. The Git command receives the event context's abort signal and a
500 ms timeout. The observation sits on the awaited prompt path, so the budget
is deliberately small relative to an LLM round-trip: two Git plumbing spawns
cost roughly ten milliseconds, and a hung Git cannot perceptibly delay prompt
handling. Aborts and timeouts are observation failures and do not append
entries; the next successful boundary records the transition.

Extension handlers are awaited by pi. For a prompt, this places the stamp
before the user message in normal operation. For `turn_end`, the preceding
message and tool-result persistence has completed, so the stamp is normally the
leaf immediately after the turn.

The extension does not attempt to insert entries at arbitrary historical
positions. If an unrelated append or navigation occurs while Git is being
queried, the stamp is parented at the leaf present when `appendEntry()` runs.
The observation remains a true wall-clock sample, but its tree placement can
reflect that concurrent operation. Bridge navigation and mutation controls are
normally disabled while streaming; this residual race is documented rather
than treated as an atomicity guarantee.

### Git query and consistency

The implementation uses Git plumbing commands in the instance working
directory:

```text
git rev-parse --verify --quiet HEAD
git symbolic-ref --short --quiet HEAD
```

The commands are run as two asynchronous processes. The first command's exit
code 1 means that `HEAD` has no resolvable commit; the second command's exit
code 1 means that `HEAD` is detached. Other failures make the observation
unknown and produce no entry.

The two processes are not an atomic Git snapshot. A checkout can occur between
them and produce a transient commit/branch pair that never represented a
stable user-visible state. The implementation must validate both outputs and
may reject clearly invalid results, but v1 accepts this narrow race as a
best-effort observation. Readers must treat stamps as historical labels, not as
an authoritative reconstruction of Git.

Nor can locking raise the ceiling: Git can mutate immediately after the sample,
and the prompt itself is an asynchronous human action, so no mechanism makes a
stamp transactional with the message timeline. Best-effort observation is the
ceiling of what this feature can claim.

Output validation is structural:

- commit output must be one lower-case hexadecimal object ID of length 40 or
  64, unless the command reported an unborn/unresolved `HEAD`;
- branch output must be a single non-empty line containing no control
  characters, unless the command reported detached `HEAD`. Git itself produced
  the ref name, so no stricter refname-syntax check is attempted; re-validating
  against refname rules would risk rejecting legitimate names;
- extra output, control characters, and invalid values cause the observation to
  be discarded.

The bridge does not parse `.git` files. Git itself handles linked worktrees,
submodules, packed refs, `GIT_DIR`, and future repository layout changes more
reliably than a bridge implementation can.

### Errors and unavailable repositories

If the working directory is not a Git repository, Git is unavailable, or an
observation times out, no stamp is written. The path baseline remains
unchanged. A later successful observation compares against that baseline and
may record the transition that happened during the failure window.

An unborn branch is valid metadata, not an error. A detached `HEAD` is also
valid metadata when its commit resolves.

### Tree and context behavior

Stamps are ordinary leaf-parented entries. A fork includes only stamps on its
own root-to-leaf path. The effective identity at a display point is the last
valid stamp at or before that point, carried forward along the path. An empty
stamp set means unknown, not an error.

Rebases, resets, and force-pushes may make a stored commit unreachable from the
current repository. Renderers display the stored hash and do not resolve it
against the live repository.

## Bridge Integration

The bridge `Document` already projects pi `custom` entries, assigns them an
`ord` during reconciliation, includes them in replace snapshots, and sends them
through the existing cache path. No new wire type is required.

The viewmodel currently ignores generic custom entries. It adds a Git-stamp
fold while walking the active leaf path:

- parse only `kind: "custom"`, `customType: "pi-bridge.git-stamp"`, and
  `data.v === 1`;
- update the carried identity when a valid stamp is encountered;
- expose the carried identity on each `UserTurn`;
- leave unknown custom types and malformed Git stamps invisible;
- do not split or merge conversation runs because of a stamp.

The web renderer displays the effective identity on every user turn. A missing
identity is rendered as unknown or omitted according to the existing
conversation metadata treatment. The display uses the full stored value as its
source but may abbreviate the commit for compact presentation.

Plain pi TUI sessions do not enable the bridge extension and therefore do not
write new stamps. Existing stamps remain inert there unless the same extension
is installed and its renderer is registered. This is acceptable because the
bridge web client is the v1 reader.

## Enablement

`createManager` passes the factory to the cwd-bound services:

```ts
resourceLoaderOptions: {
  extensionFactories: [
    {
      name: "pi-bridge.git-stamp",
      factory: gitStampExtension,
      hidden: true,
    },
  ],
},
```

The factory is included for the initial runtime and for every session rebind.
The bridge must expose a test-only or injected option to disable the factory;
the default remains enabled. The test harness must be able to use a temporary
Git repository so fixture sessions do not accidentally record the bridge
repository's identity.

## Alternatives Considered

### Per-prompt absolute stamps

Writing a complete stamp before every prompt is simpler and makes each message
self-contained in raw JSONL. It also repeats the same identity through most of
a session. The v1 bridge reader already walks the active path, so transition
storage provides the same display behavior with fewer entries. The loss of
simple per-line inspection is an intentional tradeoff.

### Asynchronous (fire-and-forget) observation

Rejected. A fire-and-forget handler returns before the user message is
persisted, and the Git subprocess completes afterward — usually mid-turn. The
sample time drifts away from the boundary the stamp claims to describe, and
the stamp lands after the user message, where the positional fold attaches it
to the wrong turn. Awaiting the observation costs roughly ten milliseconds on
a path that continues into an LLM round-trip, and the 500 ms timeout bounds
the worst case. If prompt-path latency ever matters, the cheaper variant is
dropping the prompt anchor entirely and sampling only at `turn_end`, at the
cost of labeling the first prompt after a between-turns mutation (for example,
a user `!git commit`) with the stale identity.

### A new pi-core session entry or message field

Rejected. It would force Git observation on every pi user, add filesystem and
process concerns to pi-core's message path, and ripple through pi types,
bridge projection, reconciliation, viewmodels, and renderers.

### A built-in pi extension

Deferred. A built-in extension would make the default-on decision global to pi
and would need to reach every `AgentSession` construction path. Bridge bundling
keeps the behavior limited to instances where the feature is useful.

### Dirty state

Deferred. `git status` requires a worktree/index scan and changes much more
frequently than commit identity. Adding `dirty` to the transition key would
increase entry volume; adding it only to the payload would make it stale. A
future version may add a separately defined dirty observation if the product
requires it.

### User-bash observations

Deferred. A user `!git commit` can change Git between boundaries. Sampling the
next prompt is adequate for v1 recall. A future version may add an after-bash
anchor if users need the shell command itself to show the resulting identity.

### Hand-rolled `.git` parsing

Rejected. Worktrees, submodules, `commondir`, `gitdir` indirection, packed refs,
and environment overrides create correctness cases that Git already handles.
The bridge should accept asynchronous process startup cost rather than persist
silently incorrect repository metadata.

## Invariants

- Stamps use the exact custom type `pi-bridge.git-stamp`.
- A valid v1 stamp is immutable once written.
- Adjacent valid stamps on a root-to-leaf path never have the same identity
  key.
- The writer baseline and reader fold both use the last valid v1 stamp on the
  active path.
- Unknown versions and malformed payloads never establish a baseline and never
  render as Git identity.
- The fold is total: no stamps means unknown, not an exception.
- Git stamp data is display-only and never enters LLM context.
- A rejected or failed observation cannot poison the serialization queue.
- Stored hashes are historical labels and are never validated against the
  current repository after persistence.

## Test Plan

### Pure unit tests

- identity-key comparison;
- active-path baseline lookup using `getBranch()` semantics;
- unknown versions, malformed payloads, detached `HEAD`, and unborn branches;
- commit validation for SHA-1 and SHA-256 object IDs;
- branch-name validation and rejection of extra output;
- fold behavior across interleaved stamps, forks, and missing observations.

### Integration tests

Use the bridge harness with an injected temporary Git repository and the faux
provider:

- first successful prompt writes one baseline stamp;
- unchanged prompts and turns write no duplicates;
- a commit or checkout writes exactly one transition with the correct anchor;
- an agent tool that commits produces a `turn_end` transition;
- two separate committing turns produce two transitions;
- reopening without a Git transition writes nothing;
- forking from an earlier entry uses that path's baseline rather than a
  process-local value;
- a non-Git working directory, missing Git binary, timeout, and abort write
  nothing and do not block later observations;
- a repository created mid-session establishes a baseline on the next
  successful observation;
- custom-entry patches arrive in the expected order around prompt and
  turn-end events;
- the web viewmodel carries the effective identity to every user turn without
  changing assistant-run merging.

## Relationship to Other ADRs

The design uses ADR 02's `custom` entry projection and ADR 09's committed-entry
and `ord` semantics without changing either. Stamps are ordinary instance-log
entries. If ADR 08's object kernel is adopted, stamps remain entries in the
instance log and require no new facet or synchronization rule.

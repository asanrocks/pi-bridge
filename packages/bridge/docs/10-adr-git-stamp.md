# ADR 10: Git Identity Stamps

**Status:** Decided. The initial prompt/turn implementation is in place and
currently writes v1 payloads. This revision defines v2 as an additive extension
for event-level observations and visible Git change cards. It remains
bridge-scoped and uses existing pi extension and session primitives. There are
no changes to pi-core, the pi session format, or the wire protocol.

## Context

When reviewing a long session, the reader wants to know which repository state
was used for a prompt and when an agent changed that state. The session header
records only the working directory. A transcript currently carries no
repository identity, so the reader has to remember commits or inspect the
current checkout.

The bridge should record Git identity transitions as ordinary pi `custom`
entries and render those transitions as ordered transcript cards. A recorded
identity contains:

- the full `HEAD` commit, when one exists;
- the symbolic branch, when `HEAD` is attached;
- the commit subject, when it can be read;
- the event boundary at which the observation was taken.

This is not a complete `git status` snapshot. Dirty state, change counts,
remotes, and descriptions remain excluded because they require a worktree scan,
change frequently, and are a separate product concern. The feature records
Git identity transitions, not every filesystem mutation or every Git command.

## Decisions

### 1. Use a bridge-bundled extension

The implementation is an inline extension owned by `pi-bridge`, registered
through `resourceLoaderOptions.extensionFactories` when the bridge creates an
`AgentSession`. It is enabled by default for bridge-created instances. User
discovered extensions continue to load alongside it.

This keeps repository observation out of pi-core and ordinary pi TUI sessions.
It reuses the existing extension lifecycle, `custom` entry persistence, and
`entry_appended` event path.

The extension uses the reserved custom type:

```text
pi-bridge.git-stamp
```

The namespace prevents collisions with user extensions that also register
custom entries or renderers.

### 2. Record transitions, not repeated snapshots

The extension persists a stamp only when the identity differs from the last
valid stamp on the active path or when that path has no known stamp. The bridge
reader walks the active path and carries the last identity forward, so every
user turn still has an effective Git identity without repeating identical
entries.

This is a storage optimization, not an audit guarantee. A commit followed by a
reset between observations may be invisible. The feature answers which
identities were observed at defined boundaries, not every Git mutation.

### 3. Observe operation boundaries

One serialized observation stream is sampled at these boundaries:

- `message_start` for a user message, before pi persists that message. This
  labels the identity the prompt starts with. It also covers steering prompts.
- `tool_execution_end` after every agent tool has finished. This is the primary
  agent-facing trigger and applies to built-in and custom tools. It samples the
  repository at the nearest available post-tool boundary; with parallel tools,
  the observed state may include changes from another process.
- `turn_end` after the assistant message and tool results for the turn have
  been persisted. This remains a backstop for mutations not captured at a tool
  boundary or for changes made by delayed subprocesses.
- completion and persistence of a bridge user `!` or `!!` command, represented by
  an `AgentSessionEvent` with `type: "entry_appended"` whose entry is a
  `message` with `message.role === "bashExecution"`. The host observes this
  event after `SessionManager.appendMessage()` and uses the `user_bash_end`
  boundary. If bash execution was deferred while an agent turn was active, the
  event occurs when the pending bash message is flushed after that turn; this
  boundary therefore means bash-entry persistence, not necessarily process
  completion.

There is no separate observation for an assistant `message_end`: assistant
messages do not mutate the repository, while tool completion does. There are no
observations for streaming deltas or compaction. A bridge session with no
existing stamps remains Git-unknown until its next eligible observation; attach
or resume does not create an initial card by itself.

A tool-end stamp is normally appended after the assistant tool-call entry and
before pi emits the final tool-result message events. A turn-end stamp is
normally the leaf after the turn. A prompt stamp is appended before the user
message, so that message parents onto the stamp. These positions let the
reader render a change card at the point it was observed.

When tools run in parallel, `tool_execution_end` arrives in completion order.
The stamp is linked to nearby tool or bash entries by sequence position only.
The observation queue preserves bridge ordering but cannot establish causality
between concurrent processes. The card must use wording such as "Git state
observed" rather than claiming that a particular tool caused the change.

### 4. Derive the baseline from the active path

The baseline is the last parseable v1 or v2 stamp on the current active branch
of the session tree. The extension obtains that path with
`ctx.sessionManager.getBranch()`, then scans it from the leaf toward the root.
It does not keep a process-local identity baseline.

This is required for resume and navigation:

- reopening a session without a repository transition does not duplicate a
  stamp;
- forking from an older entry ignores stamps on the abandoned path;
- a new repository created in the same working directory establishes its first
  stamp at the next successful observation;
- unknown or malformed stamp versions do not establish a baseline;
- legacy v1 stamps remain effective identities even though they have no commit
  subject and only have prompt or turn-end anchors.

The writer and reader use the same path definition. The transition key is
`{ commit, branch }`; commit subjects and the observation anchor do not affect
duplicate suppression.

### 5. Keep stamps context-inert

Plain `custom` entries do not participate in LLM context. Git identity,
commit subjects, and the observation anchor are reader-facing metadata and
must not consume tokens or alter agent behavior.

## Data Model

New entries use a versioned v2 payload. The reader continues to accept the
implemented v1 payload so existing bridge sessions remain useful. V2 is an
additive extension of the v1 data: `commit` and `branch` retain their meaning,
`commitSubject` is added, and the `anchor` value set is extended for tool and
user-bash boundaries.

The payload versions may be mixed in one append-only session file. Existing v1
entries are not rewritten or converted. There is no v2-to-v1 downgrade path;
new readers read both versions, while a v1-only reader cannot interpret v2
anchors or v2 entries. If binary rollback compatibility is required, deploy a
reader that understands v2 before enabling v2 writes.

```ts
interface GitStampDataV2 {
  v: 2;
  anchor: "prompt" | "tool_end" | "turn_end" | "user_bash_end";
  commit: string | null;
  branch: string | null;
  commitSubject: string | null;
}
```

`commit` is the full lower-case object ID returned by Git. It is normally 40
hexadecimal characters, or 64 for a SHA-256 repository. It is `null` for an
unborn or otherwise unresolved `HEAD`.

`branch` is the short symbolic branch name and is `null` for detached `HEAD`.
An unborn branch therefore has a branch name with a null commit.

`commitSubject` is the first line of the current `HEAD` commit message, read
with Git's subject formatter. It is `null` for an unborn `HEAD` or when the
subject query fails. Subject lookup failure does not invalidate a valid
identity observation.

`anchor` identifies the observation boundary. Tool and user-bash cards are
linked to nearby transcript entries by their sequential position and parent
chain. No tool name or call ID is persisted because the relationship is
best-effort and parallel tools make causal attribution unreliable.

The v1 payload remains:

```ts
interface GitStampDataV1 {
  v: 1;
  anchor: "prompt" | "turn_end";
  commit: string | null;
  branch: string | null;
}
```

Both versions use the same reserved custom entry:

```ts
{
  type: "custom",
  customType: "pi-bridge.git-stamp",
  data: GitStampDataV1 | GitStampDataV2,
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
2. locate the last parseable v1 or v2 stamp;
3. query the current Git identity;
4. if `HEAD` resolves, query its one-line subject as best-effort metadata;
5. compare `{ commit, branch }` with the baseline;
6. append a v2 custom entry only for a missing baseline or a changed identity
   key.

The queue is a promise chain. Each task must recover from Git or append errors
before resolving the chain, so one failed observation cannot prevent later
ones. Git commands receive the event context's abort signal and a 500 ms
per-command timeout. Aborts and timeouts are observation failures and do not
append entries; the next successful boundary records the transition that is
then visible.

The prompt observation is awaited by pi and completes before the user message
is persisted. The tool-end observation is awaited before the tool execution
lifecycle continues. The turn-end observation is awaited after the turn's
assistant and tool-result entries have been persisted. User-bash observation is
host-owned and runs after the bash result has been recorded.

The extension does not insert entries at arbitrary historical positions. If an
unrelated append or navigation occurs while Git is being queried, the stamp is
parented at the leaf present when `appendEntry()` runs. The observation remains
a wall-clock sample, but its tree placement can reflect that concurrent
operation. Bridge navigation and mutation controls are normally disabled while
streaming; this residual race is documented rather than treated as an atomicity
guarantee.

### Git query and consistency

The implementation uses Git plumbing commands in the instance working
directory:

```text
git rev-parse --verify --quiet HEAD
git symbolic-ref --short --quiet HEAD
git log -1 --format=%s --no-decorate HEAD
```

The first command's exit code 1 means that `HEAD` has no resolvable commit. The
second command's exit code 1 means that `HEAD` is detached. The subject command
has no subject for an unborn `HEAD`. Other identity failures make the
observation unknown and produce no entry; a subject-only failure produces a
valid identity entry with `commitSubject: null`.

The identity commands are run asynchronously and are not an atomic Git
snapshot. A checkout can occur between them and produce a transient
commit/branch pair that never represented a stable user-visible state. Subject
lookup can race with the same mutation. Readers must treat stamps as
historical labels and observations, not as an authoritative reconstruction of
Git.

Output validation is structural:

- commit output must be one lower-case hexadecimal object ID of length 40 or
  64, unless the command reported an unborn or unresolved `HEAD`;
- branch output must be a single non-empty line containing no control
  characters, unless the command reported detached `HEAD`;
- subject output must be one line after Git's expected terminal line ending;
- extra output, control characters, and invalid values cause the relevant
  observation data to be discarded. Invalid identity output discards the
  observation; invalid subject output only clears the subject.

The bridge does not parse `.git` files. Git itself handles linked worktrees,
submodules, packed refs, `GIT_DIR`, and future repository layout changes more
reliably than a bridge implementation can.

### Errors and unavailable repositories

If the working directory is not a Git repository, Git is unavailable, or an
identity observation times out, no stamp is written. The path baseline remains
unchanged. A later successful observation compares against that baseline and
may record the transition that happened during the failure window.

An unborn branch is valid metadata, not an error. A detached `HEAD` is also
valid metadata when its commit resolves. A missing commit subject is valid
metadata with a null subject.

### Tree and context behavior

Stamps are ordinary leaf-parented entries. A fork includes only stamps on its
own root-to-leaf path. The effective identity at a display point is the last
valid stamp at or before that point, carried forward along the path. An empty
stamp set means unknown, not an error.

A valid stamp is also represented as a `GitChange` item in the existing
ordered viewmodel sequence. The item carries the stamp entry id, timestamp,
identity, subject, and anchor. It participates in transcript ordering and
scrolling, but is not a user or assistant turn: it does not close or merge
assistant runs, participate in sibling navigation or editing, or join with
assistant tool results. User and assistant turn indexes retain their existing
editing semantics.

A stamp with no prior valid identity is rendered as an initial state recording;
a stamp with a changed identity is rendered as a Git change card. The card
shows the new branch/commit identity and, when present, the `HEAD` subject. The
item is not sent to the LLM. The renderer may abbreviate the commit in compact
layouts but uses the stored full value as its source.

Rebases, resets, and force-pushes may make a stored commit unreachable from the
current repository. Renderers display the stored hash and subject without
resolving them against the live checkout.

## Bridge Integration

The bridge `Document` already projects pi `custom` entries, assigns them an
`ord` during reconciliation, includes them in replace snapshots, and sends them
through the existing cache path. No new wire type is required.

The viewmodel must process valid Git stamps while walking the active leaf path:

- accept v1 and v2 stamps with the reserved custom type;
- update the carried effective identity after each valid stamp;
- expose that identity on every `UserTurn` so the prompt's repository state is
  easy to scan;
- emit one ordered `GitChange` item for each valid stamp; the first item is an
  initial state recording and later changed keys are Git change cards;
- preserve v1 items without inventing a subject or tool relationship;
- leave unknown custom types and malformed Git stamps invisible;
- keep observation cards out of LLM context.

Git-change items are separate visual cards in the conversation timeline. They
appear at the stamp's path position, including between an assistant tool-call
entry and its later tool result when the observation is tool-anchored. They are
not mistaken for user or assistant messages. The card shows the new identity
and optional subject, and uses wording such as "Git state observed" rather than
claiming that a particular tool caused the change when tools were concurrent.

Plain pi TUI sessions do not enable the bridge extension and therefore do not
write new stamps. Existing stamps remain inert there unless the same extension
is installed and its renderer is registered. The bridge web client is the v1
reader and the event-card renderer is bridge-owned.

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

The factory is included for the initial runtime and every session rebind. The
bridge exposes an injected option to disable it for tests; the default remains
enabled. The test harness uses temporary Git repositories so fixture sessions
do not accidentally record the bridge repository's identity.

The host-side user-bash trigger is the existing `entry_appended` event, filtered
for persisted `bashExecution` message entries. The host first applies and
publishes the bash entry, then queues the Git observation in the shared
serialized stream. The resulting stamp is normally parented to that bash entry
when no later append intervenes; an asynchronous lookup can still hit the
documented current-leaf race. The stamp is emitted through the same existing
custom-entry event path. This requires no change to pi-core's extension API. If
that event is unavailable for a particular entry path, the next prompt or tool
boundary remains the fallback observation.

## Alternatives Considered

### Prompt and turn boundaries only

The initial implementation sampled before prompts and at `turn_end`. It is
compact and sufficient for prompt recall, but an agent can perform several Git
operations before the turn ends. Tool-end observations provide better temporal
placement while transition suppression retains the file-size optimization.

### Per-message absolute stamps

Writing a complete stamp for every message makes raw JSONL self-contained, but
repeats the same identity through most sessions. The active-path fold provides
the same effective identity with fewer entries. Transition storage is an
intentional tradeoff for compact long-lived sessions.

### Parse shell commands to find Git operations

Rejected. Git operations can be hidden in scripts, aliases, subprocesses, or
custom tools. Command parsing also cannot identify changes made by hooks or
commands that do not contain the literal `git` executable. Post-tool sampling
is less precise than command instrumentation but applies uniformly to all
agent tools.

### Git hooks or a wrapped Git executable

Deferred or rejected for v1. Hooks are repository-local and may be disabled,
changed, or unavailable. Wrapping Git changes process resolution and security
behavior and still needs a transport into the session. Event sampling is
non-invasive and sufficient for the reader's primary question.

### Asynchronous fire-and-forget observation

Rejected. It drifts away from the boundary being labeled, can place the stamp
on the wrong tree position, and makes ordering with tool results ambiguous.
Awaiting a bounded observation keeps the sample near its declared boundary.

### Dirty state

Deferred. `git status` requires a worktree/index scan and changes much more
frequently than commit identity. Adding it to the transition key would
increase entry volume; adding it only to the payload would make it stale. A
future version may define separate dirty observations.

### A new pi-core entry or message field

Rejected. It would force Git observation on every pi user, add filesystem and
process concerns to pi-core's message path, and ripple through pi types,
projection, reconciliation, viewmodels, and renderers.

### Hand-rolled `.git` parsing

Rejected. Worktrees, submodules, `commondir`, `gitdir` indirection, packed refs,
and environment overrides create correctness cases that Git already handles.
The bridge should accept bounded process startup cost rather than persist
silently incorrect repository metadata.

## Invariants

- Stamps use the exact custom type `pi-bridge.git-stamp`.
- New stamps use v2 and valid v1 stamps remain readable.
- A valid stamp is immutable once written.
- A successful observation appends only when its `{ commit, branch }` key is
  new relative to the last valid active-path baseline. Readers tolerate a
  duplicate caused by the documented concurrent-append race.
- The writer baseline and reader fold both use the last valid v1 or v2 stamp on
  the active path.
- Unknown versions and malformed payloads never establish a baseline and never
  render as Git identity or a change card.
- A valid stamp produces one ordered Git state item and updates the carried
  identity; it does not enter LLM context.
- Commit subject and the observation anchor never affect transition
  deduplication.
- A rejected or failed observation cannot poison the serialization queue.
- The session sequence provides only a best-effort link between a stamp and
  nearby tool or bash entries; no causal attribution is guaranteed.
- Stored hashes and subjects are historical labels and are never validated
  against the current repository after persistence.

## Test Plan

### Pure unit tests

- v1 and v2 payload parsing and backward compatibility;
- identity-key comparison independent of subject and anchor;
- active-path baseline lookup using `getBranch()` semantics;
- unknown versions, malformed payloads, detached `HEAD`, and unborn branches;
- commit validation for SHA-1 and SHA-256 object IDs;
- branch and subject validation, including extra output;
- fold behavior across interleaved stamps, forks, and missing observations;
- viewmodel identity preservation when a user's effective identity changes;
- Git-change item ordering and card data for each anchor.

### Extension and integration tests

Use the bridge harness with injected temporary Git repositories and the faux
provider:

- first successful prompt writes one v2 baseline stamp;
- unchanged prompts, tool completions, and turn ends write no duplicates;
- a commit or checkout after an agent tool writes a `tool_end` transition with
  the new subject;
- a turn-end backstop writes a transition when no tool-end observation caught
  it;
- a user bash commit writes a `user_bash_end` transition when the host receives
  the persisted `bashExecution` `entry_appended` event; deferred bash entries
  are tested at their actual flush/persistence boundary;
- a subject lookup failure preserves the identity transition with a null
  subject;
- parallel tool completions preserve serialized observation order and use
  sequence-position linking without claiming causal attribution;
- two separate committing turns produce two transitions and two cards;
- reopening without a Git transition writes nothing;
- forking from an earlier entry uses that path's baseline rather than a
  process-local value;
- a non-Git working directory, missing Git binary, timeout, and abort write
  nothing and do not block later observations;
- a repository created mid-session establishes a baseline on the next
  successful observation;
- v1 stamps fold into effective identities and render without v2 metadata;
- custom-entry patches arrive in the expected order around prompt, tool-end,
  user-bash, and turn-end events;
- Git-change items carry stable entry ids, appear in path order, and do not
  alter user/assistant editing indexes, assistant-run merging, or tool-result
  joining;

## Relationship to Other ADRs

The design uses ADR 02's `custom` entry projection and ADR 09's committed-entry
and `ord` semantics without changing either. Stamps are ordinary instance-log
entries. If ADR 08's object kernel is adopted, stamps remain entries in the
instance log and require no new facet or synchronization rule.

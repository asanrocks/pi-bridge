# Agent control

Codex MultiAgentV2 multi-agent tools over bridge Sessions. One Agent is one
**Session**: its JSONL file, address, Document, and user-visible row are
unchanged. The tools are one presentation of that Session to another agent; they
add no second kind of runtime.

Source: `src/host/agent-control.ts` (tool surface, live tree, activity signals),
`src/host/agent-policy.ts` (the role briefs), the `spawnControlledAgent` path in
`src/host/worker-local.ts` (Session creation, context fragments, the path/stem
mapping), and `src/core/agent-contract.ts` (the tool names and the mail payload
the host writes and the browser reads). Tool behaviour is specified against
Codex's v2 surface, because the model's policy — when to delegate, when to wait,
how to read a status — is part of that contract, not an implementation detail.

## Shape

The first Session to spawn is the **root** of a tree. Its canonical path is
`/root`; a child's path is the slash-joined task names below it, so a child of
`/root/task1` spawned as `task_3` is `/root/task1/task_3`. Every record carries
`rootId`, `parentId`, `depth`, and its canonical path.

A target resolves by thread id, then by path: an absolute path stands as
written, anything else is relative to the caller. There is no bare-name search —
`task_3` from `/root/task1` means `/root/task1/task_3` and nothing else — so an
ambiguous reference fails with ``live agent path `/root/task1/task_3` not found``
instead of reaching a different agent. Task names and references are validated
with Codex's messages (`agent_name must use only lowercase letters, digits, and
underscores`, ``agent_name `root` is reserved``, and so on), so a spawn can never
build a path outside the tree. Targets resolve inside the caller's tree only;
cross-Project agents are not supported.

Creation reuses the `createSession` choreography: a claimed address, fresh
Manager (or a `SessionManager.forkFrom` branch for `fork_turns=all`),
registration, optional model/thinking choice, then one admitted first prompt.
Every child's SessionManager is rooted at the child's own directory, which is
what makes the spawn's storage layout the tree (below).
The Worker then mints an actor capability for the child and holds it: a
controlled agent is a live capability, so idle collection cannot reap it. The
file stays and the Session remains openable like any other. `fork_turns=all` on
a Session whose file does not exist yet inherits nothing — `SessionManager` only
creates the file with a conversation — so it behaves as `none` instead of
failing.

A spawned Session's address is its file name: `<sessionDir>/<spawner stem>/
<task name>.jsonl`. The path a parent addresses (`/root/a/b`) and the file the
daemon scans (`a/b`) are one string, so the tree is read from addresses and
nothing records the relation — no sidecar, no metadata field, and no second
source for the sidebar, which projects the hierarchy from the rows it already
has (`sidebarTree`). The claim is made before anything is created and before the
spawn can await: `reserveSessionFile` creates the file exclusively, so two
concurrent spawns cannot both take one task name, and a name already on disk — a
closed child's file, or a spawn that crashed — is refused with ``agent path
`/root/a/b` is already in use`` instead of being overwritten. A name is freed by
trashing the file, never by closing the agent. A failed creation removes its
claim, so a retry can use the name.

A spawn writes no place: Inbox and Later are the user's attention list, and
only the user's own prompt may put a Session there, so the child stays Archive,
the absence of a record. The queue slice still carries a live spawned Session —
derived from its runtime and the place of the queued Session above it — so the
sidebar can draw it under that tree without making it a member: Inbox counts,
the keyboard ring, and the launcher's queue ignore an Archive row. The browser
then draws such a row only while it is running or while the Session on screen is
it or its spawner, so the slice is reachability rather than a permanent row. A
user's prompt to the child promotes it like any other message. Dormant
descendants are not derived, because finding them would mean walking the history
the queue is not allowed to walk (ADR 24), so an unloaded child appears only in
the archived tail.

The child is also given `session_info` set to its task name. The file name
carries it already; the row's title is the place a reader sees it, and without
it a row is titled by its first message, which is the protocol envelope.

A child's own children nest the same way, so depth is directory depth: a child
of `/root/a/b` spawned as `c` is stored at `a/b/c.jsonl` and addressed as
`/root/a/b/c`. Because the hierarchy is structural, trashing a spawner trashes
its subtree (see `trashSession` in `runtime.md`), and the sidebar draws the tree
rather than the location groups: a live descendant follows its spawner into the
root's group, except one whose place is more attentive than its spawner's (an
Inbox child of a parked or archived parent), which stays a root of its own group
with a `↳` mark naming the spawner. A child whose spawner is not rendered at all
— an archived parent whose page is not loaded — sits at depth 0 with the jump.

The mapping between a canonical path and a file belongs to the Worker alone
(`stemForAgentPath`), because it is storage layout: a spawn composes a child's
stem from its own, and every other address — a settlement's parent, a reply to
the root — is asked for through `AgentControlDeps.addressOf`. The control plane
holds paths and never derives a stem, so a layout change cannot leave a second
copy of the arithmetic behind.

## State ownership

The control plane holds topology and policy; it does not hold a second copy of
runtime state. Three invariants keep that true:

- **Capacity is claimed, not counted.** A spawn or an idle follow-up reserves its
  turn synchronously, before the first `await`, and releases it when the record
  takes over or the call fails. Counting live records alone lets concurrent
  callers each pass a check that predates every child.
- **Liveness is the runtime's.** `ControlledAgent.isBusy()` answers `running`;
  an admitted-but-not-yet-started turn counts as running too, so pi's phase cannot
  lag an admission. A tool handler never writes a terminal state: admitting a new
  turn only clears the one it replaces, and it clears it before the admission
  awaits. pi's trigger-turn admission resolves only when the run settles, so a
  claim written after that await would erase the result that ended the turn and
  keep the slot the settlement freed; claiming first is also what makes a
  concurrent follow-up steer instead of claiming a second slot.
- **A terminal state is the settlement event's.** The handler records the outcome
  before reading the result text, so status never lags the settlement, and a later
  read only fills in the payload. A turn that settles while an interrupt is in
  flight keeps its result; the interrupt reports the status observed before
  dispatch, as Codex does.

## Tools

| Tool | Semantics |
| --- | --- |
| `spawn_agent(task_name, message, fork_turns?, model?, reasoning_effort?)` | Create a Session and admit `message`. Returns **only** `{task_name}`, the canonical path — Codex hides spawn metadata by default. The result details also carry the child's Session id and stem (hidden from the model, like every `details` field), which is what lets the transcript open the row the path names. `fork_turns` defaults to `all` and accepts `all`, `none`, or a legacy positive turn count (read as `all`). `fork_context` is rejected by name; `model`/`reasoning_effort` are accepted under either fork mode. No `agent_type`: see the divergences below. |
| `send_message(target, message)` | Queue a `MESSAGE` fragment into the target's context. Never starts a turn. The model-facing body is empty, as Codex's is; the result's details carry the `submission_id` matching the recipient's agent-message entry. |
| `followup_task(target, message)` | Deliver a `NEW_TASK` fragment to a turn that starts if the target is idle and steers it otherwise, so the input lands as an agent message rather than as a user turn the human never wrote. Rejects the root; an idle target must find a free turn slot. Empty body plus the same `submission_id` in details. |
| `wait_agent(timeout_ms?)` | Wait for mailbox activity — a `MESSAGE`/`FINAL_ANSWER` fragment or a `followup_task` landing — or steered input. Returns `{message, timed_out}` — never content. Complete at 30 s, floor 10 s, ceiling 1 h; a below-floor request is clamped and the message says so, and a request above the ceiling is rejected (`timeout_ms must be at most 3600000`) rather than clamped. Both signals are monotonic counters snapshotted before their listeners are installed, so input admitted in that window still wakes the wait instead of blocking it to the deadline. |
| `interrupt_agent(target)` | Abort the current turn; the Session stays addressable. Returns `{previous_status}`. Rejects the root and the caller itself, as Codex does; an idle agent keeps its settled status. |
| `list_agents(path_prefix?)` | Live agents in the caller's root tree as `{agents: [{agent_name, agent_status}]}`. The tree root is listed first and the rest sort by path. The prefix is resolved against the caller, then matched on a segment boundary (`/root` matches everything). |

Tool names are flat: Codex renders its `collaboration` namespace as a
Responses-API namespace, which pi's tool registry cannot carry, and flat names
are the form Codex itself emits for providers without namespace support.

`agent_status` is Codex's tagged union, not a flat enum: one of `pending_init`,
`running`, `interrupted`, `shutdown`, `not_found`, or an object —
`{completed: string | null}` / `{errored: string}`. The completion payload is the
same text the spawner receives as its `FINAL_ANSWER` fragment, read from the
branch past the entry a `fork_turns=all` fork copied last: inherited parent text
is the parent's answer, never the child's. `list_agents`
reports the root through a runtime probe: a root that has not run a turn yet
reads `pending_init`, and after a settlement the probe reports the last execution
outcome, so an interrupted or errored root reads as such instead of a
synthesized completion. An unloaded agent has no status to report and is
omitted, as Codex omits agents it cannot load.

## The child learns who it is

The child's first input is the same envelope Codex sends, not the bare message:

```
Message Type: NEW_TASK
Task name: <the child's canonical path>
Sender: <the spawner's canonical path>
Payload:
<message>
```

That `Task name` is the only place a subagent learns its own path, which is what
makes its own relative references (a bare `task_3` means its own child) and the
paths it builds when it spawns meaningful, and it is what the `spawn_agent`
description promises.

## Every agent is briefed on the contract

The envelope names a path; it does not say what to do with it. Codex injects a
developer-role fragment per Session for that, and the bridge sends Codex's role
text as a `multi_agent.role_instructions` context fragment. The text is adapted,
not copied: Codex's `functions.exec` note and its `to=/root` addressing describe
tools the bridge does not have, so both are dropped, and its model-override
guidance loses the "do not accept overrides" clause because the Worker does apply
an override under a full-history fork.

- a child is briefed before its envelope — that its turn's text leaves to its
  parent without a tool call, how inter-agent messages are shaped, and that all
  agents share one working directory and filesystem;
- a full-history fork additionally carries Codex's inherited-history boundary:
  the copied branch is ancestor context, earlier identities, tasks, and
  approvals belong to the ancestors, and inherited tool calls are historical;
- a Session is briefed as root the first time it spawns, carrying Codex's
  default explicit-request-only delegation policy, the concurrency bound and the
  "prefer longer waits (minutes)" guidance that keeps a coordinator from polling;
- both carry Codex's model-override guidance: a full-history fork inherits the
  parent model and reasoning effort, and an override belongs with
  `fork_turns="none"`.

A Session receives its first brief once: a spawned Session is marked at
registration, so it never later receives the root brief when it spawns its own
children. The text is re-sent when a compaction ends, because the summary
replaces the history the fragment lived in; the Worker subscribes to the
runtime's compaction event for that. It is still not re-derived every turn as
Codex does, so the text is only as fresh as the last injection.

## Completion is pushed, not polled

A settlement pushes Codex's fragment into the **spawner's** context:

```
Message Type: FINAL_ANSWER
Task name: <spawner path>
Sender: <child path>
Payload:
<child's last assistant text>
```

Delivery is `Manager.sendContextMessage`: while the spawner's turn is running
the fragment is steered, so it lands before that turn's next model request — the
point Codex drains queue-only mail at, and the reason a coordinator that spawns,
does other work and does not poll still receives every result inside the turn it
spawned from. When the spawner is idle the fragment is appended and waits for
the next prompt, because queue-only mail never starts work. The same shape
carries inter-agent messages (`MESSAGE`) and follow-up tasks (`NEW_TASK`); a
follow-up goes through the sibling entry point `Manager.startWithContextMessage`,
which starts an idle recipient's turn instead of waiting for its next prompt,
so the input is one agent message either way.

An errored payload is truncated first — Codex's middle cut and marker, at 3,600
characters rather than its 900-token budget — so a failing child cannot flood its
parent's context.

Agent mail is transcript content: each fragment carries
`details = {bridge: "agent_message", kind, sender, recipient, submissionId}` and
`display: true`, so the recipient's transcript renders it as a folded "Agent
message" row (sender and envelope kind, the body on expand) rather than as a
user turn. The row joins the receiving turn's action list — it is accumulated
like a block — so the calls before and after it stay one turn and one group; it
is a turn of its own only when the Session has produced no assistant turn since
the human's last prompt. A `FINAL_ANSWER` is the exception: a spawn card owns its child, so
the answer folds into the `spawn_agent` card that created it — joined by the
child's canonical path (`recipient` plus the spawn's `task_name` equals
`sender`) — and the card's row counts the replies. The answer also carries the
settlement it reports as `outcome: "completed" | "errored"` (absent for an
interrupted turn, which sends no payload); the envelope text is unchanged and
the field only labels the row, so a failed child reads as a failure rather than
as an ordinary answer. Until the spawn's lazy
arguments have arrived there is no join key, so the answer keeps its own row in
the list: the fold never hides an entry the card cannot show. The collaboration brief
stays `display: false`: it is policy, not
mail. The same `submissionId` rides in the sending tool's result details, which
the model never sees — the model-facing body stays empty as Codex's is — so a
reader of the two Session files can pair acceptance with arrival: a `Stop` can
clear the steer queue, and the sender's call would otherwise claim a delivery the
recipient never received. Nothing renders that id: the browser carries no tool
details, so the pairing is file-level.

pi has no assistant-authored context item, so a fragment enters the model's
context as user content; the `Sender:` line carries the attribution Codex gets
from an `agent_message` item. Codex sends the same body with the assistant role,
in its analysis channel — the one difference the bridge cannot remove.

A settlement for a spawner whose runtime is gone is delivered by loading the
Session its address names, so a collected coordinator still receives the result
on its next prompt. Delivery stays best effort, as Codex's terminal-result
delivery is: a failed load or send is dropped, because a result is not a message
the model sent and its absence must not surface as a tool failure.

`wait_agent` exists only to yield the coordinator's turn early. It wakes when
mail lands in the caller's own mailbox — a `MESSAGE` or `FINAL_ANSWER` fragment,
or a `followup_task` through the sibling entry point, which Codex also counts as
mailbox activity — or when text is admitted into the caller's own turn
(`Manager.onInput`, notified from pi's admission preflight). It reports which
happened without content.

## A dormant child is loaded, not lost

The records are runtime state, so a Worker restart, idle collection, or
residency eviction leaves an address with no runtime behind it. A target that
resolves to such an address is loaded before the tool uses it: the Worker maps
the canonical path back to the file the tree was built from (`<spawner stem>/
<task name>`) and opens that Session through the registry the browser uses,
reusing an already-live registration when one exists. The loaded Session keeps
its transcript, title, and place; only the control record and its capability are
new. A record rebuilt from storage starts `pending_init` until its next turn
settles; an evicted record keeps the status it had and only regains a runtime.

Loading is per address, not a scan: `list_agents` still reports live agents and
the root, and a dormant child that is never addressed stays invisible even
though any tool can reach it by path. Reuse of a *task name* is a separate rule —
`spawn_agent` still refuses an address whose file exists, because that file is an
existing Session's transcript, so a caller that wants a new child picks a new
task name.

## Limits

- Concurrency: 4 **running turns** per tree, checked before a spawn and before a
  follow-up that starts an idle agent. Codex counts admitted turns the same way,
  so a settled agent frees its slot and no close tool is needed — which is why v2
  has none.
- Depth: none. Codex documents its depth limit as v1-only.
- Residency: 32 live runtimes per tree. Past that, settled runtimes are unloaded
  (capability released, record and status kept). A follow-up, message, or
  interrupt addressed to an unloaded child loads it back from its address, so
  eviction costs a reload rather than reachability.

These are process-local policy, not persisted state. A Worker restart ends the
records: children remain as ordinary Sessions at the addresses their parents
recorded, and one is loaded again when a tool addresses it. `list_agents` cannot
enumerate a tree whose records are gone. Control is runtime; the Session and its
address are durable.

## Known divergences from Codex

- **Fragment role.** Codex delivers inter-agent messages as assistant content and
  the role brief as developer content; pi has no assistant-authored or
  developer-authored context item, so both arrive as user content.
- **The first task arrives as a user turn.** A child's `NEW_TASK` envelope is
  admitted through pi's ordinary prompt path, so the child's own transcript shows
  it like a message the human typed. Later mail takes the agent-message path.
  Converting the first one would cost the spawn its admission receipt: a custom
  message reports no admission, and that receipt is what lets a refused spawn
  collect the record and drop the place it wrote.
- **Reload path.** Codex reloads an evicted child through its parent and holds
  its mail in the controller mailbox until then. The bridge loads the Session its
  address names when a tool addresses it — the parent's involvement stops at the
  path — so mail is queued after the load, and a child nothing addresses stays
  unloaded and unlisted.
- **Role text is re-injected per compaction, not per turn.** Codex re-inserts
  the policy every turn; the bridge injects it at spawn and again when a
  compaction ends, so a summary cannot erase it but a long turn runs on the text
  it started with.
- **A Stop can drop a queued fragment.** Steering is what lands a completion
  inside the running turn, and pi's abort clears the steer queue; Codex's mailbox
  survives an interrupt.
- **No role registry.** Codex omits `agent_type` unless roles are configured and
  loads each role's config layer from TOML. The bridge has no role registry, so
  the parameter is not offered and naming one fails with Codex's
  `agent type is currently not available` rather than being silently ignored.

## Non-goals

`wait_agent` does not return a transcript, and `list_agents` does not return
message history. `agent_type` is not accepted: see the divergences above.

# ADR 0016: Broken-Tail Turn Recovery

**Status:** Implemented.

## Context

A session turn can end in a state the conversation cannot continue from
without repair:

1. **Terminal error.** pi's built-in retry loop (provider-level retry, then
   `AgentSession`'s auto-retry with backoff) exhausts its budget. The failed
   assistant message — empty content, `stopReason: "error"` — is persisted and
   stays on the root→leaf path forever. The only continuation is a fresh user
   message; the dead error entry rides along in every future context.

2. **Interrupted tool execution.** The process dies — or the user stops the
   run — while a tool executes. Two shapes: tool calls left entirely without
   results (tool results persist per call as they finalize, so unstarted
   calls have nothing), or the in-flight tool terminated mid-run and
   persisted an error/abort result whose side effects are uncertain. The
   raw transcript is provider-invalid, but pi repairs it at request time
   (pi-ai `transform-messages` synthesizes "No result provided" error
   results for unanswered calls and drops error/aborted assistant messages
   from replay), so a later prompt over a dangling batch is served, not
   rejected. What the request-time repair cannot do is tell the model what
   the interrupted tools actually did — only a visible relay can carry the
   real partial results and the unknown-outcome warning.

3. **Stopped or unfinished run.** The run was stopped (user Stop or the
   bridge's own `dispose()` abort — indistinguishable on disk) or died after
   its tool results were all persisted cleanly but before the next assistant
   message flushed (assistant messages persist only at `message_end`, so a
   half-streamed completion leaves no trace). Both tails are *valid*
   continuation boundaries — nothing is half-done — and need only a silent
   re-request. The unfinished shape is indistinguishable on disk from a run a
   tool deliberately terminated (`shouldTerminateToolBatch`).

Both boundaries are visible on the wire (assistant `stopReason`, unanswered
`toolCall` ids, tool-result error states), but no pi surface recovers them:
pi's retry logic is a private stage of `prompt()`'s dynamic extent,
unreachable after idle, and its policy (retryable-errors-only, backoff,
keep-error-in-tree) is wrong for post-idle recovery anyway.

The constraint is the same as ADR 0015: **no pi-core changes** — held for
the design, with one later exception: a core bug the verb exposed (a stale
per-run abort flag instantly killing wrapper-less continuations) was fixed
in `AgentSession` itself; see Repairs. Everything else
must compose pi's public surface (`SessionManager.branch`,
`buildSessionContext`, `Agent.continue`, `AgentSession.prompt`).

## Decision

One attached session verb, `recoverTurn`, plus a host-published status field
that says whether and how the tail is broken.

### Derivation (pure, in `core/recovery.ts`)

`computeRecoverableTurn(document)` reads the leaf path's **tail run** — the
entries after the last run-starting entry (user message, context custom
message, branch summary, compaction):

- **`interruptedTools`** — terminated tool work: either tool calls in the
  run left without results (process death, or a mid-batch stop — pi's
  sequential abort leaves unstarted calls unanswered), or the run **ended at a
  terminated tool**: its last tool result an error, with a no-work
  error/abort marker after it. The abort kills the in-flight tool first,
  so its error result lands last; the marker's stopReason is not decisive
  — a live capture shows an abort surfacing as `"error"` with
  `"This operation was aborted"`, not `"aborted"`, depending on where
  the stream layer catches it — so the shape, not the label, is the
  signature. A marker that streamed text means the run had moved past the
  tool (an ordinary stop over a failed tool — Retry); a failed tool
  followed by successful ones is an ordinary tool error, not a
  termination. Dangling calls older than the tail run belong
  to a run the conversation moved past and are ignored — not because the
  transcript stays broken (pi's request-time transform answers unresolved
  calls with synthetic "No result provided" results, so later prompts are
  served), but because recovering there
  would discard the user's newer turns. Checked in that order: dangling
  wins over the killed-tool signature (a mid-batch stop that also left
  calls unanswered must drop the whole tool turn, not just the marker).
- **`failedTurn`** — the run's last assistant has `stopReason: "error"`
  (failed on its own) or `stopReason: "aborted"` with every tool result in
  the run completed cleanly (stopped — by the user's Stop, but also by the
  bridge's own `dispose()` abort on session close or teardown mid-run; the
  transcript cannot tell the two apart), *and* is still the tail modulo
  metadata (git stamps, labels, model switches are skipped; context-bearing
  work after the dead message disqualifies — the boundary is not ours to
  discard). Treating aborts as recoverable trades a false negative (a
  close-aborted run whose user message went permanently unanswered) for a
  meaning shift: after a deliberate Stop, re-requesting is
  regenerate-by-explicit-intent.
- **`unfinishedTurn`** — the run's last assistant carries tool calls, all of
  them are answered, and no subsequent assistant exists. No tail restriction:
  nothing is discarded, so trailing metadata or `!` commands are harmless.
- Otherwise `null`: normal stop, abort, a bare user tail (a prompt that died
  before its first flush — still deferred; that shape collides with the
  re-edit leaf state), or post-failure work.

The kind is stamped into `status.recoverableTurn` (wire-eager) at boot, at
every settle, at idle `tryReconcile`s, and on navigate — the same places
`contextUsage` flows, through the same `ReconcileOptions` pattern. The client
affordance and the server gate read the same value by construction; the verb
re-derives and refuses on mismatch.

### Repairs

The repairs follow the derivation's two families (both branch — the
`navigate` verb's exact machinery: public `SessionManager.branch` + the
re-seed of `agent.state.messages` from `buildSessionContext`, the
established "intentional coupling" — except `unfinishedTurn`, which needs
no branch):

- **`failedTurn` / `unfinishedTurn` → retry (silent).** `failedTurn`: branch
  past the dead assistant, then `session.agent.continue()` — pi's
  loop-reentry primitive, which re-prompts from the pre-failure boundary
  without a new message; the dead entry becomes an off-path side branch
  (visible in the history pane, invisible to future context).
  `unfinishedTurn`: bare continue — the tail is already continuable, and the
  recovered transcript is indistinguishable from an uninterrupted one. The
  deliberate-termination collision is accepted: an explicit retry on a
  tool-terminated run is legitimate intent, so the affordance is labeled by
  shape, not provenance.
- **`interruptedTools` → continue (a visible turn).** Branch past the dead
  turn — the dangling assistant, or the abort marker of a mid-run-terminated
  tool (the aborted tool result stays on the path) — then send a visible
  **`"Continue."`** user message through `session.prompt`. When branching
  before a dangling assistant, its completed tool results leave the active
  path too. The relay therefore carries bounded copies of those results and
  identifies calls with no persisted result, including their bounded
  arguments. Missing results have unknown outcomes, not proof that a tool
  did not run; the prompt tells the agent to inspect current state before
  repeating them. Tool arguments and outputs are marked as untrusted data.
  For the mid-run-abort shape, the error result remains in context and the
  plain `"Continue."` nudge is sufficient. Synthesizing `toolResult` entries
  (pi's own abort-path pattern) would preserve the original tool-call
  structure, but requires constructing pi-internal message shapes from
  outside pi; that remains the core-level fix.

The `"Continue."` prompt goes through `prompt`, so it keeps pi's full
post-run machinery
(retry, overflow recovery, steering). The `failedTurn` continuation calls
`Agent.continue()` directly, which runs **outside** `AgentSession`'s
`_runAgentPrompt` wrapper: no auto-retry/overflow protection for that run, no
`agent_settled` event, and `session.isStreaming` reads false while it runs
(a concurrent prompt from a second tab errors instead of steering — and pi's
own abort/dispose idle-wait cannot see the run). The Manager therefore
tracks the continuation's lifetime: `abort` and `dispose` await the tracked
run before treating the session as settled, so a Stop or a close during a
recovery flushes the terminated tail first. The Manager also compensates on
every exit path (success, error, abort) in a `finally`:
it resets `status.isStreaming` (the Document keys that reset on
`agent_settled`, which never fires here), runs the same settle reconcile +
settled notification the event path performs, and re-derives the recovery
kind — so a retried run that fails again re-arms the affordance instead of
wedging the session in streaming state. One hazard the wrapper-less run initially
had was **not** acceptable and was fixed in core: `AgentSession`'s per-run
abort flag ("abort requested") was reset only by the next `prompt()`-driven
`_startRun`, so after any user Stop the stale flag survived settle and the
`agent_start` handler instantly killed the continuation — every retry died
within milliseconds with "This operation was aborted" (caught from a
daemon frame log; regression-tested in `test/suite/recover-turn.test.ts`).
The flag is now consumed when the run settles (`_emitAgentSettled`) — the
one-line core change this ADR's no-core-changes constraint did not
anticipate. The remaining gap — no auto-retry/overflow protection for the
recovered run — stays an accepted limitation; the upstream fix is a core
`recoverInterruptedTurn()` this verb can delegate to.

### Wire and UI

`recoverTurn` is an attached session verb (no payload; the reply carries
`action: "retry" | "continue"`).

The client affordance is projected, not read off the wire: `computeViewModel`
derives the tail's recovery with the same pure `computeRecoverableTurn`
(idle-only, from the live leaf) and attaches it to the turn containing the
dead entry (`AssistantTurn.recovery`, with the run's user message as the Edit
target) — so placement needs no renderer heuristic and stays consistent with
what is rendered. `status.recoverableTurn` remains on the wire as the host's
idle-stamped statement. The verb re-derives and refuses on mismatch, so the
projected affordance and the server gate agree by construction either way.

The error row is the one failure presentation and the one recovery carrier:
the dead turn's real error/abort line, or a synthetic line in the same error
hue when pi persisted no error (the silent shapes — a half-dead run is never
visually quieter than a provider error). The buttons dock beside the line and
arm only under the send gates (idle, connected, live leaf, not editing); the
line itself renders whenever the tail is broken.

**Terminology.** The labels predict the mechanism before the click —
whether interrupted work is re-run, and whether a message appears in the
transcript:

- **Retry** — silently re-request from a clean boundary: no interrupted work
  is re-run or re-sent, nothing is added to the transcript. Offered with
  **Edit** (fork at the user message, resend — the composer's edit mode).
- **Send "Continue."** — the one action that adds a message: a visible
  `"Continue."` user turn, with a bounded recovery record of completed
  results and calls whose outcomes are unknown when the dangling tool-call
  entry is removed. Never offers Edit — forking away a half-done tool run to
  rephrase the prompt is rarely the intent behind "keep going".

The state line names what happened; the tooltip names what the button does.
Per failure mode:

| Failure mode | Error row line | Buttons | Tooltip (Retry) |
|---|---|---|---|
| Terminal error | provider error text (real) | Retry + Edit | "Request a new reply — nothing is added to the transcript; the failed attempt stays in history as a fork." |
| Stop, text-only | "Operation aborted" (real) | Retry + Edit | "Answer again from your message — the stopped attempt produced nothing." |
| Stop, tools completed | "Operation aborted" (real) | Retry + Edit | "Regenerate the reply from the completed tool results — no tools re-run." |
| Tool terminated mid-run | the marker's error text (real — e.g. "This operation was aborted"; the terminated tool result stays on the path) | Send "Continue." | — ("Sends 'Continue.' with the terminated tool's result") |
| Crash, tools dangling | "Interrupted while running tools — some calls have no recorded result" (synthetic) | Send "Continue." | — ("Sends 'Continue.' with completed results and calls whose outcomes are unknown") |
| Crash, unfinished reply | "Interrupted before the reply finished" (synthetic) | Retry + Edit | "Finish the reply from the completed tool results — nothing new is added" |

The web affordance lives inline on the dead turn (the compose card carries
none): the error row — real line, or synthetic for the silent shapes — with
the kind's action buttons beside it. The buttons are gated exactly like
send: idle, connected, and following the live leaf (the divergence mutation
lock); the line renders whenever the tail is broken. A repeated failed
retry accumulates sibling error branches under the branch point — the
history pane renders them as forks; that is the visibility cost of never
rewriting the file.

## Alternatives considered

- **Make pi's built-in retry re-triggerable.** Structurally unreachable after
  idle (private to `prompt()`'s extent, `_lastAssistantMessage` consumed) and
  wrong policy (retryable-only, backoff, keep-error-in-tree). Requires the
  core changes this ADR forbids.
- **Synthesize error `toolResult` entries from the bridge** (Option A). The
  correct long-term repair, but it means constructing `ToolResultMessage`
  shapes and dual-writing `sessionManager` + `agent.state` from outside pi.
  Deferred to a core verb.
- **Leaf-pointer move only.** Wrong tool for the interrupted case: the
  dangling boundary needs a relay of completed results and unknown outcomes,
  not just a pointer move.
- **Auto-recover on resume.** The user pressing the button is the
  disambiguation signal between a crashed run and one deliberately ended
  (abort, terminating tool) — the transcript alone cannot tell them apart
  when it ends on a fully-answered `toolResult`. `unfinishedTurn` accepts the
  collision and resolves it by intent (the button press); aborts are resolved
  the same way — an aborted tail derives `failedTurn`, so a deliberate Stop
  grows a Retry button rather than a close-aborted session going unrecovered.

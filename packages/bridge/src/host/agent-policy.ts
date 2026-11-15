// Agent policy — the role brief Codex gives each Session in a tree.
//
// Codex injects a developer-role fragment per Session: a root brief or a
// subagent brief, both naming the collaboration tools, the message envelope, the
// concurrency bound, the model-override guidance, and the delegation policy. The tools alone do not carry that:
// a model that only reads tool descriptions knows how to call `spawn_agent` but
// not whether it should, nor that its final answer reaches its parent.
//
// Bridge has no per-turn injection point, so these are one-shot context
// fragments: the child is briefed at spawn, before its `NEW_TASK` envelope, and a
// Session is briefed as root the first time it spawns. A Session that never
// spawns never carries a brief.

/** Codex's content kind for the same fragment. */
export const POLICY_CUSTOM_TYPE = "multi_agent.role_instructions";

const TOOLS_SENTENCE =
	"Use `followup_task` to give an existing agent a new task and start a turn, `send_message` to pass a message without starting a turn, `interrupt_agent` to stop an agent's current turn, and `list_agents` to see the agents in your tree.";

const SHARED_SENTENCE =
	"All agents in the team are equally capable and have the same tools, working directory, and filesystem, so an edit made by one is immediately visible to all.";

/** Codex's model-override guidance, with its "do not accept overrides" clause
 * dropped: the Worker does apply an override under a full-history fork, so the
 * text steers the choice instead of describing a rejection the bridge lacks. */
const MODEL_OVERRIDE_HINT =
	'Full-history forks (`fork_turns` omitted or `"all"`) inherit the parent model and reasoning effort. Only set `model` or `reasoning_effort` when explicitly requested by the user, applicable `AGENTS.md` instructions, or skill instructions; when doing so, set `fork_turns` to `"none"`.';

/** The incoming-envelope grammar. The kinds differ by role: a child's first
 * input is a `NEW_TASK`, which its own brief must name or its opening envelope
 * contradicts the grammar it was given. */
const envelopeGrammar = (types: string): string =>
	[
		"Messages from another agent arrive in the form:",
		"```",
		`Message Type: ${types}`,
		"Task name: <recipient>",
		"Sender: <author>",
		"Payload:",
		"<payload text>",
		"```",
	].join("\n");

/** Codex's inherited-history boundary: a full fork copies the parent's branch,
 * so the child is told which part of its context is history, not instructions.
 * Codex appends the same warning to the forked rollout, and without it the
 * child can read an ancestor's approvals as authorization of its own. */
const INHERITED_HISTORY = [
	"You are now a newly spawned child agent. The preceding conversation is inherited parent context. Follow your own role, identity, and task below; earlier identities, tasks, and action-specific approvals belong to your ancestors. Inherited tool calls are historical records, and live tool sessions and process handles are not inherited.",
	"",
].join("\n");

/** The brief for a Session that spawns: Codex's `/root` role base, its shared
 * usage hints, and its default explicit-request-only delegation policy. */
export function rootAgentPolicy(slots: number): string {
	return [
		"You are `/root`, the primary agent in a team of agents collaborating to fulfill the user's goals.",
		"",
		`You can spawn sub-agents with \`spawn_agent\`, and they can spawn their own. ${SHARED_SENTENCE}`,
		"",
		TOOLS_SENTENCE,
		"",
		envelopeGrammar("MESSAGE | FINAL_ANSWER"),
		"A sub-agent's final answer arrives this way when it finishes; fold it into your own answer.",
		"",
		`Up to ${slots} agents can be active at once, including you. When calling \`wait_agent\`, prefer longer waits (minutes) to avoid busy polling.`,
		"",
		MODEL_OVERRIDE_HINT,
		"",
		"Do not spawn sub-agents unless the user or applicable instructions explicitly ask for sub-agents, delegation, or parallel agent work.",
	].join("\n");
}

/** The brief for a spawned Session: Codex's subagent role base, the same hints,
 * and the one fact a child cannot infer — that its turn's text leaves to its
 * parent without a tool call. `inheritedHistory` adds Codex's boundary for a
 * full fork, where the parent's conversation is copied into the child. */
export function subAgentPolicy(slots: number, inheritedHistory = false): string {
	return [
		...(inheritedHistory ? [INHERITED_HISTORY] : []),
		"You are an agent in a team of agents collaborating to complete a task.",
		"",
		"The message that started this turn is a `NEW_TASK` envelope: `Task name` is your canonical task name and `Sender` is the agent that spawned you. Address another agent by canonical task name (`/root/...`); a bare name resolves relative to your own path.",
		"",
		`You can spawn sub-agents with \`spawn_agent\`, and they can spawn their own. ${SHARED_SENTENCE}`,
		"",
		TOOLS_SENTENCE,
		"",
		envelopeGrammar("NEW_TASK | MESSAGE | FINAL_ANSWER"),
		"",
		`Up to ${slots} agents can be active at once, including you. When calling \`wait_agent\`, prefer longer waits (minutes) to avoid busy polling.`,
		"",
		MODEL_OVERRIDE_HINT,
		"",
		"When your turn ends, your final answer is delivered to your parent agent automatically.",
	].join("\n");
}

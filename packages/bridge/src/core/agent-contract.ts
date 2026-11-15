// Agent collaboration contract — the names and payloads the host writes and the
// browser reads. Pure and browser-safe, like git-stamp.ts.
//
// A collaboration call is an ordinary tool-call block and a piece of agent mail
// is an ordinary `custom_message` entry, so the vocabulary that identifies them
// is stored Session content rather than an internal detail: the host writes
// these names, the projection classifies by them, and the renderer labels them.
// One definition keeps the three layers from drifting apart.

import type { JsonValue } from "./types.ts";

/** The collaboration tool names. Flat, because pi's tool registry has no
 * namespace to carry Codex's `collaboration.*` form; for providers without
 * namespaces Codex emits the same flat names. */
export const AGENT_TOOL_NAMES = [
	"spawn_agent",
	"send_message",
	"followup_task",
	"wait_agent",
	"interrupt_agent",
	"list_agents",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

const AGENT_TOOL_SET: ReadonlySet<string> = new Set(AGENT_TOOL_NAMES);

/** Whether a tool name belongs to the collaboration surface. Takes a plain
 * string: the caller has read a transcript, where the name is unvalidated. */
export function isAgentTool(name: string): boolean {
	return AGENT_TOOL_SET.has(name);
}

/** Reserved custom entry type for inter-agent mail. Namespaced like the git
 * stamp so a user extension cannot collide with it. */
export const AGENT_MESSAGE_CUSTOM_TYPE = "multi_agent.inter_agent_message";

/** Which envelope arrived from another agent. */
export type AgentMessageKind = "message" | "new_task" | "final_answer";

/** The settlement an answer reports. `interrupted` is absent: an interrupted
 * turn sends no answer at all. */
export type AgentSettlementOutcome = "completed" | "errored";

/** The `details` an agent-mail entry carries. The envelope text already holds
 * the payload, so these fields exist to label the transcript row and to pair a
 * delivery with the call that accepted it — never to carry content. */
export interface AgentMessageDetails {
	readonly bridge: "agent_message";
	readonly kind: AgentMessageKind;
	readonly sender: string;
	readonly recipient: string;
	readonly submissionId: string;
	readonly outcome?: AgentSettlementOutcome;
}

/** The provenance a reader needs from that payload. Absent fields are ones the
 * display can do without; `recipient` is optional because an entry written
 * before it was recorded still renders. */
export interface AgentMessageProvenance {
	readonly kind: AgentMessageKind;
	readonly sender: string;
	/** The envelope's recipient — the Session it was delivered to. Every mail
	 * entry in one Session names the same path, which is how a spawn card derives
	 * its child's canonical path without knowing the Session's own. */
	readonly recipient?: string;
	readonly outcome?: AgentSettlementOutcome;
}

/** Read an agent-mail payload. This is the trust boundary for both directions:
 * a Session file is content that outlives the code that wrote it, so the shape
 * is checked rather than assumed. */
export function parseAgentMessageDetails(details: JsonValue | null): AgentMessageProvenance | undefined {
	if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
	const candidate = details as Record<string, JsonValue>;
	if (candidate.bridge !== "agent_message") return undefined;
	const kind = candidate.kind;
	const sender = candidate.sender;
	const outcome = candidate.outcome;
	if (kind !== "message" && kind !== "new_task" && kind !== "final_answer") return undefined;
	if (typeof sender !== "string") return undefined;
	const recipient = candidate.recipient;
	return {
		kind,
		sender,
		...(typeof recipient === "string" ? { recipient } : {}),
		...(outcome === "completed" || outcome === "errored" ? { outcome } : {}),
	};
}

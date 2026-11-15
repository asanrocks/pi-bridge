// AgentToolCardBody — the details body for the Codex-style agent-control tools.
// The generic fallback printed the call's arguments and the tool's JSON result;
// here each call states what it did to whom, and a spawn card owns the answers
// its child sent, folded out of their own transcript rows.

import type { ReactNode } from "react";
import { memo } from "react";
import type { JsonValue } from "../../../../../src/core/types.ts";
import type { AgentReplyVM } from "../../../../../src/viewmodel/index.ts";
import { Markdown } from "../../../render/markdown.tsx";
import { AgentMessageCard } from "../AgentMessageCard.tsx";
import actionStyles from "../actions.module.css";
import turnsStyles from "../turns.module.css";
import type { ActionDetailsProps, AgentSpawnView } from "./args.ts";

/** The tool result is JSON text (`text()` in the host serializes its object).
 * It is file-adjacent content, so it is parsed as a trust boundary; a result
 * this body cannot read is rendered as its raw text rather than dropped. */
function parseResult(text: string | null): Record<string, JsonValue> | null {
	if (text === null) return null;
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, JsonValue>;
	} catch {
		return null;
	}
}

function stringField(value: JsonValue | undefined): string | null {
	return typeof value === "string" ? value : null;
}

/** A result whose JSON this body cannot read: shown verbatim, never hidden. */
function RawResult({ text }: { text: string }) {
	return <div className={actionStyles.agentFieldBody}>{text}</div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className={actionStyles.agentField}>
			<div className={actionStyles.agentFieldLabel}>{label}</div>
			<div className={actionStyles.agentFieldBody}>{children}</div>
		</div>
	);
}

/** A status is Codex's tagged union: a bare name, or a payload object. */
function statusLabel(status: JsonValue | undefined): string {
	if (typeof status === "string") return status;
	if (status !== null && typeof status === "object" && !Array.isArray(status)) {
		if ("completed" in status) return "completed";
		if ("errored" in status) return "errored";
	}
	return "unknown";
}

function AgentReplies({ replies }: { replies: readonly AgentReplyVM[] }) {
	return (
		<>
			{replies.map((reply) => (
				<AgentMessageCard
					key={reply.entryId}
					sender={reply.sender}
					label={reply.outcome === "errored" ? "Errored" : "Final answer"}
					text={reply.text}
				/>
			))}
		</>
	);
}

/** The spawn card's lifecycle line: the child's runtime while it is live, else
 * the settlement it last reported. `not loaded` is a dormant address the card
 * cannot see past; `idle` is a live child between turns. */
function spawnStatus(
	agentSpawn: AgentSpawnView | undefined,
	replies: readonly AgentReplyVM[] | undefined,
): string | null {
	if (agentSpawn === undefined) return null;
	if (agentSpawn.child?.activity !== undefined) return "running";
	const last = replies?.[replies.length - 1];
	if (last?.outcome === "errored") return "errored";
	if (last !== undefined) return "completed";
	return agentSpawn.child === null ? "not loaded" : "idle";
}

export const AgentToolCardBody = memo(function AgentToolCardBody({
	action,
	args,
	resultText,
	agentSpawn,
}: ActionDetailsProps) {
	const result = parseResult(resultText);
	const raw = result === null && resultText !== null && resultText.trim() !== "" ? resultText : null;
	const field = (name: string): JsonValue | undefined => {
		if (args === null) return undefined;
		const value = args[name];
		return value === undefined ? undefined : (value as JsonValue);
	};
	const model = stringField(field("model"));
	const effort = stringField(field("reasoning_effort"));
	const forkTurns = stringField(field("fork_turns"));
	const target = stringField(field("target"));
	const message = stringField(field("message"));

	switch (action.toolName) {
		case "spawn_agent": {
			const taskName = stringField(field("task_name"));
			const childPath = stringField(result?.task_name);
			const status = spawnStatus(agentSpawn, action.agentReplies);
			const meta = [
				forkTurns === null ? null : `fork: ${forkTurns}`,
				model === null ? null : `model: ${model}`,
				effort === null ? null : `effort: ${effort}`,
			].filter((part): part is string => part !== null);
			return (
				<div className={actionStyles.cardBody}>
					{taskName !== null && <Field label="Agent name">{taskName}</Field>}
					{message !== null && message !== "" && (
						<Field label="Task">
							<div className={turnsStyles.markdownContent}>
								<Markdown text={message} mode="static" />
							</div>
						</Field>
					)}
					{meta.length > 0 && <div className={actionStyles.agentMeta}>{meta.join(" · ")}</div>}
					{status !== null && agentSpawn !== undefined && (
						<div className={actionStyles.agentStatusLine}>
							<span className={actionStyles.agentStatus}>{status}</span>
							<button type="button" className={actionStyles.agentOpen} onClick={agentSpawn.open}>
								Open agent
							</button>
						</div>
					)}
					{childPath !== null && <Field label="Agent">{childPath}</Field>}
					{raw !== null && (
						<Field label="Result">
							<RawResult text={raw} />
						</Field>
					)}
					{action.agentReplies !== undefined && <AgentReplies replies={action.agentReplies} />}
				</div>
			);
		}
		case "send_message":
		case "followup_task":
			return (
				<div className={actionStyles.cardBody}>
					{target !== null && <Field label="To">{target}</Field>}
					{message !== null && message !== "" && (
						<Field label="Message">
							<div className={turnsStyles.markdownContent}>
								<Markdown text={message} mode="static" />
							</div>
						</Field>
					)}
				</div>
			);
		case "wait_agent": {
			const summary = stringField(result?.message);
			if (summary === null) {
				return raw === null ? null : (
					<div className={actionStyles.cardBody}>
						<RawResult text={raw} />
					</div>
				);
			}
			return (
				<div className={actionStyles.cardBody}>
					<div className={actionStyles.agentFieldBody}>{summary}</div>
				</div>
			);
		}
		case "interrupt_agent": {
			const previous = result?.previous_status;
			if (previous === undefined) {
				return raw === null ? null : (
					<div className={actionStyles.cardBody}>
						<RawResult text={raw} />
					</div>
				);
			}
			return (
				<div className={actionStyles.cardBody}>
					<Field label="Previous status">{statusLabel(previous)}</Field>
				</div>
			);
		}
		case "list_agents": {
			const agents = result?.agents;
			if (!Array.isArray(agents)) {
				return raw === null ? null : (
					<div className={actionStyles.cardBody}>
						<RawResult text={raw} />
					</div>
				);
			}
			return (
				<div className={actionStyles.cardBody}>
					<div className={actionStyles.agentList}>
						{agents.map((agent, index) => {
							if (agent === null || typeof agent !== "object" || Array.isArray(agent)) return null;
							const name = stringField(agent.agent_name);
							if (name === null) return null;
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: a status listing has no stable id per row
								<div key={index} className={actionStyles.agentListRow}>
									<span className={actionStyles.agentListName}>{name}</span>
									<span className={actionStyles.agentListStatus}>{statusLabel(agent.agent_status)}</span>
								</div>
							);
						})}
					</div>
				</div>
			);
		}
		default:
			return null;
	}
});

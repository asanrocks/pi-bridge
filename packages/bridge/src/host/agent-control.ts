// Agent control — the Codex MultiAgentV2 tool surface over bridge Sessions.
//
// One physical Session is the unit of work; these tools are one presentation of
// it. Everything durable (the JSONL file, the address, the Document) stays the
// Session's, so a controlled agent is still a normal Session a user can open and
// steer. This module owns only the live tree, the activity signals a wait
// watches, and the command semantics; creating, registering, and collecting
// runtimes stays in the Worker.
//
// The contract is Codex's v2 one rather than an approximation of it, because
// the model's behaviour is part of the contract:
//
//   - `AgentStatus` is the tagged union the model reads, not a flat enum.
//   - `wait_agent` returns a content-free summary and yields on steered input or
//     on mail landing in the caller's mailbox, a follow-up included.
//   - A child's final answer arrives as a queue-only context fragment pushed on
//     settlement and delivered before the spawner's next request, so a
//     coordinator that follows the tool guidance — spawn, then do other work, do
//     not poll — still receives it inside the turn it spawned it from.
//   - Every Session is briefed on the collaboration contract: a child before its
//     first input, a spawner on its first spawn. Tool descriptions do not tell a
//     model that its final answer leaves to its parent, or that it should not
//     poll, and those are the two things that shape its behaviour.
//   - Capacity is claimed, not counted: a spawn or an idle follow-up reserves its
//     turn before the first await, so two concurrent callers cannot both pass a
//     check that predates either child.
//   - Liveness comes from the runtime and the terminal state from the settlement
//     event. Tool handlers never write a status, so a tool can neither invent nor
//     overwrite a turn's result.
//   - `spawn_agent` returns only the canonical task path. Codex hides spawn
//     metadata by default and addresses agents by task path.
//   - The tree has no depth cap: Codex documents its depth limit as v1-only and
//     bounds concurrency by admitted turns instead.
//   - A spawned agent's first input is Codex's `NEW_TASK` envelope, which is how
//     a child learns its own canonical path (the Worker sends it).
//   - Task names and references are validated with Codex's own messages, and an
//     address resolves only by id or by path: no bare-name search exists, so an
//     ambiguous reference fails instead of reaching the wrong agent.
//   - `list_agents` includes the tree root and resolves its prefix against the
//     caller, as Codex does.
//
// Tool names stay flat. Codex renders its `collaboration` namespace as a
// Responses-API namespace, which pi's tool registry cannot carry; flat names are
// the form Codex itself emits for providers without namespace support.
//
// `send_message` and `followup_task` are v2's split: the first queues a fragment
// without starting an idle agent, the second starts or steers a turn. A target
// resolves by thread id or by canonical path — absolute or relative to the
// caller — inside the caller's root tree only. As in Codex, `agent_type` is not
// offered: it names a config layer from a role registry the bridge does not have,
// so Codex hides the parameter when no roles are configured.

import { randomUUID } from "node:crypto";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	AGENT_MESSAGE_CUSTOM_TYPE,
	type AgentMessageDetails,
	type AgentMessageKind,
	type SessionOutcome,
	type SessionRef,
} from "../core/index.ts";
import { POLICY_CUSTOM_TYPE, rootAgentPolicy } from "./agent-policy.ts";

/** Codex's `AgentStatus` as the model reads it: five bare states plus two
 * payload-carrying states. Compared by shape, never as a plain string. */
export type AgentStatus =
	| "pending_init"
	| "running"
	| "interrupted"
	| "shutdown"
	| "not_found"
	| { readonly completed: string | null }
	| { readonly errored: string };

/** Codex v2's fork choice: `all` inherits the parent transcript, `none` starts
 * fresh. The Worker implements `all` as a real session branch. */
export type ForkTurns = "all" | "none";

export interface SpawnAgentRequest {
	readonly taskName: string;
	readonly message: string;
	readonly model?: string;
	readonly reasoningEffort?: string;
	readonly forkTurns: ForkTurns;
}

/** The tree position a spawn inherits. The root is `/root` at depth 0; a child's
 * path is the slash-joined task names below it, so a child of `/root/task1`
 * spawned as `task_3` is canonically `/root/task1/task_3`. */
export interface AgentSpawnContext {
	readonly parent: SessionRef;
	readonly parentId: string;
	readonly rootId: string;
	readonly depth: number;
	/** The spawner's canonical path, which the child reads as its sender. */
	readonly parentPath: string;
	readonly path: string;
	/** Ancestor ids from the first spawned agent down to the parent, so a child
	 * can message any of them and not a Session outside its tree. */
	readonly ancestry: readonly string[];
}

/** What the control plane knows about a target that has no live runtime. A
 * dormant agent is addressed by its canonical path; the Worker turns that back
 * into the file the tree was built from and loads the Session there, so a
 * resume never depends on the caller's process having kept a record. */
export interface AgentResumeContext {
	readonly caller: SessionRef;
	/** The caller's canonical path: its descendants are stored under the caller's
	 * stem with this path's remainder appended, so the Worker owns the mapping. */
	readonly callerPath: string;
	readonly rootId: string;
	readonly path: string;
	readonly parentPath: string;
	readonly depth: number;
	/** The spawner's live id when it has one, else the spawner's canonical path:
	 * the only address a settlement push has for a dormant spawner, which fails
	 * best effort as Codex's does. */
	readonly parentId: string;
	readonly ancestry: readonly string[];
}

/** One controlled Session, implemented by the Worker. The control plane reads
 * status and liveness through this and never touches the runtime. */ export interface ControlledAgent {
	readonly id: string;
	readonly ref: SessionRef;
	/** Canonical task path, `/root/...`. */
	readonly path: string;
	readonly parentId: string;
	readonly rootId: string;
	readonly depth: number;
	readonly ancestry: readonly string[];
	readonly model?: string;
	/** Whether the runtime is executing (streaming, thinking, or running a tool).
	 * The control plane's liveness signal: a settled turn is the settlement event's
	 * to report, never a flag this layer keeps on its own. */
	isBusy(): boolean;
	/** Start a turn if idle, or steer the running one. */
	prompt(text: string): Promise<void>;
	/** Start a turn whose input is an agent message, or steer the running one —
	 * Codex's `TriggerTurn` delivery. Unlike `prompt`, the input lands as a visible
	 * agent message rather than a user turn: the human never wrote it. */
	startTask(content: string, details: AgentMessageDetails): Promise<void>;
	/** Abort the current turn, keeping the Session. */
	interrupt(): Promise<void>;
	/** Release the control capability and collect the runtime; the file stays. */
	close(): Promise<void>;
	/** The last assistant text in the child's transcript, read from its file. */
	lastMessage(): Promise<string | undefined>;
	/** One execution-boundary settlement subscription. */
	onSettled(listener: (outcome: SessionOutcome) => void): () => void;
}

/** One queue-only context fragment. A tagged pair rather than a flag: agent
 * mail is part of the human's record and carries structured provenance, and the
 * collaboration brief is policy the model reads but the transcript does not
 * show. */
export type AgentFragment =
	| {
			readonly kind: "agent_message";
			readonly customType: string;
			readonly content: string;
			readonly details: AgentMessageDetails;
	  }
	| { readonly kind: "policy"; readonly customType: string; readonly content: string };

export interface AgentControlDeps {
	/** Create and register the Session, then admit its first message. The Worker
	 * owns every failure path and must not leave an orphan runtime. */
	spawn(context: AgentSpawnContext, request: SpawnAgentRequest): Promise<ControlledAgent>;
	/** Load a spawned Session from its durable address when no runtime is live.
	 * Returns `undefined` when the address names no file. A Worker restart, idle
	 * collection, or residency eviction all end the runtime, never the identity. */
	resume(context: AgentResumeContext): Promise<ControlledAgent | undefined>;
	/** The durable address a canonical path names, read from a Session in the same
	 * tree. The Worker owns the path/stem mapping — a child's file is the spawner's
	 * stem plus the path below `/root` — so the control plane asks for an address
	 * instead of deriving storage layout from a canonical path. */
	addressOf(session: SessionRef, sessionPath: string, path: string): AgentAddress;
	/** Queue a fragment into a Session for its next model request without
	 * starting a turn — Codex's mailbox drain, expressed through pi's
	 * `sendCustomMessage`. Rejects when no live Session has that id. The address
	 * lets the Worker load a recipient whose runtime is gone instead of dropping
	 * a result; absent when the caller already resolved a live agent. */
	deliver(agentId: string, fragment: AgentFragment, address?: AgentAddress): Promise<void>;
	/** Observe text admitted into a Session's turn. A blocked `wait_agent` yields
	 * on it, as Codex's wait yields to steered input. */
	watchInput(agentId: string, listener: () => void): () => void;
	/** Monotonic count of text admitted into a Session's turns. A wait snapshots
	 * it before installing its listener, so input admitted in that window is still
	 * observed; the listener alone cannot see the past. */
	inputSequence(agentId: string): number;
	/** Read the status of a Session the control does not own — the tree root,
	 * which has no capability — for `list_agents`. `undefined` when no live
	 * runtime has that id, as Codex omits agents it cannot report on. */
	probe(agentId: string): Promise<AgentStatus | undefined>;
}

export interface AgentControlService {
	/** Tools bound to the Session that is calling them. */
	toolsFor(parent: () => SessionRef): ToolDefinition[];
}

/** A Session's durable place, for a command that must not depend on a runtime
 * being live: the file the stem names is the identity. */
export interface AgentAddress {
	readonly projectId: string;
	readonly stem: string;
}

/** The custom type a delivered agent message carries in the recipient's Session
 * file. The envelope kind travels in `details`, so one type covers `MESSAGE`,
 * `NEW_TASK`, and `FINAL_ANSWER` and the transcript classifies by data rather
 * than by parsing the body. */
const FRAGMENT_KIND: Record<"MESSAGE" | "NEW_TASK" | "FINAL_ANSWER", AgentMessageKind> = {
	MESSAGE: "message",
	NEW_TASK: "new_task",
	FINAL_ANSWER: "final_answer",
} as const;

/** Codex's `max_concurrent_threads_per_session`: admitted turns, not live
 * agents. A settled agent holds no slot, which is why v2 needs no close tool. */
export const MAX_CONCURRENT_TURNS = 4;
/** Codex truncates an errored child's payload at ~900 tokens before forwarding
 * it, so a failing agent cannot flood its parent's context. Bridge has no
 * tokenizer; four characters per token is the bound the rest of this module
 * assumes. */
const ERROR_MAX_CHARS = 3_600;
/** Residency high-water. Codex unloads idle children and reloads them on demand;
 * the Worker can only unload, so an evicted target reports `closed` where Codex
 * would reload it. Kept well above any working fan-out so it stays a bound. */
const MAX_RESIDENT_AGENTS = 32;
const MIN_WAIT_MS = 10_000;
const MAX_WAIT_MS = 3_600_000;
const DEFAULT_WAIT_MS = 30_000;
export const ROOT_PATH = "/root";

/** The word before the colon names the tool family that hit the limit; Codex
 * reports the same two prefixes. */
type CapacityPrefix = "collab spawn failed" | "collab tool failed";

/** Codex's `InterAgentCommunication` body as the recipient's model reads it. */
export function interAgentBody(
	type: "MESSAGE" | "NEW_TASK" | "FINAL_ANSWER",
	recipient: string,
	sender: string,
	payload: string,
): string {
	return `Message Type: ${type}\nTask name: ${recipient}\nSender: ${sender}\nPayload:\n${payload}`;
}

/** One outgoing agent message: the recipient's rendered body and the provenance
 * its transcript and the sender's tool result both carry. */
function envelope(
	type: "MESSAGE" | "NEW_TASK" | "FINAL_ANSWER",
	recipient: string,
	sender: string,
	payload: string,
	outcome?: "completed" | "errored",
): { content: string; details: AgentMessageDetails } {
	return {
		content: interAgentBody(type, recipient, sender, payload),
		details: {
			bridge: "agent_message",
			kind: FRAGMENT_KIND[type],
			sender,
			recipient,
			submissionId: randomUUID(),
			...(outcome === undefined ? {} : { outcome }),
		},
	};
}

/** Codex's status names the payload of a settled turn; the payload is the only
 * part of a status the model can branch on. Exported because the Worker reports
 * the root's status from the same rule. */
export const settledStatus = (outcome: SessionOutcome, message: string | undefined): AgentStatus => {
	if (outcome === "aborted") return "interrupted";
	return outcome === "completed" ? { completed: message ?? null } : { errored: message ?? "Agent errored" };
};

/** Codex's middle cut with its marker, so a long failure keeps both ends. */
function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const keep = maxChars - 1;
	const head = Math.ceil(keep / 2);
	const tail = keep - head;
	return `${text.slice(0, head)}…${text.length - keep} chars truncated…${text.slice(text.length - tail)}`;
}

/** The payload half of a `FINAL_ANSWER`, as Codex words it. Interrupted is
 * absent: an interrupted turn is not a result. */
function statusPayload(status: AgentStatus): string | undefined {
	if (typeof status === "string") return status === "shutdown" ? "Agent shut down." : undefined;
	return "completed" in status
		? (status.completed ?? "")
		: `Agent errored: ${truncateMiddle(status.errored, ERROR_MAX_CHARS)}\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.`;
}

/** The terminal state one turn reported. Written only by the settlement handler;
 * the payload arrives after a file read and upgrades the state it cannot change. */
interface AgentSettlement {
	readonly outcome: SessionOutcome;
	message?: string;
}

interface AgentRecord {
	readonly id: string;
	readonly rootId: string;
	readonly parentId: string;
	readonly path: string;
	readonly depth: number;
	readonly ancestry: readonly string[];
	/** Absent once the runtime was unloaded; the record and its settlement survive. */
	agent: ControlledAgent | undefined;
	/** A turn admitted but not yet reporting liveness: the spawn itself, or a
	 * follow-up accepted a moment ago. Counts as running, so an admitted turn can
	 * never be missed by capacity, and pi's phase cannot lag the admission. */
	pendingTurn: boolean;
	settled?: AgentSettlement;
}

export function createAgentControl(deps: AgentControlDeps): AgentControlService {
	const records = new Map<string, AgentRecord>();
	/** Per-caller activity counter: bumped when mail lands or input is steered,
	 * so a wait can compare a snapshot instead of subscribing to a queue. */
	const activity = new Map<string, number>();
	const waiters = new Set<() => void>();

	/** Turns claimed but not yet admitted, per tree. A claim is taken synchronously,
	 * before the spawn's first await, so the limit binds the first caller too. */
	const admitting = new Map<string, number>();
	/** One load per dormant path, so concurrent callers share a registration. */
	const resuming = new Map<string, Promise<AgentRecord | undefined>>();

	const rootIdOf = (ref: SessionRef): string => records.get(ref.sessionId)?.rootId ?? ref.sessionId;
	const pathOf = (ref: SessionRef): string => records.get(ref.sessionId)?.path ?? ROOT_PATH;
	const isRunning = (record: AgentRecord): boolean => record.pendingTurn || record.agent?.isBusy() === true;

	/** Liveness from the runtime, terminal state from the settlement event. A record
	 * with neither has been admitted and not yet run — Codex's `pending_init`. */
	const statusOf = (record: AgentRecord): AgentStatus =>
		isRunning(record)
			? "running"
			: record.settled === undefined
				? "pending_init"
				: settledStatus(record.settled.outcome, record.settled.message);

	const signal = (agentId: string): void => {
		activity.set(agentId, (activity.get(agentId) ?? 0) + 1);
		for (const notify of [...waiters]) notify();
	};

	/** Queue one agent message into the recipient and return its submission id:
	 * the sender's tool result carries it, so a visible recipient transcript can
	 * be paired with the call that produced it. */
	const deliver = async (
		agentId: string,
		recipientPath: string,
		senderPath: string,
		type: "MESSAGE" | "NEW_TASK" | "FINAL_ANSWER",
		payload: string,
		address?: AgentAddress,
		outcome?: "completed" | "errored",
	): Promise<string> => {
		const message = envelope(type, recipientPath, senderPath, payload, outcome);
		await deps.deliver(
			agentId,
			{
				kind: "agent_message",
				customType: AGENT_MESSAGE_CUSTOM_TYPE,
				...message,
			},
			address,
		);
		signal(agentId);
		return message.details.submissionId;
	};

	/** Sessions already briefed on the collaboration contract. A spawned Session is
	 * marked by `register`, because the Worker briefs it as a subagent at spawn: it
	 * must not later receive the root brief when it spawns its own children. */
	const briefed = new Set<string>();

	/** Codex briefs the spawner with the root policy. Best effort, and deliberately
	 * not signalled: a policy the caller cannot receive must not fail its spawn, and
	 * a policy is not activity a `wait_agent` should wake for. */
	const briefSpawner = (agentId: string): void => {
		if (briefed.has(agentId)) return;
		briefed.add(agentId);
		void deps
			.deliver(agentId, {
				kind: "policy",
				customType: POLICY_CUSTOM_TYPE,
				content: rootAgentPolicy(MAX_CONCURRENT_TURNS),
			})
			.catch(() => {});
	};

	/** Codex's capacity rule — admitted turns, not live agents — plus the claims in
	 * flight. Throws before claiming, so a refused caller reserves nothing. */
	const claimCapacity = (rootId: string, prefix: CapacityPrefix): (() => void) => {
		const running = [...records.values()].filter((record) => record.rootId === rootId && isRunning(record));
		const claimed = admitting.get(rootId) ?? 0;
		if (running.length + claimed >= MAX_CONCURRENT_TURNS) {
			throw new Error(`${prefix}: agent thread limit reached`);
		}
		admitting.set(rootId, claimed + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const remaining = (admitting.get(rootId) ?? 1) - 1;
			if (remaining <= 0) admitting.delete(rootId);
			else admitting.set(rootId, remaining);
		};
	};

	/** Resolve a target to a spawned agent or to the tree root, which has neither
	 * a record nor a capability: it is the Session doing the calling. A record
	 * without a runtime is loaded from its address first, so the caller's process
	 * having forgotten the tree never makes a known agent unreachable. */
	const resolveTarget = async (caller: SessionRef, target: string): Promise<ResolvedTarget> => {
		const rootId = rootIdOf(caller);
		if (target === rootId) return { kind: "root", id: rootId };
		const live = [...records.values()].filter((record) => record.rootId === rootId);
		const byId = live.find((record) => record.id === target);
		if (byId !== undefined) return { kind: "agent", record: await ensureLive(caller, byId) };
		// Codex parses a thread id before a path. Bridge ids are UUIDs, which no
		// agent name may contain, so a hyphen identifies the id form.
		if (!isPathReference(target)) throw new Error(`agent with id ${target} not found`);
		const path = resolveAgentPath(pathOf(caller), target);
		if (path === ROOT_PATH) return { kind: "root", id: rootId };
		const byPath = live.find((record) => record.path === path);
		if (byPath !== undefined) return { kind: "agent", record: await ensureLive(caller, byPath) };
		// No record at all: a Worker restart ends the tree, but the address is
		// durable, so the Session the path names is loaded on demand.
		const resumed = await resumeAt(caller, path);
		if (resumed === undefined) throw new Error(`live agent path \`${path}\` not found`);
		return { kind: "agent", record: resumed };
	};

	/** Load the Session at one canonical path and register it as a controlled
	 * agent. One load per path is in flight: two callers addressing the same
	 * dormant child share the registration instead of binding it twice. */
	const resumeAt = (caller: SessionRef, path: string, existing?: AgentRecord): Promise<AgentRecord | undefined> => {
		const rootId = rootIdOf(caller);
		const key = `${rootId}\0${path}`;
		const inflight = resuming.get(key);
		if (inflight !== undefined) return inflight;
		const depth = path.split("/").length - 2;
		const parentPath = path.slice(0, path.lastIndexOf("/")) || ROOT_PATH;
		const known = [...records.values()].filter((record) => record.rootId === rootId);
		const spawner = known.find((record) => record.path === parentPath);
		const ancestry = known
			.filter((record) => record.depth < depth && path.startsWith(`${record.path}/`))
			.sort((left, right) => left.depth - right.depth)
			.map((record) => record.id);
		const pending = deps
			.resume({
				caller,
				callerPath: pathOf(caller),
				rootId,
				path,
				parentPath,
				depth,
				parentId: spawner?.id ?? (parentPath === ROOT_PATH ? rootId : parentPath),
				ancestry,
			})
			.then((agent) => {
				if (agent === undefined) return undefined;
				return existing === undefined ? register(agent, false) : attachAgent(agent, existing);
			});
		resuming.set(key, pending);
		return pending.finally(() => resuming.delete(key));
	};

	/** A record whose runtime was unloaded is reloaded before a tool uses it. */
	const ensureLive = async (caller: SessionRef, record: AgentRecord): Promise<AgentRecord> => {
		if (record.agent !== undefined) return record;
		const resumed = await resumeAt(caller, record.path, record);
		if (resumed === undefined) throw new Error(`agent with id ${record.id} is closed`);
		return resumed;
	};

	/** The settlement observer one runtime gets. Its terminal state is written only
	 * here, never by a tool handler. */
	const watch = (record: AgentRecord): void => {
		const agent = record.agent;
		if (agent === undefined) return;
		agent.onSettled((outcome) => {
			// The runtime is still registered when the event arrives; a record that
			// was already replaced belongs to a dead registration.
			if (records.get(agent.id) !== record) return;
			// Record the terminal state before the file read: status must not lag the
			// settlement, and a later payload only fills in what the state already is.
			record.pendingTurn = false;
			const settlement: AgentSettlement = { outcome };
			record.settled = settlement;
			void agent.lastMessage().then((message) => {
				// A later turn's settlement replaced this one; its read owns the record.
				if (records.get(agent.id) !== record || record.settled !== settlement) return;
				record.settled = { outcome, ...(message === undefined ? {} : { message }) };
				const parent = record.path.slice(0, record.path.lastIndexOf("/")) || ROOT_PATH;
				const status = statusOf(record);
				const payload = statusPayload(status);
				// The transcript labels the row from this; the payload already rides in
				// the envelope text, which is all the model reads.
				const label = typeof status === "object" ? ("completed" in status ? "completed" : "errored") : undefined;
				if (payload !== undefined) {
					// Best effort, as Codex's terminal-result delivery is: the spawner may
					// have been collected first, and a settlement is not a message the
					// model sent, so its absence must not surface as a tool failure. The
					// address lets the Worker load the spawner instead of dropping the
					// result when its runtime is gone.
					void deliver(
						record.parentId,
						parent,
						record.path,
						"FINAL_ANSWER",
						payload,
						deps.addressOf(agent.ref, record.path, parent),
						label,
					).catch(() => {});
				}
				evictOverflow(record.rootId);
			});
		});
	};

	const register = (agent: ControlledAgent, admitted: boolean): AgentRecord => {
		const record: AgentRecord = {
			id: agent.id,
			rootId: agent.rootId,
			parentId: agent.parentId,
			path: agent.path,
			depth: agent.depth,
			ancestry: agent.ancestry,
			agent,
			// A spawn's first turn was admitted before `spawn` returned; a resumed
			// agent starts idle, so its status is `pending_init` until it runs.
			pendingTurn: admitted,
		};
		records.set(agent.id, record);
		// The Worker briefed this Session as a subagent before its first input.
		briefed.add(agent.id);
		watch(record);
		return record;
	};

	/** Reuse a record whose runtime was unloaded: the identity, path, and last
	 * settlement stay, and only the runtime handle is replaced. */
	const attachAgent = (agent: ControlledAgent, record: AgentRecord): AgentRecord => {
		record.agent = agent;
		briefed.add(agent.id);
		watch(record);
		return record;
	};

	/** Unload settled runtimes past the residency high-water. The record keeps the
	 * settlement so the tree still reads correctly; only the runtime is released. */
	const evictOverflow = (rootId: string): void => {
		const resident = [...records.values()].filter((record) => record.rootId === rootId && record.agent !== undefined);
		if (resident.length <= MAX_RESIDENT_AGENTS) return;
		const idle = resident.filter((record) => !isRunning(record)).slice(0, resident.length - MAX_RESIDENT_AGENTS);
		for (const record of idle) {
			const agent = record.agent;
			if (agent === undefined) continue;
			record.agent = undefined;
			void agent.close();
		}
	};

	/** The child's tree position, with its turn claimed before the spawn can await.
	 * The caller must release the claim however the spawn ends. */
	const contextFor = (parent: SessionRef, taskName: string): { context: AgentSpawnContext; release: () => void } => {
		const record = records.get(parent.sessionId);
		const rootId = record?.rootId ?? parent.sessionId;
		const basePath = record?.path ?? ROOT_PATH;
		// Codex validates the name when it joins the path, before capacity.
		validateAgentName(taskName);
		const release = claimCapacity(rootId, "collab spawn failed");
		return {
			context: {
				parent,
				parentId: parent.sessionId,
				rootId,
				depth: record === undefined ? 1 : record.depth + 1,
				parentPath: basePath,
				path: `${basePath}/${taskName}`,
				ancestry: record === undefined ? [] : [...record.ancestry, record.id],
			},
			release,
		};
	};

	const text = (value: unknown): AgentToolResult<unknown> => ({
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
		details: value,
	});

	/** A spawn's model-facing body is only the canonical path, as Codex hides the
	 * rest. The details add the child's Session id and stem — hidden from the
	 * model like every `details` field, and what lets the transcript open the
	 * row it names. */
	const spawnResult = (agent: ControlledAgent): AgentToolResult<unknown> => ({
		content: [{ type: "text", text: JSON.stringify({ task_name: agent.path }, null, 2) }],
		details: { task_name: agent.path, session_id: agent.id, stem: agent.ref.stem },
	});

	/** Codex's message tools return an empty body, not `{}`. The submission id
	 * rides in the result's details, which the model never sees: acceptance is not
	 * arrival, and the recipient's transcript is where arrival shows. */
	const empty = (submissionId: string): AgentToolResult<unknown> => ({
		content: [],
		details: { submission_id: submissionId },
	});

	/** A wait compares two monotonic snapshots so a signal landing between
	 * subscription and block still yields immediately: mail is counted here, input
	 * by the Worker. The listener alone cannot see what already happened. */
	const waitFor = (caller: SessionRef, timeoutMs: number): Promise<"mailbox" | "steered" | "timed_out"> => {
		const seenMail = activity.get(caller.sessionId) ?? 0;
		const seenInput = deps.inputSequence(caller.sessionId);
		return new Promise((settle) => {
			let done = false;
			let stopWatching = (): void => {};
			const finish = (reason: "mailbox" | "steered" | "timed_out"): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				waiters.delete(check);
				stopWatching();
				settle(reason);
			};
			const check = (): void => {
				if ((activity.get(caller.sessionId) ?? 0) !== seenMail) finish("mailbox");
				else if (deps.inputSequence(caller.sessionId) !== seenInput) finish("steered");
			};
			const timer = setTimeout(() => finish("timed_out"), timeoutMs);
			// A pending tool wait must not keep a shutting-down Worker alive.
			timer.unref();
			waiters.add(check);
			stopWatching = deps.watchInput(caller.sessionId, () => finish("steered"));
			check();
		});
	};

	const toolsFor = (parent: () => SessionRef): ToolDefinition[] => [
		defineTool({
			name: "spawn_agent",
			label: "Spawn agent",
			description:
				'Spawns an agent to work on the specified task. If your current task is `/root/task1` and you spawn_agent with task_name "task_3" the agent will have canonical task name `/root/task1/task_3`.\n' +
				"You are then able to refer to this agent as `task_3` or `/root/task1/task_3` interchangeably. However an agent `/root/task2/task_3` would only be able to communicate with this agent via its canonical name `/root/task1/task_3`.\n" +
				"The spawned agent will have the same tools as you and the ability to spawn its own subagents.\n" +
				"It will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes.\n" +
				"The new agent's canonical task name will be provided to it along with the message.\n\n" +
				'Note that passing `fork_turns="none"` will not pass any surrounding context to the spawned subagent, which may cause the agent to lack the context it needs to complete its task, whereas `fork_turns="all"` will provide the subagent with all surrounding context.',
			parameters: Type.Object({
				task_name: Type.String({
					description: "Task name for the new agent. Use lowercase letters, digits, and underscores.",
				}),
				message: Type.String({ description: "Initial plain-text task for the new agent." }),
				fork_turns: Type.Optional(
					Type.String({
						description:
							"Parent history to inherit. Defaults to `all`; use `none` to start without parent history. Only `all` and `none` are supported.",
					}),
				),
				model: Type.Optional(
					Type.String({
						description: "Model override for the new agent. Omit unless an explicit override is needed.",
					}),
				),
				reasoning_effort: Type.Optional(
					Type.String({
						description: "Reasoning effort override for the new agent. Omit to inherit the parent effort.",
					}),
				),
			}),
			async execute(_toolCallId, params) {
				const raw = params as Record<string, unknown>;
				// Codex v2 rejects the v1 spelling by name, so a model moving between
				// surfaces learns the new one instead of probing.
				if (raw.fork_context !== undefined) {
					throw new Error("fork_context is not supported in MultiAgentV2; use fork_turns instead");
				}
				// Codex hides `agent_type` when no roles are configured; naming one is
				// the role-resolution failure it reports.
				if (raw.agent_type !== undefined) throw new Error("agent type is currently not available");
				const requested = (params.fork_turns ?? "all").trim().toLowerCase();
				// Codex still accepts a legacy turn count as a full-history fork.
				if (requested !== "all" && requested !== "none" && !/^[1-9]\d*$/.test(requested)) {
					throw new Error("fork_turns must be `none` or `all`");
				}
				const forkTurns: ForkTurns = requested === "none" ? "none" : "all";
				if (params.message.trim() === "") throw new Error("Empty message can't be sent to an agent");
				const { context, release } = contextFor(parent(), params.task_name);
				try {
					const agent = await deps.spawn(context, {
						taskName: params.task_name,
						message: params.message,
						forkTurns,
						...(params.model === undefined ? {} : { model: params.model }),
						...(params.reasoning_effort === undefined ? {} : { reasoningEffort: params.reasoning_effort }),
					});
					// Registration hands the claim over to the record's admitted turn.
					register(agent, true);
					briefSpawner(context.parent.sessionId);
					return spawnResult(agent);
				} finally {
					release();
				}
			},
		}),
		defineTool({
			name: "send_message",
			label: "Send message",
			description:
				"Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn.",
			parameters: Type.Object({
				target: Type.String({ description: "Relative or canonical task name to message (from spawn_agent)." }),
				message: Type.String({ description: "Message text to queue on the target agent." }),
			}),
			async execute(_toolCallId, params) {
				if (params.message.trim() === "") throw new Error("Empty message can't be sent to an agent");
				const caller = parent();
				const resolved = await resolveTarget(caller, params.target);
				if (resolved.kind === "root") {
					return empty(
						await deliver(
							resolved.id,
							ROOT_PATH,
							pathOf(caller),
							"MESSAGE",
							params.message,
							deps.addressOf(caller, pathOf(caller), ROOT_PATH),
						),
					);
				}
				const ref = resolved.record.agent?.ref;
				if (ref === undefined) throw new Error(`agent with id ${resolved.record.id} is closed`);
				return empty(
					await deliver(resolved.record.id, resolved.record.path, pathOf(caller), "MESSAGE", params.message, {
						projectId: ref.projectId,
						stem: ref.stem,
					}),
				);
			},
		}),
		defineTool({
			name: "followup_task",
			label: "Follow-up task",
			description:
				"Send a follow-up task to an existing non-root target agent and trigger a turn if it is idle. If the target is already running, deliver the task promptly at message boundaries while sampling, or after the pending tool call completes.",
			parameters: Type.Object({
				target: Type.String({
					description: "Agent id or canonical task name to send a follow-up task to (from spawn_agent).",
				}),
				message: Type.String({ description: "Message text to send to the target agent." }),
			}),
			async execute(_toolCallId, params) {
				if (params.message.trim() === "") throw new Error("Empty message can't be sent to an agent");
				const caller = parent();
				const resolved = await resolveTarget(caller, params.target);
				if (resolved.kind === "root") throw new Error("Follow-up tasks can't target the root agent");
				const record = resolved.record;
				const agent = record.agent;
				if (agent === undefined) throw new Error(`agent with id ${record.id} is closed`);
				// A running target is steered, not admitted, so only an idle one consumes a slot.
				const wasRunning = isRunning(record);
				const release = wasRunning ? (): void => {} : claimCapacity(record.rootId, "collab tool failed");
				// The turn is claimed before the first await, not after it: pi's trigger-turn
				// admission awaits the whole run, so its settlement can land while `startTask`
				// is still pending, and a later write would erase the result that ended it and
				// hold the slot it freed. Claiming first is also what makes a concurrent
				// follow-up see this target as running and steer instead of claiming again.
				const previousSettled = record.settled;
				record.settled = undefined;
				record.pendingTurn = true;
				try {
					const message = envelope("NEW_TASK", record.path, pathOf(caller), params.message);
					await agent.startTask(message.content, message.details);
					// Codex counts trigger-turn mail as mailbox activity, so a caller blocked in
					// `wait_agent` wakes on it instead of sitting out the deadline.
					signal(record.id);
					return empty(message.details.submissionId);
				} catch (error) {
					// An admission that never happened leaves no turn behind it, so the record
					// returns to what it said before instead of claiming work that never ran.
					if (record.settled === undefined) {
						record.settled = previousSettled;
						record.pendingTurn = wasRunning;
					}
					throw error;
				} finally {
					release();
				}
			},
		}),
		defineTool({
			name: "wait_agent",
			label: "Wait for agent",
			description:
				"Wait for a mailbox update from any live agent, including queued messages and final-status notifications. The wait also ends early when new user input is steered into the active turn. Does not return the content; returns either a summary of which agents have updates (if any), an interruption summary for steered input, or a timeout summary if no activity arrives before the deadline.",
			parameters: Type.Object({
				timeout_ms: Type.Optional(
					Type.Number({
						description: `Timeout in milliseconds. Defaults to ${DEFAULT_WAIT_MS}, min ${MIN_WAIT_MS}, max ${MAX_WAIT_MS}.`,
					}),
				),
			}),
			async execute(_toolCallId, params) {
				const requested = params.timeout_ms;
				if (requested !== undefined && requested > MAX_WAIT_MS) {
					throw new Error(`timeout_ms must be at most ${MAX_WAIT_MS}`);
				}
				const timeoutMs = requested === undefined ? DEFAULT_WAIT_MS : Math.max(requested, MIN_WAIT_MS);
				const reason = await waitFor(parent(), timeoutMs);
				const summary =
					reason === "mailbox"
						? "Wait completed."
						: reason === "steered"
							? "Wait interrupted by new input."
							: "Wait timed out.";
				// Codex reports the clamp it applied inside the message, so a model
				// that asked for a short poll learns why it waited longer.
				const note =
					requested !== undefined && requested < timeoutMs
						? `\n\nRequested timeout of ${requested}ms was clamped to the minimum of ${timeoutMs}ms.`
						: "";
				return text({ message: `${summary}${note}`, timed_out: reason === "timed_out" });
			},
		}),
		defineTool({
			name: "interrupt_agent",
			label: "Interrupt agent",
			description:
				"Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
			parameters: Type.Object({
				target: Type.String({ description: "Agent id or canonical task name to interrupt (from spawn_agent)." }),
			}),
			async execute(_toolCallId, params) {
				const caller = parent();
				const resolved = await resolveTarget(caller, params.target);
				// Codex applies v2 rules: root and self are rejected before inspection.
				if (resolved.kind === "root") throw new Error("root is not a spawned agent");
				const record = resolved.record;
				if (record.id === caller.sessionId) {
					throw new Error(
						"an agent cannot interrupt itself; return your result and let the parent interrupt you if needed",
					);
				}
				// An unloaded runtime is a known identity whose status is not observable.
				if (record.agent === undefined) return text({ previous_status: "not_found" });
				// Codex reports the status observed before dispatch. The abort's own
				// settlement reports `interrupted`, and a turn that settles meanwhile wins.
				const previous: AgentStatus = statusOf(record);
				await record.agent.interrupt();
				return text({ previous_status: previous });
			},
		}),
		defineTool({
			name: "list_agents",
			label: "List agents",
			description: "List live agents in the current root thread tree. Optionally filter by task-path prefix.",
			parameters: Type.Object({
				path_prefix: Type.Optional(
					Type.String({
						description: "Task-path prefix filter without a trailing slash. Omit to list all live agents.",
					}),
				),
			}),
			async execute(_toolCallId, params) {
				const caller = parent();
				const rootId = rootIdOf(caller);
				// Codex resolves the prefix against the caller, so a child can ask for
				// "task_2" meaning its own child rather than the canonical form.
				const prefix =
					params.path_prefix === undefined ? undefined : resolveAgentPath(pathOf(caller), params.path_prefix);
				const agents: Array<{ agent_name: string; agent_status: AgentStatus }> = [];
				const rootStatus = await deps.probe(rootId);
				if (rootStatus !== undefined && matchesPathPrefix(ROOT_PATH, prefix)) {
					agents.push({ agent_name: ROOT_PATH, agent_status: rootStatus });
				}
				const children = [...records.values()]
					.filter(
						(record) =>
							record.rootId === rootId &&
							// Codex omits an agent it cannot report on; an unloaded record is
							// still addressable, but it has no status to list.
							record.agent !== undefined &&
							matchesPathPrefix(record.path, prefix),
					)
					.sort((left, right) => left.path.localeCompare(right.path))
					.map((record) => ({ agent_name: record.path, agent_status: statusOf(record) }));
				return text({ agents: [...agents, ...children] });
			},
		}),
	];

	return { toolsFor };
}

/** A target after resolution: a spawned agent, or the tree root, which has no
 * record or capability because it is the Session doing the calling. */
type ResolvedTarget =
	| { readonly kind: "agent"; readonly record: AgentRecord }
	| { readonly kind: "root"; readonly id: string };

/** Codex's `AgentPath::resolve`: an absolute path stands as written, anything
 * else is relative to the caller. Validation runs before any lookup, so a
 * malformed reference fails identically in every tool. */
function resolveAgentPath(callerPath: string, reference: string): string {
	if (reference === "") throw new Error("agent path must not be empty");
	if (reference.startsWith("/")) {
		validateAbsolutePath(reference);
		return reference;
	}
	if (reference.endsWith("/")) throw new Error("relative agent path must not end with `/`");
	for (const segment of reference.split("/")) validateAgentName(segment);
	return `${callerPath}/${reference}`;
}

function validateAbsolutePath(path: string): void {
	const stripped = path.slice(1);
	const [root] = stripped.split("/");
	if (root !== "root") throw new Error("absolute agent paths must start with `/root`");
	if (stripped.endsWith("/")) throw new Error("absolute agent path must not end with `/`");
	for (const segment of stripped.split("/").slice(1)) validateAgentName(segment);
}

function validateAgentName(name: string): void {
	if (name === "") throw new Error("agent_name must not be empty");
	if (name === "root") throw new Error("agent_name `root` is reserved");
	if (name === "." || name === "..") throw new Error(`agent_name \`${name}\` is reserved`);
	if (name.includes("/")) throw new Error("agent_name must not contain `/`");
	if (!/^[a-z0-9_]+$/.test(name)) {
		throw new Error("agent_name must use only lowercase letters, digits, and underscores");
	}
}

/** Whether the target is a path reference rather than a thread id. Bridge ids
 * are UUIDs, which no agent name may contain, so a hyphen is the id marker. */
function isPathReference(target: string): boolean {
	return !target.includes("-") && !target.includes(".");
}

/** Codex's prefix rule: the root prefix matches everything; any other prefix
 * matches itself and its descendants, on a segment boundary. */
function matchesPathPrefix(path: string, prefix: string | undefined): boolean {
	if (prefix === undefined || prefix === ROOT_PATH) return true;
	return path === prefix || path.startsWith(`${prefix}/`);
}

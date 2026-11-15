// Agent control — the Codex MultiAgentV2 tool surface over Sessions.
//
// These tests pin the contract the model reads, not the Worker's Session
// creation:
//   - spawn returns only the canonical task path to the model, while its hidden
//     details carry the child's Session id and stem so a client can open the
//     row; paths resolve by thread
//     id, canonical form, or the caller-relative form — never by a bare-name
//     search, so an ambiguous reference fails instead of reaching the wrong
//     agent;
//   - status is the tagged union, not a flat enum, and list_agents carries the
//     tree root;
//   - send_message queues a context fragment without starting a turn;
//   - followup_task starts or steers a turn;
//   - a settlement pushes a FINAL_ANSWER fragment to the spawner and wakes its
//     wait, which returns a content-free summary;
//   - the spawner is briefed on the collaboration contract once, a long errored
//     payload is truncated before it reaches the parent, and a target with no
//     live runtime is loaded from its address instead of reported closed;
//   - a child can message an ancestor, but not an unrelated Session;
//   - concurrency counts running turns, so a settled agent frees its slot.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { SessionOutcome, SessionRef } from "../../src/core/index.ts";
import {
	type AgentAddress,
	type AgentControlService,
	type AgentFragment,
	type AgentResumeContext,
	type AgentSpawnContext,
	type AgentStatus,
	type ControlledAgent,
	createAgentControl,
	ROOT_PATH,
	type SpawnAgentRequest,
	settledStatus,
} from "../../src/host/agent-control.ts";
import { POLICY_CUSTOM_TYPE } from "../../src/host/agent-policy.ts";

interface FakeAgent extends ControlledAgent {
	readonly promptCalls: string[];
	readonly closeCalls: number;
	readonly settle: (outcome: SessionOutcome) => void;
	readonly setBusy: (busy: boolean) => void;
	/** Replace the text a settlement reads as the child's last message. */
	readonly setLastMessage: (text: string) => void;
	/** Hold the next interrupt until the test releases it, so a settlement can land
	 * while the abort is still in flight. */
	readonly holdNextInterrupt: () => void;
	readonly releaseInterrupt: () => void;
}

function refFor(id: string): SessionRef {
	return { projectId: "p", sessionId: id, stem: `stem-${id}` };
}

type AgentIdentity = Pick<AgentResumeContext, "parentId" | "rootId" | "depth" | "path" | "ancestry">;

interface Harness {
	control: AgentControlService;
	toolsFor: (parent: SessionRef) => ToolDefinition[];
	spawned: FakeAgent[];
	/** Runtimes loaded by `resume`, in call order. */
	resumed: FakeAgent[];
	/** Every resume request the control plane issued, for the context it passes. */
	resumeContexts: AgentResumeContext[];
	/** Fragments queued per session id, in delivery order. */
	fragments: Map<string, AgentFragment[]>;
	/** Every delivery with the address it carried, in call order. */
	deliveries: Array<{ agentId: string; address: AgentAddress | undefined }>;
	/** Every address the control plane asked the Worker for, in call order. */
	addressCalls: Array<{ session: SessionRef; sessionPath: string; path: string }>;
	/** Simulate text admitted into a session's turn. */
	readonly steer: (id: string) => void;
	/** Admit input in the window between a wait's snapshot and its listener: the
	 * counter moves, the listener is installed after it. */
	readonly steerDuringWaitSubscription: (id: string) => void;
	/** The root Session's status, which only the Worker runtime can report. */
	readonly setRootStatus: (status: AgentStatus) => void;
	/** A child whose file exists but whose runtime does not: what a Worker restart
	 * or an eviction leaves behind, with no record in memory. */
	readonly dormant: (path: string) => void;
}

function createHarness(): Harness {
	const spawned: FakeAgent[] = [];
	const fragments = new Map<string, AgentFragment[]>();
	const deliveries: Array<{ agentId: string; address: AgentAddress | undefined }> = [];
	const addressCalls: Array<{ session: SessionRef; sessionPath: string; path: string }> = [];
	const inputListeners = new Map<string, Set<() => void>>();
	/** The Worker's monotonic admission count, per Session. */
	const inputSequences = new Map<string, number>();
	const bumpInput = (id: string): void => {
		inputSequences.set(id, (inputSequences.get(id) ?? 0) + 1);
		for (const listener of [...(inputListeners.get(id) ?? [])]) listener();
	};
	let steerOnSubscribe: string | undefined;
	let rootStatus: AgentStatus = "running";
	let next = 0;
	const knownPaths = new Set<string>();
	const dormantPaths = new Set<string>();
	const resumed: FakeAgent[] = [];
	const resumeContexts: AgentResumeContext[] = [];

	/** One fake runtime for a child. Spawn and resume both build one, so a
	 * reloaded agent is indistinguishable from a spawned one to the tools. */
	const buildAgent = (context: AgentIdentity, label: string): FakeAgent => {
		next += 1;
		const id = `agent-${next}`;
		const listeners = new Set<(outcome: SessionOutcome) => void>();
		let busy = true;
		let closed = 0;
		let lastMessageText = `${label} done`;
		let interruptGate: (() => void) | undefined;
		const agent: FakeAgent = {
			id,
			ref: { ...refFor(id), stem: `${ROOT.stem}/${label}` },
			path: context.path,
			parentId: context.parentId,
			rootId: context.rootId,
			depth: context.depth,
			ancestry: context.ancestry,
			promptCalls: [],
			get closeCalls() {
				return closed;
			},
			isBusy: () => busy,
			prompt: async (message) => {
				agent.promptCalls.push(message);
				busy = true;
			},
			startTask: async (content) => {
				agent.promptCalls.push(content);
				busy = true;
			},
			interrupt: async () => {
				if (interruptGate === undefined) {
					busy = false;
					return;
				}
				await new Promise<void>((resolve) => {
					interruptGate = () => {
						busy = false;
						resolve();
					};
				});
			},
			holdNextInterrupt: () => {
				interruptGate = () => {};
			},
			releaseInterrupt: () => interruptGate?.(),
			close: async () => {
				closed += 1;
				busy = false;
			},
			lastMessage: async () => lastMessageText,
			setLastMessage: (text) => {
				lastMessageText = text;
			},
			onSettled: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			settle: (outcome) => {
				busy = false;
				for (const listener of [...listeners]) listener(outcome);
			},
			setBusy: (value) => {
				busy = value;
			},
		};
		return agent;
	};

	const control = createAgentControl({
		spawn: async (context: AgentSpawnContext, request: SpawnAgentRequest): Promise<ControlledAgent> => {
			const agent = buildAgent(context, request.taskName);
			knownPaths.add(context.path);
			spawned.push(agent);
			return agent;
		},
		resume: async (context: AgentResumeContext): Promise<ControlledAgent | undefined> => {
			resumeContexts.push(context);
			// The file is the identity: only an address that exists can be loaded.
			if (!knownPaths.has(context.path) && !dormantPaths.has(context.path)) return undefined;
			const agent = buildAgent(context, context.path);
			knownPaths.add(context.path);
			resumed.push(agent);
			return agent;
		},
		deliver: async (agentId, fragment, address) => {
			deliveries.push({ agentId, address });
			const queue = fragments.get(agentId) ?? [];
			queue.push(fragment);
			fragments.set(agentId, queue);
		},
		// The Worker owns the path/stem mapping in production; here it records the
		// question and answers with an identity a test can recognise, so an assertion
		// can tell the Worker's answer from a value the control plane computed.
		addressOf: (session, sessionPath, path) => {
			addressCalls.push({ session, sessionPath, path });
			return {
				projectId: session.projectId,
				// An address only the Worker could have produced, so an assertion can tell
				// its answer from a value the control plane derived on its own.
				stem: `addr:${path}`,
			};
		},
		watchInput: (agentId, listener) => {
			// Input admitted before this listener exists is invisible to it: only a
			// snapshot comparison can observe the race the wait must close.
			if (steerOnSubscribe === agentId) {
				steerOnSubscribe = undefined;
				bumpInput(agentId);
			}
			const listeners = inputListeners.get(agentId) ?? new Set<() => void>();
			listeners.add(listener);
			inputListeners.set(agentId, listeners);
			return () => listeners.delete(listener);
		},
		inputSequence: (agentId) => inputSequences.get(agentId) ?? 0,
		probe: async (agentId) => (agentId === ROOT.sessionId ? rootStatus : undefined),
	});
	return {
		control,
		toolsFor: (parent) => control.toolsFor(() => parent),
		spawned,
		resumed,
		resumeContexts,
		fragments,
		deliveries,
		addressCalls,
		steer: (id) => bumpInput(id),
		steerDuringWaitSubscription: (id) => {
			steerOnSubscribe = id;
		},
		setRootStatus: (status) => {
			rootStatus = status;
		},
		dormant: (path) => {
			dormantPaths.add(path);
		},
	};
}

/** Fragments beyond the role brief: the inter-agent traffic the tools sent. */
function mail(fragments: Map<string, AgentFragment[]>, id: string): AgentFragment[] {
	return (fragments.get(id) ?? []).filter((fragment) => fragment.customType !== POLICY_CUSTOM_TYPE);
}

/** Whether a message tool's details carry a submission id. The model-facing
 * body stays empty, as Codex's is; the id is what pairs acceptance with arrival. */
function receiptOf(details: unknown): boolean {
	return (
		typeof details === "object" &&
		details !== null &&
		typeof (details as { submission_id?: unknown }).submission_id === "string"
	);
}

async function callResult(tools: ToolDefinition[], name: string, params: Record<string, unknown>) {
	const tool = tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`no tool ${name}`);
	return tool.execute("call-1", params as never, undefined, undefined, {} as never);
}

async function call(tools: ToolDefinition[], name: string, params: Record<string, unknown>): Promise<unknown> {
	return (await callResult(tools, name, params)).details;
}

/** Let the settlement handler's async tail (read last message, deliver) run. */
async function settle(fake: FakeAgent, outcome: SessionOutcome = "completed"): Promise<void> {
	fake.settle(outcome);
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A realistic root id: bridge ids are UUIDs, so a task name can never collide
 * with one, and resolution parses an id before a path. */
const ROOT = refFor("0190f0e2-7a3b-7000-8000-000000000000");

describe("agent control tools", () => {
	it("spawns, returns the canonical task path, and lists the tree with its root", async () => {
		const { toolsFor } = createHarness();
		const tools = toolsFor(ROOT);
		const result = await callResult(tools, "spawn_agent", { task_name: "scout", message: "look" });
		// The model reads only the path; the address is hidden provenance for the UI.
		expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ task_name: "/root/scout" });
		expect(result.details).toEqual({
			task_name: "/root/scout",
			session_id: "agent-1",
			stem: `${ROOT.stem}/scout`,
		});

		const listed = await call(toolsFor(ROOT), "list_agents", {});
		expect(listed).toEqual({
			agents: [
				{ agent_name: "/root", agent_status: "running" },
				{ agent_name: "/root/scout", agent_status: "running" },
			],
		});
	});

	it("briefs the spawner once and never re-briefs a subagent as root", async () => {
		const { toolsFor, spawned, fragments } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "one", message: "go" });
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "two", message: "go" });

		const briefs = (fragments.get(ROOT.sessionId) ?? []).filter(
			(fragment) => fragment.customType === POLICY_CUSTOM_TYPE,
		);
		expect(briefs).toHaveLength(1);
		expect(briefs[0]?.content).toContain("You are `/root`");
		// Codex's default delegation policy, not proactive fan-out.
		expect(briefs[0]?.content).toContain("Do not spawn sub-agents unless");

		// A child is briefed by the Worker as a subagent, so it must not later
		// receive the root brief when it spawns its own children.
		await settle(spawned[0]);
		await call(toolsFor(spawned[0].ref), "spawn_agent", { task_name: "nested", message: "go" });
		expect((fragments.get(spawned[0].id) ?? []).filter((f) => f.customType === POLICY_CUSTOM_TYPE)).toHaveLength(0);
	});

	it("addresses a final answer at the spawner, so a collected spawner can be loaded", async () => {
		const { toolsFor, spawned, deliveries, addressCalls } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "worker", message: "go" });
		await settle(spawned[0]);

		// The settlement's fragment names the spawner's durable place: the Worker
		// loads it when no runtime is live instead of dropping the result.
		const addressed = deliveries.filter((delivery) => delivery.agentId === ROOT.sessionId && delivery.address);
		const child = spawned[0];
		if (child === undefined) throw new Error("child missing");
		// The control plane derives no storage layout: the settlement asked the Worker
		// for the spawner's address, naming the Session doing the sending and its path.
		expect(addressCalls.at(-1)).toEqual({ session: child.ref, sessionPath: "/root/worker", path: ROOT_PATH });
		expect(addressed.at(-1)?.address).toEqual({ projectId: ROOT.projectId, stem: `addr:${ROOT_PATH}` });
	});

	it("asks the Worker for a nested parent's address instead of deriving it", async () => {
		const { toolsFor, spawned, addressCalls } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "a", message: "first" });
		const lead = spawned[0];
		if (lead === undefined) throw new Error("lead missing");
		await call(toolsFor(lead.ref), "spawn_agent", { task_name: "b", message: "second" });
		const leaf = spawned[1];
		if (leaf === undefined) throw new Error("leaf missing");
		expect(leaf.path).toBe("/root/a/b");

		addressCalls.length = 0;
		await settle(leaf, "completed");
		// The grandchild settles into its parent: one directory above, at a depth
		// where a second copy of the stem arithmetic would drift unnoticed.
		expect(addressCalls).toEqual([{ session: leaf.ref, sessionPath: "/root/a/b", path: "/root/a" }]);
	});

	it("reports status as the tagged union the model reads", async () => {
		const { toolsFor, spawned, fragments } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "worker", message: "go" });
		await settle(spawned[0]);

		const listed = await call(toolsFor(ROOT), "list_agents", {});
		expect(listed).toEqual({
			agents: [
				{ agent_name: "/root", agent_status: "running" },
				{ agent_name: "/root/worker", agent_status: { completed: "worker done" } },
			],
		});

		spawned[0].setBusy(true);
		await settle(spawned[0], "error");
		expect(await call(toolsFor(ROOT), "list_agents", {})).toEqual({
			agents: [
				{ agent_name: "/root", agent_status: "running" },
				{ agent_name: "/root/worker", agent_status: { errored: "worker done" } },
			],
		});

		const beforeInterrupt = fragments.get(ROOT.sessionId)?.length ?? 0;
		spawned[0].setBusy(true);
		await settle(spawned[0], "aborted");
		expect(await call(toolsFor(ROOT), "list_agents", {})).toEqual({
			agents: [
				{ agent_name: "/root", agent_status: "running" },
				{ agent_name: "/root/worker", agent_status: "interrupted" },
			],
		});
		// An interrupted turn is not a result: the spawner hears nothing.
		expect(fragments.get(ROOT.sessionId)?.length ?? 0).toBe(beforeInterrupt);
	});

	it("truncates a long errored payload before it reaches the parent", async () => {
		const { toolsFor, spawned, fragments } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "worker", message: "go" });
		const failure = "x".repeat(10_000);
		spawned[0].setLastMessage(failure);
		await settle(spawned[0], "error");

		const payload = mail(fragments, ROOT.sessionId)[0]?.content ?? "";
		expect(payload).toContain(" chars truncated…");
		expect(payload.length).toBeLessThan(failure.length);
		expect(payload).toContain(
			"This agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.",
		);
	});

	it("queues send_message as a context fragment without starting a turn", async () => {
		const { toolsFor, spawned, fragments } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "worker", message: "first" });
		const worker = spawned[0];
		worker.setBusy(false);

		// Codex's message tools return an empty body, not `{}`.
		// The model sees an empty body; the acceptance id rides in details.
		expect(receiptOf(await call(toolsFor(ROOT), "send_message", { target: "worker", message: "note" }))).toBe(true);
		expect(worker.promptCalls).toEqual([]);
		expect(fragments.get(worker.id)?.[0]?.content).toBe(
			"Message Type: MESSAGE\nTask name: /root/worker\nSender: /root\nPayload:\nnote",
		);
	});

	it("starts or steers a turn on followup_task", async () => {
		const { toolsFor, spawned } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "worker", message: "first" });
		const worker = spawned[0];
		worker.setBusy(false);

		expect(receiptOf(await call(toolsFor(ROOT), "followup_task", { target: "worker", message: "go" }))).toBe(true);
		expect(worker.promptCalls).toEqual([
			"Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\ngo",
		]);
	});

	it("keeps the result of a follow-up whose admission resolved after the turn settled", async () => {
		const { toolsFor, spawned } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "worker", message: "first" });
		const worker = spawned[0];
		worker.setBusy(false);
		// pi's trigger-turn admission awaits the whole run, so the turn settles before
		// `startTask` resolves. Whatever the tool writes afterwards must not erase it:
		// a record left `running` keeps the tree's capacity slot forever.
		let release = (): void => {};
		const admitted = new Promise<void>((resolve) => {
			release = resolve;
		});
		worker.startTask = async () => {
			await admitted;
		};

		const followup = call(toolsFor(ROOT), "followup_task", { target: "worker", message: "go" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		await settle(worker);
		release();
		await followup;

		const listed = (await call(toolsFor(ROOT), "list_agents", {})) as {
			agents: Array<{ agent_name: string; agent_status: unknown }>;
		};
		expect(listed.agents.find((entry) => entry.agent_name === "/root/worker")?.agent_status).toEqual({
			completed: "worker done",
		});
	});

	it("wakes a blocked wait when a follow-up task lands", async () => {
		const { toolsFor, spawned } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "lead", message: "first" });
		const lead = spawned[0];
		// A waiting agent's own turn is running, so a follow-up steers it — and Codex
		// counts trigger-turn mail as mailbox activity, so the wait must not sit out
		// its deadline waiting for a settlement that may never come. The floor is the
		// shortest wait the tool allows, so a regression fails on the summary instead
		// of the test clock.
		const wait = call(toolsFor(lead.ref), "wait_agent", { timeout_ms: 10_000 });
		await call(toolsFor(ROOT), "followup_task", { target: "lead", message: "go" });

		expect(await wait).toEqual({ message: "Wait completed.", timed_out: false });
	});

	it("pushes the final answer to the spawner and wakes its wait", async () => {
		const { toolsFor, spawned, fragments } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "worker", message: "first" });
		const wait = call(toolsFor(ROOT), "wait_agent", { timeout_ms: 30_000 });
		await settle(spawned[0]);

		expect(await wait).toEqual({ message: "Wait completed.", timed_out: false });
		expect(mail(fragments, ROOT.sessionId)[0]?.content).toBe(
			"Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\nworker done",
		);
	});

	it("loads a dormant child from its address instead of reporting it closed", async () => {
		const { toolsFor, resumed, resumeContexts, fragments, dormant } = createHarness();
		// A Worker restart ended the tree: the child's file is all that is left.
		dormant("/root/survivor");

		const receipt = await call(toolsFor(ROOT), "send_message", { target: "survivor", message: "still there?" });
		expect(receiptOf(receipt)).toBe(true);
		// The Worker maps the canonical path back to the file the tree was built from.
		expect(resumeContexts[0]).toMatchObject({
			callerPath: "/root",
			path: "/root/survivor",
			parentPath: "/root",
			depth: 1,
			parentId: ROOT.sessionId,
			rootId: ROOT.sessionId,
		});
		expect(mail(fragments, resumed[0].id)[0]?.content).toContain("Payload:\nstill there?");

		// It is a live record now, so a follow-up starts a turn on the same runtime.
		expect(receiptOf(await call(toolsFor(ROOT), "followup_task", { target: "survivor", message: "more" }))).toBe(
			true,
		);
		expect(resumed[0].promptCalls).toHaveLength(1);
		expect(resumed).toHaveLength(1);
	});

	it("reports an address with no file as not found", async () => {
		const { toolsFor, resumeContexts } = createHarness();
		await expect(call(toolsFor(ROOT), "send_message", { target: "ghost", message: "x" })).rejects.toThrow(
			"live agent path `/root/ghost` not found",
		);
		expect(resumeContexts).toHaveLength(1);
	});

	it("reloads an evicted child instead of failing its message", async () => {
		const { toolsFor, spawned, resumed, fragments } = createHarness();
		// The residency high-water is 32, so the 33rd settlement unloads the first
		// idle runtime. Each spawn has to settle to free its turn.
		for (let index = 0; index < 33; index++) {
			await call(toolsFor(ROOT), "spawn_agent", { task_name: `task_${index}`, message: "go" });
			await settle(spawned[index]);
		}

		// Codex reloads an evicted child; the bridge loads the Session its address
		// names and delivers the mail there.
		expect(receiptOf(await call(toolsFor(ROOT), "send_message", { target: "task_0", message: "x" }))).toBe(true);
		expect(resumed).toHaveLength(1);
		// The record keeps the Session's durable id; only its runtime was replaced.
		expect(mail(fragments, spawned[0].id)[0]?.content).toContain("Payload:\nx");
		const listed = (await call(toolsFor(ROOT), "list_agents", {})) as { agents: Array<{ agent_name: string }> };
		expect(listed.agents.map((agent) => agent.agent_name)).toContain("/root/task_0");
	});

	it("clamps a short timeout, reports the clamp, and returns a content-free summary", async () => {
		const { toolsFor } = createHarness();
		expect(await call(toolsFor(ROOT), "wait_agent", { timeout_ms: 10_000 })).toEqual({
			message: "Wait timed out.",
			timed_out: true,
		});
		// A request below the floor still waits the floor, and says so.
		expect(await call(toolsFor(ROOT), "wait_agent", { timeout_ms: 1_000 })).toEqual({
			message: "Wait timed out.\n\nRequested timeout of 1000ms was clamped to the minimum of 10000ms.",
			timed_out: true,
		});
	});

	it("rejects a timeout above the maximum", async () => {
		const { toolsFor } = createHarness();
		await expect(call(toolsFor(ROOT), "wait_agent", { timeout_ms: 3_600_001 })).rejects.toThrow(
			"timeout_ms must be at most 3600000",
		);
	});

	it("yields a wait on steered input", async () => {
		const { toolsFor, steer } = createHarness();
		const wait = call(toolsFor(ROOT), "wait_agent", { timeout_ms: 30_000 });
		steer(ROOT.sessionId);
		expect(await wait).toEqual({ message: "Wait interrupted by new input.", timed_out: false });
	});

	it("lets a child message an ancestor but not an unrelated Session", async () => {
		const { toolsFor, spawned, fragments } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "worker", message: "first" });
		const child = spawned[0];
		const childTools = toolsFor(child.ref);

		// `/root` is the root's canonical path. The bare name `root` is a reserved
		// segment, so Codex rejects it rather than guessing the caller's parent.
		expect(receiptOf(await call(childTools, "send_message", { target: "/root", message: "asking" }))).toBe(true);
		expect(mail(fragments, ROOT.sessionId)[0]?.content).toBe(
			"Message Type: MESSAGE\nTask name: /root\nSender: /root/worker\nPayload:\nasking",
		);
		await expect(call(childTools, "send_message", { target: "root", message: "no" })).rejects.toThrow(
			"agent_name `root` is reserved",
		);

		await expect(call(childTools, "send_message", { target: "elsewhere", message: "no" })).rejects.toThrow(
			"live agent path `/root/worker/elsewhere` not found",
		);
	});

	it("resolves a canonical path and a path relative to the caller", async () => {
		const { toolsFor, spawned } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "one", message: "first" });
		const first = spawned[0];
		await call(toolsFor(first.ref), "spawn_agent", { task_name: "two", message: "second" });
		const second = spawned[1];

		await call(toolsFor(first.ref), "followup_task", { target: "/root/one/two", message: "a" });
		await call(toolsFor(first.ref), "followup_task", { target: "two", message: "b" });
		expect(second.promptCalls).toHaveLength(2);
		expect(second.path).toBe("/root/one/two");
	});

	it("never resolves a reference by searching names across the tree", async () => {
		const { toolsFor, spawned } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "one", message: "first" });
		const first = spawned[0];
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "two", message: "second" });
		await call(toolsFor(spawned[1].ref), "spawn_agent", { task_name: "shared", message: "third" });

		// `shared` now exists at /root/two/shared, but from /root/one it means
		// /root/one/shared: Codex refuses instead of picking the far one.
		await expect(call(toolsFor(first.ref), "send_message", { target: "shared", message: "x" })).rejects.toThrow(
			"live agent path `/root/one/shared` not found",
		);
	});

	it("returns the previous status from interrupt_agent and keeps the agent addressable", async () => {
		const { toolsFor, spawned } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "worker", message: "first" });

		expect(await call(toolsFor(ROOT), "interrupt_agent", { target: "worker" })).toEqual({
			previous_status: "running",
		});
		expect(spawned[0].promptCalls).toEqual([]);
		expect(receiptOf(await call(toolsFor(ROOT), "followup_task", { target: "worker", message: "again" }))).toBe(true);
	});

	it("rejects interrupting the root or the caller itself", async () => {
		const { toolsFor, spawned } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "worker", message: "first" });
		const child = spawned[0];

		await expect(call(toolsFor(ROOT), "interrupt_agent", { target: "/root" })).rejects.toThrow(
			"root is not a spawned agent",
		);
		await expect(call(toolsFor(child.ref), "interrupt_agent", { target: "/root/worker" })).rejects.toThrow(
			"an agent cannot interrupt itself; return your result and let the parent interrupt you if needed",
		);
	});

	it("does not turn a settled status into an interruption", async () => {
		const { toolsFor, spawned } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "worker", message: "first" });
		await settle(spawned[0]);

		expect(await call(toolsFor(ROOT), "interrupt_agent", { target: "worker" })).toEqual({
			previous_status: { completed: "worker done" },
		});
		expect(await call(toolsFor(ROOT), "list_agents", {})).toEqual({
			agents: [
				{ agent_name: "/root", agent_status: "running" },
				{ agent_name: "/root/worker", agent_status: { completed: "worker done" } },
			],
		});
	});

	it("rejects a follow-up task to the root", async () => {
		const { toolsFor } = createHarness();
		await expect(call(toolsFor(ROOT), "followup_task", { target: "/root", message: "go" })).rejects.toThrow(
			"Follow-up tasks can't target the root agent",
		);
	});

	it("counts running turns, so a settled agent frees its slot", async () => {
		const { toolsFor, spawned } = createHarness();
		for (const name of ["one", "two", "three", "four"]) {
			await call(toolsFor(ROOT), "spawn_agent", { task_name: name, message: "work" });
		}
		await expect(call(toolsFor(ROOT), "spawn_agent", { task_name: "five", message: "work" })).rejects.toThrow(
			"collab spawn failed: agent thread limit reached",
		);

		await settle(spawned[0]);
		await expect(call(toolsFor(ROOT), "spawn_agent", { task_name: "five", message: "work" })).resolves.toMatchObject({
			task_name: "/root/five",
		});
	});

	it("rejects a follow-up that would exceed the turn limit", async () => {
		const { toolsFor, spawned } = createHarness();
		for (const name of ["one", "two", "three", "four"]) {
			await call(toolsFor(ROOT), "spawn_agent", { task_name: name, message: "work" });
		}
		// Free one slot and take it again, so "one" is idle while four turns run.
		await settle(spawned[0]);
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "five", message: "work" });

		await expect(call(toolsFor(ROOT), "followup_task", { target: "one", message: "more" })).rejects.toThrow(
			"collab tool failed: agent thread limit reached",
		);
		// A running target is steered, not admitted, so it needs no slot.
		expect(receiptOf(await call(toolsFor(ROOT), "followup_task", { target: "two", message: "more" }))).toBe(true);
	});

	it("rejects the v1 fork spelling, and reads a legacy turn count as a full fork", async () => {
		const { toolsFor } = createHarness();
		await expect(
			call(toolsFor(ROOT), "spawn_agent", { task_name: "w", message: "m", fork_context: true }),
		).rejects.toThrow("fork_context is not supported in MultiAgentV2; use fork_turns instead");
		// Codex still accepts a positive turn count and treats it as `all`.
		await expect(
			call(toolsFor(ROOT), "spawn_agent", { task_name: "w", message: "m", fork_turns: "1" }),
		).resolves.toMatchObject({ task_name: "/root/w" });
		await expect(
			call(toolsFor(ROOT), "spawn_agent", { task_name: "x", message: "m", fork_turns: "some" }),
		).rejects.toThrow("fork_turns must be `none` or `all`");
	});

	it("validates a task name with Codex's messages", async () => {
		const { toolsFor } = createHarness();
		const reject = (taskName: string, message: string): Promise<unknown> =>
			expect(call(toolsFor(ROOT), "spawn_agent", { task_name: taskName, message: "m" })).rejects.toThrow(message);

		await reject("", "agent_name must not be empty");
		await reject("root", "agent_name `root` is reserved");
		await reject("..", "agent_name `..` is reserved");
		await reject("a/b", "agent_name must not contain `/`");
		await reject("Task1", "agent_name must use only lowercase letters, digits, and underscores");
	});

	it("hides agent_type, as Codex does without a role registry", async () => {
		const { toolsFor } = createHarness();
		const spawn = toolsFor(ROOT).find((tool) => tool.name === "spawn_agent");
		if (spawn === undefined) throw new Error("spawn_agent missing");
		expect(Object.keys((spawn.parameters as { properties: Record<string, unknown> }).properties)).toEqual([
			"task_name",
			"message",
			"fork_turns",
			"model",
			"reasoning_effort",
		]);
		await expect(
			call(toolsFor(ROOT), "spawn_agent", { task_name: "w", message: "m", agent_type: "explorer" }),
		).rejects.toThrow("agent type is currently not available");
	});

	it("resolves a list prefix against the caller, not the canonical form", async () => {
		const { toolsFor, spawned } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "task_1", message: "first" });
		const first = spawned[0];
		await call(toolsFor(first.ref), "spawn_agent", { task_name: "task_2", message: "second" });
		await call(toolsFor(first.ref), "spawn_agent", { task_name: "task_3", message: "third" });

		// From /root/task_1, `task_2` is its own child, not a top-level path.
		expect(await call(toolsFor(first.ref), "list_agents", { path_prefix: "task_2" })).toEqual({
			agents: [{ agent_name: "/root/task_1/task_2", agent_status: "running" }],
		});
		// The root prefix matches everything, and the tree sorts by path.
		expect(await call(toolsFor(first.ref), "list_agents", { path_prefix: "/root" })).toEqual({
			agents: [
				{ agent_name: "/root", agent_status: "running" },
				{ agent_name: "/root/task_1", agent_status: "running" },
				{ agent_name: "/root/task_1/task_2", agent_status: "running" },
				{ agent_name: "/root/task_1/task_3", agent_status: "running" },
			],
		});
	});

	it("allows a model override on a full-history fork", async () => {
		const { toolsFor } = createHarness();
		await expect(
			call(toolsFor(ROOT), "spawn_agent", { task_name: "worker", message: "first", model: "openai/gpt-5" }),
		).resolves.toMatchObject({ task_name: "/root/worker" });
	});

	it("exposes no close tool in v2", () => {
		const { toolsFor } = createHarness();
		expect(toolsFor(ROOT).map((tool) => tool.name)).toEqual([
			"spawn_agent",
			"send_message",
			"followup_task",
			"wait_agent",
			"interrupt_agent",
			"list_agents",
		]);
	});

	it("claims capacity before the first await, so parallel spawns cannot exceed the limit", async () => {
		const { toolsFor, spawned } = createHarness();
		const tools = toolsFor(ROOT);
		// One assistant message may carry several calls; every one of them runs
		// before any child is registered.
		const settled = await Promise.allSettled(
			["one", "two", "three", "four", "five"].map((task_name) =>
				call(tools, "spawn_agent", { task_name, message: "work" }),
			),
		);

		expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(4);
		expect(spawned).toHaveLength(4);
		const rejected = settled.filter((result) => result.status === "rejected");
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason.message).toBe(
			"collab spawn failed: agent thread limit reached",
		);
	});

	it("reports the settlement that lands while an interrupt is in flight", async () => {
		const { toolsFor, spawned } = createHarness();
		await call(toolsFor(ROOT), "spawn_agent", { task_name: "worker", message: "first" });
		const worker = spawned[0];
		worker.holdNextInterrupt();

		const interrupt = call(toolsFor(ROOT), "interrupt_agent", { target: "worker" });
		// Let resolution hand the call to `interrupt()`; the settle then lands inside
		// the abort rather than before dispatch.
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The turn ends before the abort completes. Codex reports what it observed
		// before dispatch, and a terminal settlement is never re-labelled.
		await settle(worker);
		worker.releaseInterrupt();

		expect(await interrupt).toEqual({ previous_status: "running" });
		expect(await call(toolsFor(ROOT), "list_agents", {})).toEqual({
			agents: [
				{ agent_name: "/root", agent_status: "running" },
				{ agent_name: "/root/worker", agent_status: { completed: "worker done" } },
			],
		});
	});

	it("observes input admitted before its wait listener was installed", async () => {
		const { toolsFor, steerDuringWaitSubscription } = createHarness();
		// The steer lands after the wait snapshotted the counter and before the
		// listener exists: only the snapshot comparison can see it.
		steerDuringWaitSubscription(ROOT.sessionId);
		expect(await call(toolsFor(ROOT), "wait_agent", { timeout_ms: 30_000 })).toEqual({
			message: "Wait interrupted by new input.",
			timed_out: false,
		});
	});
});

describe("settledStatus", () => {
	// The bridge's status is the tagged union the model reads, so the terminal
	// state's payload rules are code, not a formatting choice.
	it("names the payload of each terminal state", () => {
		expect(settledStatus("completed", "done")).toEqual({ completed: "done" });
		expect(settledStatus("completed", undefined)).toEqual({ completed: null });
		expect(settledStatus("aborted", "text")).toBe("interrupted");
		expect(settledStatus("error", "boom")).toEqual({ errored: "boom" });
		expect(settledStatus("error", undefined)).toEqual({ errored: "Agent errored" });
	});
});

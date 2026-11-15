// Agent control integration — a real Worker, a real parent turn, and one real
// spawned Session.
//
// The parent's faux model calls `spawn_agent`; the tool must create, register,
// and prompt a second Session stored at its task path. This is the wiring the
// unit tests cannot see: `createManager` handing the tools to the runtime, and
// `spawnControlledAgent` claiming an address and reusing the Worker's creation
// path.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	AuthStorage,
	getDefaultSessionDir,
	ModelRuntime,
	type SessionEntry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivationRecord } from "../../src/host/activation-registry.ts";
import { createManager } from "../../src/host/manager.ts";
import { type ProjectConfig, resolveStemPath } from "../../src/host/projects.ts";
import {
	createLocalWorker,
	type LocalWorker,
	lastAssistantTextBefore,
	stemForAgentPath,
} from "../../src/host/worker-local.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out");
}

/** The user-role text an entry contributes, as pi renders it: a plain string or
 * text parts. Empty for every other entry. */
function userText(entry: SessionEntry): string {
	if (entry.type !== "message" || entry.message.role !== "user") return "";
	const { content } = entry.message;
	return typeof content === "string"
		? content
		: content
				.map((part) => (part.type === "text" ? part.text : ""))
				.filter((text) => text !== "")
				.join("\n");
}

type WorkerBundle = {
	worker: LocalWorker;
	project: ProjectConfig;
	faux: ReturnType<typeof registerFauxProvider>;
};

type FauxResponses = Parameters<ReturnType<typeof registerFauxProvider>["setResponses"]>[0];

/** One Worker over an existing root. A second call on the same root is the
 * restart the durable Sessions survive and the runtime's agent tree does not. */
async function createWorkerAt(root: string, responses: FauxResponses): Promise<WorkerBundle> {
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const sessionDir = getDefaultSessionDir(root, agentDir);
	mkdirSync(sessionDir, { recursive: true });

	const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
	faux.setResponses(responses);
	const model = faux.getModel();
	const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory() });
	await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((entry) => ({
			id: entry.id,
			name: entry.name,
			api: entry.api,
			reasoning: entry.reasoning,
			input: entry.input,
			cost: entry.cost,
			contextWindow: entry.contextWindow,
			maxTokens: entry.maxTokens,
			baseUrl: entry.baseUrl,
		})),
	});
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } } as Record<string, unknown>);
	const project: ProjectConfig = { id: "proj", cwd: root, sessionDir };
	const worker = createLocalWorker({
		projects: [project],
		agentDir,
		modelRuntime,
		projectSettings: new Map([[project.id, settingsManager]]),
		globalSettings: settingsManager,
		idleGcMs: 60_000,
		unflushedIdleGcMs: 60_000,
		requestedThinkingLevel: () => "off",
		managerFactory: (options) =>
			createManager({
				...options,
				settingsManager,
				model: model as never,
				gitStamps: false,
			}),
	});
	return { worker, project, faux };
}

async function createWorker(): Promise<WorkerBundle> {
	const root = join(tmpdir(), `pi-bridge-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const bundle = await createWorkerAt(root, [
		fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "worker", message: "do it", fork_turns: "none" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("child done"),
		fauxAssistantMessage("parent done"),
	]);
	cleanups.push(async () => {
		await bundle.worker.dispose();
		rmSync(root, { recursive: true, force: true });
	});
	return bundle;
}

/** Split a one-child tree by the storage layout: the spawner's stem is
 * top-level, the child's sits one directory below it. */
function spawnPair(worker: LocalWorker): { spawner: ActivationRecord; child: ActivationRecord } {
	const records = worker.liveRecords();
	const spawner = records.find((record) => !record.ref.stem.includes("/"));
	const child = records.find((record) => record.ref.stem.includes("/"));
	if (spawner === undefined || child === undefined) throw new Error("tree records missing");
	return { spawner, child };
}

describe("agent control integration", () => {
	describe("the path-to-file mapping", () => {
		// A spawn writes `<spawner stem>/<task name>`, so the tree hangs off the root's
		// stem and its storage layout is the path. Every address the control plane
		// needs is answered here, including a parent's from a grandchild: a second
		// copy of this arithmetic is what the seam exists to prevent.
		it("maps a path to the stem the spawn wrote, at any depth", () => {
			expect(stemForAgentPath("root/a", "/root/a", "/root/a/b")).toBe("root/a/b");
			expect(stemForAgentPath("root/a/b", "/root/a/b", "/root/a")).toBe("root/a");
			expect(stemForAgentPath("root/a/b/c", "/root/a/b/c", "/root")).toBe("root");
		});
	});

	describe("a forked child's result read", () => {
		const assistant = (id: string, text: string): SessionEntry =>
			({ id, type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }) as SessionEntry;

		it("stops at the boundary, so inherited parent text is not the child's answer", () => {
			const entries = [assistant("parent-1", "parent answer")];
			expect(lastAssistantTextBefore(entries, "parent-1")).toBeUndefined();
		});

		it("reads the child's own text past the boundary", () => {
			const entries = [assistant("parent-1", "parent answer"), assistant("child-1", "child answer")];
			expect(lastAssistantTextBefore(entries, "parent-1")).toBe("child answer");
		});

		it("reads past the boundary when the child's answer is not the last entry", () => {
			const entries = [
				assistant("parent-1", "parent answer"),
				assistant("child-1", "child answer"),
				assistant("child-2", "   "),
			];
			expect(lastAssistantTextBefore(entries, "parent-1")).toBe("child answer");
		});

		it("reads the whole branch when nothing was inherited", () => {
			const entries = [assistant("child-1", "child answer")];
			expect(lastAssistantTextBefore(entries, undefined)).toBe("child answer");
		});
	});

	it("stores a spawned Session at its task path, so the tree is the storage layout", async () => {
		const { worker, project } = await createWorker();
		await worker.createSession(project.id, { text: "delegate", sink: () => {} });

		await waitFor(() => worker.liveRecords().length === 2);
		const { spawner, child } = spawnPair(worker);
		// The path the tree addresses and the file the daemon scans are one string:
		// `<spawner stem>/<task name>`. No sidecar records the relation.
		expect(child.ref.stem).toBe(`${spawner.ref.stem}/worker`);

		// The child's final answer reaches the spawner's context without the spawner
		// asking for it: no wait_agent call is in the transcript, only the fragment
		// Codex delivers on settlement.
		const spawnerFile = resolveStemPath(project.sessionDir, spawner.ref.stem);
		await waitFor(() => {
			const text = SessionManager.open(spawnerFile)
				.getBranch()
				.filter((entry) => entry.type === "custom_message")
				.map((entry) => entry.content)
				.join("\n");
			return text.includes("Message Type: FINAL_ANSWER");
		});

		// Its row is titled by the canonical task name, not by the protocol envelope
		// its first message happens to start with.
		const childRow = (await worker.listSessions(project.id, 50, null)).sessions.find(
			(row) => row.stem === child.ref.stem,
		);
		expect(childRow?.name).toBe("worker");

		// The spawner is briefed on the contract the first time it spawns, so a
		// coordinator learns that results come back to it and that it must not poll.
		await waitFor(() => {
			const text = SessionManager.open(spawnerFile)
				.getBranch()
				.filter((entry) => entry.type === "custom_message")
				.map((entry) => entry.content)
				.join("\n");
			return text.includes("You are `/root`");
		});
	});

	it("lists a live spawned Session without making it a queue member", async () => {
		const { worker, project } = await createWorker();
		await worker.createSession(project.id, { text: "delegate", sink: () => {} });
		await waitFor(() => worker.liveRecords().length === 2);
		const { spawner, child } = spawnPair(worker);

		const { sessions } = await worker.listQueue();
		const spawnerRow = sessions.find((row) => row.stem === spawner.ref.stem);
		const childRow = sessions.find((row) => row.stem === child.ref.stem);
		// The user's Session is the queue member; the spawn is drawn under it and
		// keeps no place of its own, so Inbox counts and the keyboard ring ignore it.
		expect(spawnerRow?.location).toBe("inbox");
		expect(childRow?.location).toBe("archive");
	});

	it("resumes a spawned Session after a Worker restart, through its address", async () => {
		const root = join(tmpdir(), `pi-bridge-agent-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const first = await createWorkerAt(root, [
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", { task_name: "worker", message: "do it", fork_turns: "none" }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("child done"),
			fauxAssistantMessage("parent done"),
		]);
		await first.worker.createSession(first.project.id, { text: "delegate", sink: () => {} });
		await waitFor(() => first.worker.liveRecords().length === 2);
		const { spawner, child } = spawnPair(first.worker);
		const childStem = child.ref.stem;
		// Let the parent's turn finish: the child's FINAL_ANSWER is steered into it,
		// so disposing here would kill the turn the second Worker must not depend on.
		await waitFor(() => first.worker.liveRecords().every((record) => record.actor.activity().phase === "idle"));
		await first.worker.dispose();

		// A new Worker has no agent tree: records were runtime state. The parent asks
		// its child for more work anyway, and the address is all it needs.
		const second = await createWorkerAt(root, [
			fauxAssistantMessage(fauxToolCall("followup_task", { target: "worker", message: "again" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("child again"),
			fauxAssistantMessage("parent again"),
		]);
		cleanups.push(() => second.worker.dispose());
		const observed = await second.worker.observeSession(
			{ projectId: second.project.id, stem: spawner.ref.stem },
			{ sink: () => {} },
		);
		await second.worker.prompt(observed.target, "resume the child", undefined, undefined);

		// The child's own file shows the new task: its transcript was reloaded from
		// the address and the follow-up was admitted as a turn.
		const childFile = resolveStemPath(second.project.sessionDir, childStem);
		// The follow-up lands as agent mail (a custom entry), not as a user turn.
		await waitFor(() =>
			SessionManager.open(childFile)
				.getBranch()
				.some(
					(entry) =>
						entry.type === "custom_message" &&
						typeof entry.content === "string" &&
						entry.content.includes("Payload:\nagain"),
				),
		);
		expect(second.worker.liveRecords().map((record) => record.ref.stem)).toContain(childStem);

		// The resumed child's answer reaches the parent, so the reload produced a
		// full agent rather than a read-only transcript.
		const parentFile = resolveStemPath(second.project.sessionDir, spawner.ref.stem);
		await waitFor(() =>
			SessionManager.open(parentFile)
				.getBranch()
				.some(
					(entry) =>
						entry.type === "custom_message" &&
						typeof entry.content === "string" &&
						entry.content.includes("Payload:\nchild again"),
				),
		);
	});

	it("tells a full-history child that the copied branch is history, not its task", async () => {
		const { worker, project, faux } = await createWorker();
		faux.setResponses([
			fauxAssistantMessage("warm up"),
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", { task_name: "worker", message: "do it", fork_turns: "all" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("child done"),
			fauxAssistantMessage("parent done"),
		]);
		// The first turn leaves a flushed branch for the fork to copy; a spawn during
		// a Session's very first turn would have nothing on disk to inherit.
		await worker.createSession(project.id, { text: "warm up", sink: () => {} });
		await waitFor(() => worker.liveRecords()[0].actor.activity().phase === "idle");
		const parentStem = worker.liveRecords()[0].ref.stem;
		const observed = await worker.observeSession({ projectId: project.id, stem: parentStem }, { sink: () => {} });
		await worker.prompt(observed.target, "delegate", undefined, undefined);

		await waitFor(() => worker.liveRecords().length === 2);
		const { child } = spawnPair(worker);
		const childFile = resolveStemPath(project.sessionDir, child.ref.stem);
		// Codex appends the boundary to the forked rollout; without it the child can
		// read an ancestor's approvals and instructions as its own.
		await waitFor(() =>
			SessionManager.open(childFile)
				.getBranch()
				.some((entry) => JSON.stringify(entry).includes("inherited parent context")),
		);
	});

	it("refuses a task name the spawner already used", async () => {
		const { worker, project, faux } = await createWorker();
		const spawn = (message: string) =>
			fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "worker", message, fork_turns: "none" }), {
				stopReason: "toolUse",
			});
		// One queue serves both Sessions: the child's first turn is requested inside
		// the spawn, so its step lands between the spawner's two calls.
		faux.setResponses([
			spawn("one"),
			fauxAssistantMessage("child done"),
			spawn("two"),
			fauxAssistantMessage("parent done"),
		]);
		await worker.createSession(project.id, { text: "delegate", sink: () => {} });

		await waitFor(() => worker.liveRecords().length === 2);
		const { spawner } = spawnPair(worker);
		// The file holds the claim, so the second spawn cannot take the address and
		// cannot overwrite the transcript that already answers to it.
		const spawnerFile = resolveStemPath(project.sessionDir, spawner.ref.stem);
		await waitFor(() =>
			SessionManager.open(spawnerFile)
				.getBranch()
				.some((entry) => JSON.stringify(entry).includes("agent path `/root/worker` is already in use")),
		);
		expect(worker.liveRecords()).toHaveLength(2);
	});

	it("trashes a subtree: a spawner takes its spawned Sessions with it", async () => {
		const { worker, project } = await createWorker();
		await worker.createSession(project.id, { text: "delegate", sink: () => {} });
		await waitFor(() => worker.liveRecords().length === 2);

		const { spawner, child } = spawnPair(worker);
		const childStem = child.ref.stem;

		await worker.trashSession({ projectId: project.id, stem: spawner.ref.stem });

		// Both leaves leave discovery: a child left behind would name a parent that
		// no longer resolves, and would keep running with no one to report to.
		const listed = (await worker.listSessions(project.id, 50, null)).sessions.map((row) => row.stem);
		expect(listed).not.toContain(spawner.ref.stem);
		expect(listed).not.toContain(childStem);
		await waitFor(() => worker.liveRecords().length === 0);
	});

	it("gives the child its canonical path as Codex's NEW_TASK envelope", async () => {
		const { worker, project } = await createWorker();
		await worker.createSession(project.id, { text: "delegate", sink: () => {} });

		await waitFor(() => worker.liveRecords().length === 2);
		const { child } = spawnPair(worker);
		const childFile = resolveStemPath(project.sessionDir, child.ref.stem);

		// Codex names the recipient and the sender in the child's first input, which
		// is how a subagent learns its own canonical path.
		await waitFor(() => {
			const texts = SessionManager.open(childFile)
				.getBranch()
				.flatMap((entry) => {
					if (entry.type !== "message" || entry.message.role !== "user") return [];
					const { content } = entry.message;
					return typeof content === "string"
						? [content]
						: content.map((part) => (part.type === "text" ? part.text : "")).filter((text) => text !== "");
				});
			return texts.includes("Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\ndo it");
		});

		// The brief precedes the envelope, so the child knows what the envelope is
		// before it reads it, and knows its answer leaves to its parent.
		await waitFor(() => {
			const entries = SessionManager.open(childFile).getBranch();
			const brief = entries.findIndex(
				(entry) =>
					entry.type === "custom_message" &&
					typeof entry.content === "string" &&
					entry.content.includes("You are an agent in a team"),
			);
			const envelope = entries.findIndex((entry) => userText(entry).includes("Message Type: NEW_TASK"));
			return brief !== -1 && envelope !== -1 && brief < envelope;
		});
	});
});

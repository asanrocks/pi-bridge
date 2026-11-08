// Process title: the grammar (pure), the width degradation (pure), and the
// real `process.title` write through a re-exec'd child on Linux.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	commandLineBudget,
	fitProcessTitle,
	formatProcessTitle,
	resolveActivity,
	type SessionActivity,
	type TitleState,
	type WorkerTitleState,
} from "../../src/host/process-title.ts";
import { createBridgeHarness } from "./harness.ts";

function activity(phase: SessionActivity["phase"], extra: Partial<SessionActivity> = {}): SessionActivity {
	return { phase, tool: null, recoverable: false, ...extra };
}

function worker(overrides: Partial<WorkerTitleState> = {}): WorkerTitleState {
	return { projects: ["acme"], sessions: [], link: "up", ...overrides };
}

function title(state: TitleState, width = 96): string {
	return fitProcessTitle(formatProcessTitle(state), width);
}

describe("process title grammar", () => {
	it("names the daemon's role and whether it has Workers", () => {
		expect(title({ daemon: { workers: 0 }, worker: null })).toBe("pi-bridge: daemon, wait");
		expect(title({ daemon: { workers: 2 }, worker: null })).toBe("pi-bridge: daemon, serve 2");
	});

	it("names a Worker's Projects and idle phase", () => {
		expect(title({ daemon: null, worker: worker() })).toBe("pi-bridge@acme: worker, idle");
	});

	it("composes both halves of a combined launch", () => {
		expect(title({ daemon: { workers: 0 }, worker: worker({ sessions: [activity("stream")] }) })).toBe(
			"pi-bridge@acme: daemon+worker, stream",
		);
	});

	it("reports the executing tool, clamped to a glance width", () => {
		expect(title({ daemon: null, worker: worker({ sessions: [activity("tool", { tool: "Bash" })] }) })).toBe(
			"pi-bridge@acme: worker, tool Bash",
		);
		expect(
			title({
				daemon: null,
				worker: worker({ sessions: [activity("tool", { tool: "mcp__server__a_long_tool" })] }),
			}),
		).toBe("pi-bridge@acme: worker, tool mcp__server__a_l");
	});

	it("marks an idle Session that wants recovery, and a lost link", () => {
		expect(title({ daemon: null, worker: worker({ sessions: [activity("idle", { recoverable: true })] }) })).toBe(
			"pi-bridge@acme: worker, recover",
		);
		expect(title({ daemon: null, worker: worker({ sessions: [activity("stream")], link: "down" }) })).toBe(
			"pi-bridge@acme: worker, offline",
		);
	});

	it("lists the Projects, collapsing the tail past three", () => {
		expect(title({ daemon: null, worker: worker({ projects: ["acme", "beta"] }) })).toBe(
			"pi-bridge@acme,beta: worker, idle",
		);
		expect(title({ daemon: null, worker: worker({ projects: ["acme", "beta", "gamma"] }) })).toBe(
			"pi-bridge@acme,beta,gamma: worker, idle",
		);
		expect(title({ daemon: null, worker: worker({ projects: ["a", "b", "c", "d", "e"] }) })).toBe(
			"pi-bridge@a,b,c+2: worker, idle",
		);
	});

	it("reports the furthest-along Session when several run at once", () => {
		const state: TitleState = {
			daemon: null,
			worker: worker({ sessions: [activity("idle"), activity("think"), activity("tool", { tool: "Edit" })] }),
		};
		expect(title(state)).toBe("pi-bridge@acme: worker, tool Edit");
	});
});

describe("process title width", () => {
	const state: TitleState = {
		daemon: null,
		worker: worker({ projects: ["acme"], sessions: [activity("tool", { tool: "Bash" })] }),
	};

	it("prefers the richest title that fits, dropping Projects before the phase", () => {
		expect(title(state, 33)).toBe("pi-bridge@acme: worker, tool Bash");
		expect(title(state, 32)).toBe("pi-bridge: worker, tool Bash");
		expect(title(state, 28)).toBe("pi-bridge: worker, tool Bash");
		expect(title(state, 17)).toBe("pi-bridge: worker");
		expect(title(state, 16)).toBe("pi-bridge");
	});

	it("never emits a title wider than the writable window", () => {
		for (let width = 1; width <= 40; width++) {
			expect(Buffer.byteLength(title(state, width))).toBeLessThanOrEqual(Math.max(width, 9));
		}
	});

	it("counts the command line the kernel gave us", () => {
		// `node cli.js --mode=daemon` = "node" + "cli.js" + "--mode=daemon" in NUL-separated bytes.
		expect(commandLineBudget("node", ["cli.js", "--mode=daemon"])).toBe(4 + 7 + 14);
		expect(commandLineBudget("pi-bridge", [])).toBe(9);
	});
});

// The re-exec cannot be observed from inside the test process (it replaces the
// image), so the harness spawns node and reads its own cmdline back.
describe("process title bootstrap", () => {
	const linux = process.platform === "linux";
	const source = new URL("../../src/host/process-title.ts", import.meta.url).pathname;

	async function runHarness(body: string): Promise<{ cmdline: string; comm: string }> {
		const dir = mkdtempSync(join(tmpdir(), "pi-bridge-title-"));
		const harness = join(dir, "harness.mjs");
		writeFileSync(
			harness,
			`import { readFileSync } from "node:fs";
import { bootstrapProcessTitle, setWorkerTitle } from ${JSON.stringify(pathToFileURL(source).href)};
${body}
const read = (name) => readFileSync(\`/proc/self/\${name}\`, "utf8");
console.log(JSON.stringify({ cmdline: read("cmdline"), comm: read("comm") }));
`,
		);
		try {
			return await new Promise((resolve, reject) => {
				const child = spawn(process.execPath, [harness], { stdio: ["ignore", "pipe", "inherit"] });
				const chunks: string[] = [];
				child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
				child.on("error", reject);
				child.on("close", () => {
					try {
						const out = chunks.join("");
						const payload = JSON.parse(out.trim()) as { cmdline: string; comm: string };
						resolve(payload);
					} catch (error) {
						reject(new Error(`harness produced no JSON (${String(error)}): ${chunks.join("")}`));
					}
				});
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it.skipIf(!linux)("re-execs for width and writes role, Project, and phase", async () => {
		const { cmdline, comm } = await runHarness(`
bootstrapProcessTitle({ enabled: true });
setWorkerTitle({ projects: ["acme"], sessions: [{ phase: "tool", tool: "Bash", recoverable: false }], link: "up" });
`);
		const label = cmdline.replace(/\0+$/, "");
		// Wider than the 16 bytes a `node harness.mjs` launch can hold, so the
		// padded argv0 did its job.
		expect(label).toBe("pi-bridge@acme: worker, tool Bash");
		expect(comm.trim()).toBe("pi-bridge@acme:");
	});

	it.skipIf(!linux)("keeps the fixed title and no state when disabled", async () => {
		const { cmdline } = await runHarness(`
bootstrapProcessTitle({ enabled: false });
setWorkerTitle({ projects: ["acme"], sessions: [], link: "up" });
`);
		expect(cmdline.replace(/\0+$/, "")).toBe("pi-bridge");
	});
});

// The phase vocabulary is only useful if pi's events actually produce it, so
// one real turn through the faux provider pins the transitions.
describe("manager activity", () => {
	const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);
	const noopTool: ToolDefinition = {
		name: "noop",
		label: "No-op",
		description: "Returns immediately.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: "ok" }], details: { id: (params as { id: string }).id } };
		},
	};

	function phasesOf(harness: {
		manager: { activity(): SessionActivity; onActivityChange(fn: () => void): () => void };
	}) {
		const seen: string[] = [];
		harness.manager.onActivityChange(() => {
			const { phase, tool } = harness.manager.activity();
			seen.push(tool === null ? phase : `${phase}:${tool}`);
		});
		return seen;
	}

	it("walks wait → stream → idle across a text turn", async () => {
		const harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("hello from the title test")],
		});
		try {
			const seen = phasesOf(harness);
			await harness.manager.prompt("hi");
			expect(seen).toContain("stream");
			expect(harness.manager.activity()).toMatchObject({ phase: "idle", tool: null });
		} finally {
			harness.cleanup();
		}
	});

	it("names the executing tool", async () => {
		const harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [
				fauxAssistantMessage(fauxToolCall("noop", { id: "1" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
			customTools: [noopTool],
		});
		try {
			const seen = phasesOf(harness);
			await harness.manager.prompt("run the tool");
			expect(seen).toContain("tool:noop");
			expect(harness.manager.activity()).toMatchObject({ phase: "idle", tool: null });
		} finally {
			harness.cleanup();
		}
	});

	it("keeps the surviving sibling's name when one of two parallel tools ends", async () => {
		// Two tools in one assistant message run in parallel: both starts are
		// emitted first, then each end as its own execution finishes. The phase
		// is one word for the batch, so the slower tool's end must not erase the
		// name of the one still running — that is the switcher's preview line.
		const releases = new Map<string, () => void>();
		const blockingTool = (name: string): ToolDefinition => ({
			name,
			label: name,
			description: "Waits until the test releases it.",
			parameters: Type.Object({ id: Type.String() }),
			async execute(_toolCallId, params) {
				const id = (params as { id: string }).id;
				await new Promise<void>((resolve) => {
					releases.set(id, resolve);
				});
				return { content: [{ type: "text", text: id }], details: { id } };
			},
		});
		const harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [
				fauxAssistantMessage([fauxToolCall("slow", { id: "slow1" }), fauxToolCall("fast", { id: "fast1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			],
			customTools: [blockingTool("slow"), blockingTool("fast")],
		});
		const waitFor = async (predicate: () => boolean): Promise<void> => {
			for (let i = 0; i < 400 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
			if (!predicate()) throw new Error("timed out waiting for the parallel tools");
		};
		// pi re-keys the provider's tool-call ids, so the observation is the
		// count of in-flight tools, not an id.
		const inFlightCount = () => Object.keys(harness.manager.document.status.inFlightTools ?? {}).length;
		try {
			const turn = harness.manager.prompt("run both");
			// Both started, the later one named.
			await waitFor(() => releases.size === 2 && inFlightCount() === 2);
			expect(harness.manager.activity()).toMatchObject({ phase: "tool", tool: "fast" });

			// The second-started tool ends first: the phase continues under the
			// first tool's name, never a generic word.
			releases.get("fast1")?.();
			await waitFor(() => inFlightCount() === 1);
			expect(harness.manager.activity()).toMatchObject({ phase: "tool", tool: "slow" });

			releases.get("slow1")?.();
			await turn;
			expect(harness.manager.activity()).toMatchObject({ phase: "idle", tool: null });
		} finally {
			harness.cleanup();
		}
	});
});

// The Document is the authority the browser renders, so the title may not
// disagree with it: a run that settles while a tool it dispatched is still
// executing must keep saying `tool`, and a streaming Session may never claim
// to be idle.
describe("activity reconciliation", () => {
	const facts = {
		phase: "idle" as const,
		tool: null,
		streaming: false,
		compacting: false,
		toolRunning: false,
		recoverable: false,
	};

	it("keeps a tool in flight past a settled run", () => {
		expect(resolveActivity({ ...facts, phase: "idle", streaming: true, toolRunning: true, tool: "Bash" })).toEqual({
			phase: "tool",
			tool: "Bash",
			recoverable: false,
		});
	});

	it("decays a stale word to waiting while the Session streams", () => {
		expect(resolveActivity({ ...facts, phase: "idle", streaming: true }).phase).toBe("wait");
		expect(resolveActivity({ ...facts, phase: "tool", streaming: true }).phase).toBe("wait");
		expect(resolveActivity({ ...facts, phase: "tool", streaming: false }).phase).toBe("idle");
		expect(resolveActivity({ ...facts, phase: "stream", streaming: true }).phase).toBe("stream");
	});

	it("reports compaction and recovery on the Document's terms", () => {
		expect(resolveActivity({ ...facts, compacting: true, streaming: true }).phase).toBe("compact");
		expect(resolveActivity({ ...facts, recoverable: true }).phase).toBe("idle");
		expect(resolveActivity({ ...facts, recoverable: true }).recoverable).toBe(true);
	});
});

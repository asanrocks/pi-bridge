import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { Patch, PatchOp } from "../../src/core/index.ts";
import { createManager, type Manager } from "../../src/host/index.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface VerbHarness {
	manager: Manager;
	faux: ReturnType<typeof registerFauxProvider>;
	patches: Patch[];
	tempCwd: string;
	tempAgentDir: string;
	cleanup: () => void;
}

async function createVerbHarness(useFixture = true): Promise<VerbHarness> {
	const tempCwd = join(tmpdir(), `pi-bridge-verbs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempCwd, { recursive: true });
	const tempAgentDir = join(tempCwd, "agent");
	mkdirSync(tempAgentDir, { recursive: true });
	const fixtureCopy = join(tempCwd, "session.jsonl");
	if (useFixture) copyFileSync(FIXTURE_URL.pathname, fixtureCopy);

	const faux = registerFauxProvider({
		models: [
			{ id: "faux-1", reasoning: true },
			{ id: "faux-2", reasoning: true },
		],
	});
	const authStorage = AuthStorage.inMemory();
	const model = faux.getModel("faux-1")!;
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage });
	await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			baseUrl: m.baseUrl,
		})),
	});
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
	} as Record<string, unknown>);
	const sessionManager = useFixture ? SessionManager.open(fixtureCopy, undefined, tempCwd) : undefined;

	const manager = await createManager({
		cwd: tempCwd,
		agentDir: tempAgentDir,
		modelRuntime,
		settingsManager,
		...(sessionManager ? { sessionManager } : {}),
		model,
	});

	const patches: Patch[] = [];
	manager.onPatch((p) => patches.push(p));

	return {
		manager,
		faux,
		patches,
		tempCwd,
		tempAgentDir,
		cleanup() {
			manager.dispose();
			faux.unregister();
			if (existsSync(tempCwd)) rmSync(tempCwd, { recursive: true, force: true });
		},
	};
}

function opsOfKind(patches: Patch[], opKind: string): PatchOp[] {
	return patches.flatMap((p) => p.ops).filter((o) => o.op === opKind);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Manager verbs", () => {
	const harnesses: VerbHarness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	// ── setModel ─────────────────────────────────────────────────────────

	it("setModel rejects invalid model", async () => {
		const h = await createVerbHarness();
		harnesses.push(h);

		await expect(h.manager.setModel("nonexistent", "no-such-model")).rejects.toThrow("Model not found");
	});

	it("setModel emits patches with model_change entry and status update", async () => {
		const h = await createVerbHarness();
		harnesses.push(h);

		h.patches.length = 0;
		await h.manager.setModel("faux", "faux-2");

		// Status model updated
		expect(h.manager.document.status.model).toEqual({ provider: "faux", modelId: "faux-2" });

		// model_change entry exists in document
		const kinds = Object.values(h.manager.document.entries).map((e) => e.kind);
		expect(kinds).toContain("model_change");

		// Patch was emitted with an add op for the new entry
		const addOps = opsOfKind(h.patches, "add");
		expect(addOps.length).toBeGreaterThan(0);
	});

	// ── setThinkingLevel ─────────────────────────────────────────────────

	it("setThinkingLevel emits event-driven status update", async () => {
		const h = await createVerbHarness();
		harnesses.push(h);

		h.patches.length = 0;
		await h.manager.setThinkingLevel("high");

		// Status thinkingLevel updated via event + reconcile
		expect(h.manager.document.status.thinkingLevel).toBe("high");
		expect(h.patches.length).toBeGreaterThan(0);
	});

	// ── renameSession ────────────────────────────────────────────────────

	it("renameSession updates status.name and emits patches", async () => {
		const h = await createVerbHarness();
		harnesses.push(h);

		h.patches.length = 0;
		await h.manager.renameSession("test-session-name");

		// Status name updated via session_info_changed event
		expect(h.manager.document.status.name).toBe("test-session-name");

		// Patches emitted (at minimum: status.name update)
		expect(h.patches.length).toBeGreaterThan(0);
	});

	// ── navigate ─────────────────────────────────────────────────────────

	it("navigate updates leafId and emits leafId patch", async () => {
		const h = await createVerbHarness();
		harnesses.push(h);

		// Navigate to the first committed entry
		const entryIds = Object.keys(h.manager.document.entries).filter((id) => !id.startsWith("pending:"));
		expect(entryIds.length).toBeGreaterThan(0);

		// Navigate to an entry that is NOT the current leaf
		const originalLeafId = h.manager.document.status.leafId;
		// Pick a non-leaf target if possible
		const nonLeafId = entryIds.find((id) => id !== originalLeafId) ?? entryIds[0];

		h.patches.length = 0;
		await h.manager.navigate(nonLeafId);

		// leafId should point to the navigation target
		expect(h.manager.document.status.leafId).toBe(nonLeafId);

		// Patch emitted for leafId change
		expect(h.patches.length).toBeGreaterThan(0);
	});

	it("navigate rejects invalid entry id", async () => {
		const h = await createVerbHarness();
		harnesses.push(h);

		await expect(h.manager.navigate("nonexistent-id")).rejects.toThrow();
	});

	// ── fresh session allocation (ADR 11) ────────────────────────────────

	it("allocates a fresh session inside the Manager's agentDir session directory", async () => {
		const h = await createVerbHarness(false);
		harnesses.push(h);

		// SessionManager.create would use the process-global agent dir; the daemon
		// computes Project session storage from its own agentDir. They must agree.
		expect(h.manager.sessionFile.startsWith(join(h.tempAgentDir, "sessions"))).toBe(true);
		expect(h.manager.sessionFile.endsWith(".jsonl")).toBe(true);
		expect(h.manager.liveSessionId.length).toBeGreaterThan(0);
	});

	// ── abort ────────────────────────────────────────────────────────────

	it("abort completes without error when idle", async () => {
		const h = await createVerbHarness();
		harnesses.push(h);

		await expect(h.manager.abort()).resolves.toBeUndefined();
	});

	it("abort during prompt does not throw and settles streaming", async () => {
		const h = await createVerbHarness();
		harnesses.push(h);

		const promptPromise = h.manager.prompt("hello");
		const abortPromise = h.manager.abort();
		await Promise.all([promptPromise, abortPromise]);

		// After abort, streaming flag should be false
		expect(h.manager.document.status.isStreaming).toBe(false);
	});

	it("prompt relays image attachments into the user message", async () => {
		const h = await createVerbHarness();
		harnesses.push(h);

		// Scripted response factory captures the request context; the last user
		// message must carry the image attachment Manager.prompt was given.
		let lastContext: Context | undefined;
		h.faux.setResponses([
			(context: Context) => {
				lastContext = context;
				return fauxAssistantMessage("ok");
			},
		]);

		await h.manager.prompt("look at this", [{ type: "image", data: "aGk=", mimeType: "image/png" }]);

		expect(lastContext).toBeDefined();
		const lastUser = [...(lastContext?.messages ?? [])].reverse().find((m) => m.role === "user");
		expect(lastUser).toBeDefined();
		const content = lastUser!.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		expect(content.some((c) => c.type === "text" && c.text === "look at this")).toBe(true);
		expect(content.some((c) => c.type === "image" && c.data === "aGk=" && c.mimeType === "image/png")).toBe(true);
	});

	// ── idle-state reconcile ─────────────────────────────────────────────

	it("setModel reconciles immediately when idle", async () => {
		const h = await createVerbHarness();
		harnesses.push(h);

		h.patches.length = 0;
		await h.manager.setModel("faux", "faux-2");

		expect(h.patches.length).toBeGreaterThan(0);
	});

	it("setThinkingLevel reconciles immediately when idle", async () => {
		const h = await createVerbHarness();
		harnesses.push(h);

		h.patches.length = 0;
		await h.manager.setThinkingLevel("high");

		expect(h.patches.length).toBeGreaterThan(0);
	});
}, 30000);

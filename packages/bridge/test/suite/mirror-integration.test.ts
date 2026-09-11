import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Document,
	DocumentMirror,
	type JsonValue,
	projectSnapshot,
	resolveFieldPath,
} from "../../src/core/index.ts";
import type { BridgeHarness } from "./harness.ts";
import {
	assertMirrorInSync,
	createBridgeHarness,
	createMirrorHarness,
	deepEqual,
	normalizeForComparison,
} from "./harness.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

/** Build PullRequestItem[] for all lazy fields in a document. */
function buildPullRequests(doc: Document): Array<{ entryId: string; fieldPath: string }> {
	const requests: Array<{ entryId: string; fieldPath: string }> = [];
	for (const [id, entry] of Object.entries(doc.entries)) {
		const prefix = `/entries/${id}`;
		if ("content" in entry && Array.isArray(entry.content)) {
			for (let i = 0; i < entry.content.length; i++) {
				const block = entry.content[i];
				if ("text" in block) requests.push({ entryId: id, fieldPath: `${prefix}/content/${i}/text` });
				if ("thinking" in block) requests.push({ entryId: id, fieldPath: `${prefix}/content/${i}/thinking` });
				if ("arguments" in block && "type" in block && block.type === "toolCall") {
					requests.push({ entryId: id, fieldPath: `${prefix}/content/${i}/arguments` });
				}
			}
		}
		if (entry.kind === "tool_result") {
			requests.push({ entryId: id, fieldPath: `${prefix}/content` });
			requests.push({ entryId: id, fieldPath: `${prefix}/details` });
		}
	}
	return requests;
}

describe("mirror integration (property-based sync)", () => {
	const harnesses: BridgeHarness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	// ── bootstrap state ────────────────────────────────────────────────────

	it("mirror matches canonical after bootstrap (empty turn)", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);
		const mh = createMirrorHarness(bh);

		assertMirrorInSync(mh, "bootstrap");

		const ids = Object.keys(mh.mirror.document.entries);
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids.filter((x) => !x.startsWith("pending:"))) {
			expect(mh.mirror.document.entries[id].parentId).toBeDefined();
			expect(mh.mirror.document.entries[id].timestamp).toBeTruthy();
		}
	});

	// ── simple turn ────────────────────────────────────────────────────────

	it("tracks a simple assistant turn end-to-end", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("Hello from the faux provider!")],
		});
		harnesses.push(bh);
		const mh = createMirrorHarness(bh);

		const patchCountBefore = bh.patches.length;

		await mh.manager.prompt("Say hello");

		expect(bh.patches.length).toBeGreaterThan(patchCountBefore);
		assertMirrorInSync(mh, "after simple turn");

		const ids = Object.keys(mh.mirror.document.entries);
		const assistantIds = ids.filter(
			(id) =>
				!id.startsWith("pending:") &&
				mh.mirror.document.entries[id].kind === "message" &&
				mh.mirror.document.entries[id].role === "assistant",
		);
		expect(assistantIds.length).toBeGreaterThan(0);

		const lastId = ids.filter((x) => !x.startsWith("pending:")).pop();
		expect(mh.mirror.document.status.leafId).toBe(lastId);
	});

	// ── tool call turn ─────────────────────────────────────────────────────

	it("tracks a tool-call turn end-to-end", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [
				fauxAssistantMessage(fauxToolCall("read", { path: "/nonexistent" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("File not found, done."),
			],
		});
		harnesses.push(bh);
		const mh = createMirrorHarness(bh);

		await mh.manager.prompt("Read /nonexistent");

		assertMirrorInSync(mh, "after tool-call turn");

		const ids = Object.keys(mh.mirror.document.entries);
		const toolResultIds = ids.filter(
			(id) => !id.startsWith("pending:") && mh.mirror.document.entries[id].kind === "tool_result",
		);
		expect(toolResultIds.length).toBeGreaterThan(0);

		const assistantIds = ids.filter(
			(id) =>
				!id.startsWith("pending:") &&
				mh.mirror.document.entries[id].kind === "message" &&
				mh.mirror.document.entries[id].role === "assistant",
		);
		expect(assistantIds.length).toBeGreaterThanOrEqual(2);

		const lastId = ids.filter((x) => !x.startsWith("pending:")).pop();
		expect(mh.mirror.document.status.leafId).toBe(lastId);
	});

	// ── multi-turn ─────────────────────────────────────────────────────────

	it("stays in sync across two consecutive turns", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("First response."), fauxAssistantMessage("Second response.")],
		});
		harnesses.push(bh);
		const mh = createMirrorHarness(bh);

		await mh.manager.prompt("First");
		assertMirrorInSync(mh, "after turn 1");

		const afterTurn1Ids = Object.keys(mh.mirror.document.entries);

		await mh.manager.prompt("Second");
		assertMirrorInSync(mh, "after turn 2");

		const afterTurn2Ids = Object.keys(mh.mirror.document.entries);
		expect(afterTurn2Ids.length).toBeGreaterThan(afterTurn1Ids.length);

		const lastId = afterTurn2Ids.filter((x) => !x.startsWith("pending:")).pop();
		expect(mh.mirror.document.status.leafId).toBe(lastId);
	});

	// ── mid-turn sync after every Patch ─────────────────────────────────────

	it("mirror matches canonical after every individual Patch", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("A response with some text content.")],
		});
		harnesses.push(bh);

		const mirror = new DocumentMirror();
		mirror.applyReplace(projectSnapshot(bh.manager.document));

		let patchIndex = 0;
		bh.manager.onPatch((patch) => {
			mirror.applyPatch(patch.ops);
			patchIndex++;

			const normMirror = normalizeForComparison(mirror.document);
			const normCanonical = normalizeForComparison(bh.manager.document);
			if (!deepEqual(normMirror, normCanonical)) {
				throw new Error(`[patch #${patchIndex}] Mirror out of sync after patch`);
			}
		});

		await bh.manager.prompt("Respond");
		expect(patchIndex).toBeGreaterThan(0);
	});

	// ── tool-call mid-turn sync ────────────────────────────────────────────

	it("mirror matches canonical after every Patch during tool-call turn", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [
				fauxAssistantMessage(fauxToolCall("read", { path: "/tmp/x" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		harnesses.push(bh);

		const mirror = new DocumentMirror();
		mirror.applyReplace(projectSnapshot(bh.manager.document));

		let patchIndex = 0;
		bh.manager.onPatch((patch) => {
			mirror.applyPatch(patch.ops);
			patchIndex++;
			const normMirror = normalizeForComparison(mirror.document);
			const normCanonical = normalizeForComparison(bh.manager.document);
			if (!deepEqual(normMirror, normCanonical)) {
				throw new Error(`[tool-call patch #${patchIndex}] Mirror out of sync`);
			}
		});

		await bh.manager.prompt("Read /tmp/x");
		expect(patchIndex).toBeGreaterThan(0);
	});

	// ── status lifecycle ───────────────────────────────────────────────────

	it("tracks status fields correctly through a turn lifecycle", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("ok")],
		});
		harnesses.push(bh);
		const mh = createMirrorHarness(bh);

		await mh.manager.prompt("ok");

		assertMirrorInSync(mh, "after status turn");

		expect(mh.mirror.document.status.isStreaming).toBe(false);
		expect(mh.mirror.document.status.leafId).toBeTruthy();
		expect(mh.mirror.document.status.leafId).not.toContain("pending:");
	});

	// ── tool result content delivered ──────────────────────────────────────

	it("mirror has real content for tool results (bus-delivered, not lazy)", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [
				fauxAssistantMessage(fauxToolCall("read", { path: "/nonexistent" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		harnesses.push(bh);
		const mh = createMirrorHarness(bh);

		await mh.manager.prompt("read");

		assertMirrorInSync(mh, "after turn");

		const ids = Object.keys(mh.mirror.document.entries);
		const toolResultIds = ids.filter(
			(id) => !id.startsWith("pending:") && mh.mirror.document.entries[id].kind === "tool_result",
		);
		expect(toolResultIds.length).toBeGreaterThan(0);

		for (const id of toolResultIds) {
			const entry = mh.mirror.document.entries[id];
			if (entry.kind === "tool_result") {
				const canonicalEntry = mh.manager.document.entries[id];
				if (canonicalEntry?.kind === "tool_result") {
					expect(entry.toolCallId).toBe(canonicalEntry.toolCallId);
					expect(entry.toolName).toBe(canonicalEntry.toolName);
					expect(entry.isError).toBe(canonicalEntry.isError);
				}
			}
		}
	});

	// ── user messages present ──────────────────────────────────────────────

	it("includes user messages in the entry list", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("got it")],
		});
		harnesses.push(bh);
		const mh = createMirrorHarness(bh);

		await mh.manager.prompt("a user message");

		assertMirrorInSync(mh, "after turn");

		const ids = Object.keys(mh.mirror.document.entries);
		const userMessages = ids.filter(
			(id) =>
				!id.startsWith("pending:") &&
				mh.mirror.document.entries[id].kind === "message" &&
				mh.mirror.document.entries[id].role === "user",
		);
		expect(userMessages.length).toBeGreaterThan(0);
	});

	// ── Patch sequence contract ───────────────────────────────────────────

	it("produces the expected Patch sequence for a simple text turn", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("Hi!")],
		});
		harnesses.push(bh);

		const mh = createMirrorHarness(bh);

		// Track the sequence of patch shapes
		const sequence: Array<{
			patchIndex: number;
			opKinds: string[];
			opPaths: string[];
		}> = [];
		let patchIdx = 0;
		bh.manager.onPatch((patch) => {
			sequence.push({
				patchIndex: patchIdx++,
				opKinds: patch.ops.map((o) => o.op),
				opPaths: patch.ops.map((o) => ("from" in o ? `${o.op}:${o.from}→${o.path}` : o.path)),
			});
		});

		await mh.manager.prompt("Say Hi!");

		assertMirrorInSync(mh, "after contract turn");

		// Phase 1: Streaming — isStreaming true, provisional entries
		const streamingOps = sequence.find((s) =>
			s.opPaths.some((p) => p === "/status/isStreaming" && s.opKinds.includes("replace")),
		);
		expect(streamingOps).toBeDefined();

		// Phase 2: Provisional entries appear (user + assistant + optional content)
		const hasUserSkeleton = sequence.some((s) =>
			s.opPaths.some((p) => p.startsWith("/entries/pending:user:") && s.opKinds.includes("add")),
		);
		expect(hasUserSkeleton).toBe(true);

		const hasAssistantSkeleton = sequence.some((s) =>
			s.opPaths.some((p) => p === "/entries/pending:message" && s.opKinds.includes("add")),
		);
		expect(hasAssistantSkeleton).toBe(true);

		// Phase 3: Text content delivered (append or replace on /entries/pending:message/content)
		const hasTextContent = sequence.some((s) =>
			s.opPaths.some((p) => p.startsWith("/entries/pending:message/content")),
		);
		expect(hasTextContent).toBe(true);

		// Phase 4: Seal — move from pending:message to real id, add metadata
		const hasMove = sequence.some((s) => s.opKinds.includes("move"));
		expect(hasMove).toBe(true);

		const hasMetadata = sequence.some((s) =>
			s.opPaths.some(
				(p) =>
					p.includes("/stopReason") || p.includes("/api") || p.includes("/parentId") || p.includes("/timestamp"),
			),
		);
		expect(hasMetadata).toBe(true);

		// Phase 5: Settle — isStreaming false
		const settledPatch = sequence.find((s) =>
			s.opPaths.some((p) => p === "/status/isStreaming" && s.opKinds.includes("replace")),
		);
		expect(settledPatch).toBeDefined();

		// Verify ordering: streaming starts before seal
		const moveIdx = sequence.findIndex((s) => s.opKinds.includes("move"));
		const streamIdx = sequence.findIndex((s) =>
			s.opPaths.some((p) => p === "/status/isStreaming" && s.opKinds.includes("replace")),
		);
		expect(streamIdx).toBeLessThan(moveIdx);

		// No provisional entries left in the final document
		const provisionals = Object.keys(mh.mirror.document.entries).filter((id) => id.startsWith("pending:"));
		expect(provisionals).toEqual([]);
	});

	// ── reconnect flow ────────────────────────────────────────────────────

	it("reconnect: mirror recovers fully via Init + needsPull + ingestPullResponse", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("Hello from the faux provider!")],
		});
		harnesses.push(bh);

		// Run a turn to populate the canonical document
		await bh.manager.prompt("Say hello");

		// Simulate reconnect: fresh mirror, Init snapshot (lazy fields null)
		const reconnected = new DocumentMirror();
		reconnected.applyReplace(projectSnapshot(bh.manager.document));

		const canonical = bh.manager.document;

		// Verify lazy fields are null after Init (text is eager, not null)
		for (const [_id, entry] of Object.entries(reconnected.document.entries)) {
			if ("content" in entry && Array.isArray(entry.content)) {
				for (let i = 0; i < entry.content.length; i++) {
					const block = entry.content[i];
					if ("text" in block) expect(typeof block.text).toBe("string");
					if ("thinking" in block) expect(block.thinking).toBeNull();
					if ("arguments" in block && "type" in block && block.type === "toolCall") {
						expect(block.arguments).toBeNull();
					}
				}
			}
			if (entry.kind === "tool_result") {
				expect(entry.content).toBeNull();
				expect(entry.details).toBeNull();
			}
		}

		// Build pull requests: find all null lazy fields
		const wants = reconnected.needsPull(buildPullRequests(reconnected.document));
		expect(wants.length).toBeGreaterThan(0);

		// Resolve values from canonical
		const values = wants.map((w) => {
			const canonicalEntry = canonical.entries[w.entryId];
			const value = resolveFieldPath(canonicalEntry as unknown as Record<string, unknown>, w.fieldPath) as JsonValue;
			return { ...w, value };
		});

		reconnected.ingestPullResponse(values);

		// After pull, the reconnected mirror matches canonical
		const normReconnected = normalizeForComparison(reconnected.document);
		const normCanonical = normalizeForComparison(canonical);
		expect(deepEqual(normReconnected, normCanonical)).toBe(true);

		// All lazy fields that are non-null in canonical are now populated
		const stillNeeded = reconnected.needsPull(buildPullRequests(reconnected.document));
		for (const r of stillNeeded) {
			const cv = resolveFieldPath(canonical.entries[r.entryId] as unknown as Record<string, unknown>, r.fieldPath);
			expect(cv).toBeNull(); // only fields that are null in canonical remain
		}
	});
}, 60000);

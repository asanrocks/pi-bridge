// ============================================================================
// Manual compaction (`Manager.compact`, the `compact` verb's host half).
//
// The interesting properties are not the happy path alone: pi's `compact()`
// aborts the turn first (so the Manager must refuse while one runs), it emits
// `compaction_start`/`compaction_end` around a summary request (so a Stop is a
// cancellation, not a corruption), and it appends one entry at the very end
// (so a failed attempt leaves the session untouched).
// ============================================================================

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionEntry } from "../../src/core/index.ts";
import { type BridgeHarness, createBridgeHarness } from "./harness.ts";

const BEFORE_COMPACTION = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

// A tiny budget forces a cut on any fixture: the test is about the verb, not
// pi's cut-point arithmetic (which its own suite covers).
const COMPACTABLE = { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1 } };

let harness: BridgeHarness | null = null;

afterEach(() => {
	harness?.cleanup();
	harness = null;
});

function compactions(): CompactionEntry[] {
	return Object.values(harness?.manager.document.entries ?? {}).filter(
		(entry): entry is CompactionEntry => entry.kind === "compaction",
	);
}

/** A session file with nothing compactable in it: just the header. */
function writeEmptySession(dir: string): string {
	const path = join(dir, "empty.jsonl");
	writeFileSync(
		path,
		`${JSON.stringify({
			type: "session",
			id: "empty-session",
			timestamp: new Date(0).toISOString(),
			cwd: dir,
		})}\n`,
	);
	return path;
}

describe("manual compaction", () => {
	it("appends the summary and reports the post-compaction context size", async () => {
		const summaryPrompts: string[] = [];
		harness = await createBridgeHarness({
			fixturePath: BEFORE_COMPACTION.pathname,
			settings: COMPACTABLE,
			responses: [
				((context) => {
					summaryPrompts.push(JSON.stringify(context.messages));
					return fauxAssistantMessage("Earlier work, summarized.");
				}) satisfies FauxResponseStep,
			],
		});

		const leafBefore = harness.manager.document.status.leafId;
		const before = compactions().length;
		const result = await harness.manager.compact("focus on the transport layer");

		expect(result.tokensBefore).toBeGreaterThan(0);
		expect(compactions()).toHaveLength(before + 1);
		const appended = compactions().find((entry) => entry.parentId === leafBefore);
		expect(appended?.summary).toContain("Earlier work, summarized.");
		expect(appended?.tokensBefore).toBe(result.tokensBefore);
		// pi records the summary request's usage; the ledger counts it.
		expect(appended?.usage).not.toBeNull();
		// pi reports the window unknown until the next response (the last trusted
		// usage predates the boundary); the readout shows the projection estimate
		// instead, which is what the run itself reported as its result, marked so
		// the UI never presents it as a measurement.
		const usage = harness.manager.document.status.contextUsage;
		expect(usage?.tokens).toBe(result.estimatedTokensAfter);
		expect(usage?.tokens).toBeLessThan(result.tokensBefore);
		expect(usage?.percent).toBeGreaterThan(0);
		expect(usage?.estimated).toBe(true);
		// The draft instructions reached the summarization request.
		expect(summaryPrompts.join("")).toContain("focus on the transport layer");

		const busy = harness.ops
			.filter((op) => op.path === "/status/isCompacting")
			.map((op) => ("value" in op ? op.value : null));
		expect(busy).toEqual([true, false]);
	});

	it("clears the estimate once a response settles after the boundary", async () => {
		harness = await createBridgeHarness({
			fixturePath: BEFORE_COMPACTION.pathname,
			settings: COMPACTABLE,
			responses: [fauxAssistantMessage("a summary"), fauxAssistantMessage("after the boundary")],
		});

		await harness.manager.compact();
		expect(harness.manager.document.status.contextUsage?.estimated).toBe(true);

		await harness.manager.prompt("next");
		await vi.waitFor(() => expect(harness?.manager.document.status.contextUsage?.estimated).toBe(false));
		expect(harness.manager.document.status.contextUsage?.tokens).toBeGreaterThan(0);
	});

	it("refuses while a turn is running (pi's compact() would abort it)", async () => {
		harness = await createBridgeHarness({
			fixturePath: BEFORE_COMPACTION.pathname,
			settings: COMPACTABLE,
			tokensPerSecond: 20,
			responses: [fauxAssistantMessage("a".repeat(400)), fauxAssistantMessage("unused summary")],
		});

		const run = harness.manager.prompt("keep going");
		await vi.waitFor(() => expect(harness?.manager.document.status.isStreaming).toBe(true));
		await expect(harness.manager.compact()).rejects.toThrow(/turn is running/);
		await harness.manager.abort();
		await run.catch(() => {});
		expect(compactions()).toHaveLength(2);
	});

	it("refuses a session with nothing to compact", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bridge-empty-"));
		try {
			harness = await createBridgeHarness({
				fixturePath: writeEmptySession(dir),
				settings: COMPACTABLE,
			});
			await expect(harness.manager.compact()).rejects.toThrow(/Nothing to compact/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a second compaction with nothing appended since", async () => {
		harness = await createBridgeHarness({
			fixturePath: BEFORE_COMPACTION.pathname,
			settings: COMPACTABLE,
			responses: [fauxAssistantMessage("first summary")],
		});
		await harness.manager.compact();
		await expect(harness.manager.compact()).rejects.toThrow(/Already compacted/);
	});

	it("a Stop cancels the summary and leaves the session as it was", async () => {
		harness = await createBridgeHarness({
			fixturePath: BEFORE_COMPACTION.pathname,
			settings: COMPACTABLE,
			tokensPerSecond: 20,
			responses: [fauxAssistantMessage("slow summary ".repeat(40))],
		});

		const before = compactions().length;
		const leafBefore = harness.manager.document.status.leafId;
		const run = harness.manager.compact();
		await vi.waitFor(() => expect(harness?.manager.document.status.isCompacting).toBe(true));
		await harness.manager.abort();

		await expect(run).rejects.toThrow(/cancel/i);
		expect(harness.manager.document.status.isCompacting).toBe(false);
		expect(harness.manager.document.status.leafId).toBe(leafBefore);
		expect(compactions()).toHaveLength(before);
	});
});

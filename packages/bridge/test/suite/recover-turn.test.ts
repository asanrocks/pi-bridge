// ============================================================================
// Broken-tail recovery (ADR 16): unit tests of the pure derivation,
// and integration tests of the Manager's recoverTurn verb through the full
// faux-provider event pipeline.
// ============================================================================

import { existsSync, readFileSync, rmSync } from "node:fs";
import { type AssistantMessage, type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { deriveStatus } from "../../src/core/document.ts";
import {
	type Content,
	computeRecoverableTurn,
	type Document,
	type Entry,
	type MessageEntry,
} from "../../src/core/index.ts";
import { buildInterruptedToolsRelay } from "../../src/core/recovery.ts";
import type { BridgeHarness } from "./harness.ts";
import { assertMirrorInSync, createBridgeHarness, createMirrorHarness } from "./harness.ts";

const BEFORE_COMPACTION = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);
const INTERRUPTED_TOOLS = new URL("../fixtures/interrupted-tools.jsonl", import.meta.url);
const UNFINISHED_TURN = new URL("../fixtures/unfinished-turn.jsonl", import.meta.url);
const STOPPED_MID_TOOL = new URL("../fixtures/stopped-mid-tool.jsonl", import.meta.url);
const ABORTED_TURN = new URL("../fixtures/aborted-turn.jsonl", import.meta.url);

// ---------------------------------------------------------------------------
// Unit helpers: linear-chain Documents
// ---------------------------------------------------------------------------

const ts = (i: number) => new Date(1_700_000_000_000 + i * 1000).toISOString();

function userEntry(id: string, text: string): Entry {
	return {
		kind: "message",
		id,
		parentId: null,
		timestamp: ts(0),
		role: "user",
		content: [{ type: "text", text }],
	};
}

function assistantEntry(
	id: string,
	options: {
		stopReason?: string;
		toolCalls?: { id: string; name: string; arguments?: Record<string, unknown> }[];
		text?: string;
	} = {},
): Entry {
	const content: Content[] = [];
	if (options.text !== undefined) content.push({ type: "text", text: options.text });
	for (const call of options.toolCalls ?? []) {
		content.push({
			type: "toolCall",
			id: call.id,
			name: call.name,
			arguments: (call.arguments ?? {}) as never,
		});
	}
	return {
		kind: "message",
		id,
		parentId: null,
		timestamp: ts(1),
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "faux",
		model: "faux-1",
		stopReason: options.stopReason ?? "stop",
	};
}

function toolResultEntry(id: string, toolCallId: string, text: string, options: { isError?: boolean } = {}): Entry {
	return {
		kind: "tool_result",
		id,
		parentId: null,
		timestamp: ts(2),
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		details: {},
		isError: options.isError ?? false,
	};
}

function bashEntry(id: string, command: string, output: string, excludeFromContext = false): Entry {
	return {
		kind: "bash_execution",
		id,
		parentId: null,
		timestamp: ts(3),
		command,
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		fullOutputPath: null,
		excludeFromContext,
	};
}

function stampEntry(id: string): Entry {
	return { kind: "custom", id, parentId: null, timestamp: ts(4), customType: "pi.git.stamps.v2", data: {} };
}

/** Build a Document from a linear chain: each entry's parent is the previous. */
function chainDoc(...entries: Entry[]): Document {
	const map: Record<string, Entry> = {};
	let prev: string | null = null;
	for (const entry of entries) {
		map[entry.id] = { ...entry, parentId: prev };
		prev = entry.id;
	}
	const status = deriveStatus(map);
	return { status, entries: map };
}

function findMessage(doc: Document, pred: (e: MessageEntry) => boolean): MessageEntry | undefined {
	for (const e of Object.values(doc.entries)) {
		if (e.kind === "message" && pred(e)) return e;
	}
	return undefined;
}

function messageText(entry: MessageEntry): string {
	return entry.content
		.filter((c): c is Extract<Content, { type: "text" }> => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/** Entry ids on the current leaf path, root → leaf. */
function leafPathIds(doc: Document): string[] {
	const ids: string[] = [];
	let cursor = doc.status.leafId;
	while (cursor !== null) {
		ids.push(cursor);
		cursor = doc.entries[cursor]?.parentId ?? null;
	}
	return ids.reverse();
}

/** Resolve once the Document's isStreaming flips to `value` — patch-driven,
 * so the wait is deterministic (no polling). */
function streamingBecomes(bh: BridgeHarness, value: boolean): Promise<void> {
	return new Promise((resolve) => {
		const off = bh.manager.onPatch((patch) => {
			if (patch.ops.some((op) => op.op === "replace" && op.path === "/status/isStreaming" && op.value === value)) {
				off();
				resolve();
			}
		});
	});
}

/** A faux response that stays pending until released — or until the request
 * aborts, which resolves it so abort/dispose can complete. Keeps a recovery
 * run observably in flight across an await. */
function gatedResponse(): { step: FauxResponseStep; release: () => void } {
	let release: () => void = () => {};
	const step: FauxResponseStep = (_context, options) =>
		new Promise<AssistantMessage>((resolve) => {
			const aborted = () => resolve(fauxAssistantMessage("(aborted)", { stopReason: "aborted" }));
			if (options?.signal?.aborted) return aborted();
			options?.signal?.addEventListener("abort", aborted, { once: true });
			release = () => resolve(fauxAssistantMessage("Recovered late."));
		});
	return { step, release: () => release() };
}

// ---------------------------------------------------------------------------
// Unit: computeRecoverableTurn
// ---------------------------------------------------------------------------

describe("computeRecoverableTurn", () => {
	it("derives failedTurn from a terminal error tail", () => {
		const doc = chainDoc(userEntry("u1", "hi"), assistantEntry("a1", { stopReason: "error" }));
		expect(computeRecoverableTurn(doc)).toEqual({ kind: "failedTurn", entryId: "a1" });
	});

	it("keeps failedTurn when only metadata follows the error", () => {
		const doc = chainDoc(userEntry("u1", "hi"), assistantEntry("a1", { stopReason: "error" }), stampEntry("s1"));
		expect(computeRecoverableTurn(doc)?.kind).toBe("failedTurn");
	});

	it("drops failedTurn once context-bearing work follows the error", () => {
		const doc = chainDoc(
			userEntry("u1", "hi"),
			assistantEntry("a1", { stopReason: "error" }),
			bashEntry("b1", "git status", "clean"),
		);
		expect(computeRecoverableTurn(doc)).toBeNull();
	});

	it("returns null for a normally completed tail", () => {
		const doc = chainDoc(userEntry("u1", "hi"), assistantEntry("a1", { text: "done" }));
		expect(computeRecoverableTurn(doc)).toBeNull();
	});

	it("derives failedTurn from an aborted tail (user Stop or dispose-abort are indistinguishable)", () => {
		const doc = chainDoc(userEntry("u1", "hi"), assistantEntry("a1", { stopReason: "aborted" }));
		expect(computeRecoverableTurn(doc)).toEqual({ kind: "failedTurn", entryId: "a1" });
	});

	it("keeps an aborted tail unrecoverable once context-bearing work follows it", () => {
		const doc = chainDoc(
			userEntry("u1", "hi"),
			assistantEntry("a1", { stopReason: "aborted" }),
			bashEntry("b1", "git status", "clean"),
		);
		expect(computeRecoverableTurn(doc)).toBeNull();
	});

	it("prefers interruptedTools over the abort marker when calls are left dangling", () => {
		// A mid-batch abort: pi's sequential execution answers what finished,
		// the aborted assistant follows, and the unstarted call dangles.
		const doc = chainDoc(
			userEntry("u1", "list and build"),
			assistantEntry("a1", {
				stopReason: "toolUse",
				toolCalls: [
					{ id: "tc-ls", name: "bash" },
					{ id: "tc-make", name: "bash" },
				],
			}),
			toolResultEntry("r1", "tc-ls", "src"),
			assistantEntry("a2", { stopReason: "aborted" }),
		);
		const info = computeRecoverableTurn(doc);
		expect(info?.kind).toBe("interruptedTools");
		expect(info?.entryId).toBe("a1");
	});

	it("derives interruptedTools when a run ended at a terminated tool — whatever the marker's stopReason", () => {
		// The real abort shape (captured from a live session): the abort kills
		// the in-flight bash first — its error result ("Command aborted") lands
		// last — and the marker assistant surfaces as stopReason "error" with
		// "This operation was aborted", not "aborted". The shape, not the
		// label, is the signature. Side effects are uncertain — same treatment
		// as dangling calls: branch past the marker (the terminated result stays
		// on the path for the agent to read) and re-prompt with "Continue.".
		const doc = chainDoc(
			userEntry("u1", "build"),
			assistantEntry("a1", {
				stopReason: "toolUse",
				toolCalls: [{ id: "tc-make", name: "bash", arguments: { command: "make build" } }],
			}),
			toolResultEntry("r1", "tc-make", "Linking...\nCommand aborted", { isError: true }),
			assistantEntry("a2", { stopReason: "error" }),
		);
		expect(computeRecoverableTurn(doc)).toEqual({ kind: "interruptedTools", entryId: "a2" });

		// The same shape with an "aborted" marker (streams that classify the
		// AbortError) is also interruptedTools.
		const abortedMarker = chainDoc(
			userEntry("u1", "build"),
			assistantEntry("a1", {
				stopReason: "toolUse",
				toolCalls: [{ id: "tc-make", name: "bash", arguments: { command: "make build" } }],
			}),
			toolResultEntry("r1", "tc-make", "Operation aborted", { isError: true }),
			assistantEntry("a2", { stopReason: "aborted" }),
		);
		expect(computeRecoverableTurn(abortedMarker)).toEqual({ kind: "interruptedTools", entryId: "a2" });
	});

	it("keeps an error marker with streamed text a failedTurn — the run had moved past the tool", () => {
		// An ordinary tool error, then the assistant was answering when the
		// user stopped: the marker carries partial text, so the tool was not
		// in flight at termination. Retry regenerates from the completed
		// (failed) result — no Continue turn.
		const doc = chainDoc(
			userEntry("u1", "build"),
			assistantEntry("a1", {
				stopReason: "toolUse",
				toolCalls: [{ id: "tc-make", name: "bash", arguments: { command: "make build" } }],
			}),
			toolResultEntry("r1", "tc-make", "Command exited with code 1", { isError: true }),
			assistantEntry("a2", { stopReason: "aborted", text: "The build failed because" }),
		);
		expect(computeRecoverableTurn(doc)).toEqual({ kind: "failedTurn", entryId: "a2" });
	});

	it("keeps a stop after clean tool results a failedTurn (an early tool error is not a termination)", () => {
		const doc = chainDoc(
			userEntry("u1", "build"),
			assistantEntry("a1", {
				stopReason: "toolUse",
				toolCalls: [
					{ id: "tc-ls", name: "bash" },
					{ id: "tc-make", name: "bash" },
				],
			}),
			toolResultEntry("r1", "tc-ls", "not found", { isError: true }),
			toolResultEntry("r2", "tc-make", "build ok"),
			assistantEntry("a2", { stopReason: "aborted" }),
		);
		expect(computeRecoverableTurn(doc)).toEqual({ kind: "failedTurn", entryId: "a2" });
	});

	it("returns null for a bare user tail", () => {
		const doc = chainDoc(userEntry("u1", "hi"));
		expect(computeRecoverableTurn(doc)).toBeNull();
	});

	it("derives interruptedTools from partially answered tool calls", () => {
		const doc = chainDoc(
			userEntry("u1", "list and build"),
			assistantEntry("a1", {
				stopReason: "toolUse",
				toolCalls: [
					{ id: "tc-ls", name: "bash", arguments: { command: "ls" } },
					{ id: "tc-make", name: "bash", arguments: { command: "make build" } },
				],
			}),
			toolResultEntry("r1", "tc-ls", "src\ntest"),
		);
		const info = computeRecoverableTurn(doc);
		expect(info).toEqual({ kind: "interruptedTools", entryId: "a1" });
	});

	it("derives interruptedTools when no results exist at all", () => {
		const doc = chainDoc(
			userEntry("u1", "build"),
			assistantEntry("a1", { stopReason: "toolUse", toolCalls: [{ id: "tc-1", name: "bash" }] }),
		);
		expect(computeRecoverableTurn(doc)?.kind).toBe("interruptedTools");
	});

	it("bounds the relay while retaining completed and unknown tool records", () => {
		const calls = Array.from({ length: 16 }, (_, index) => ({
			id: `tc-${index}`,
			name: "bash",
			arguments: { command: "x".repeat(10_000) },
		}));
		const entries: Entry[] = [
			userEntry("u1", "run these tools"),
			assistantEntry("a1", { stopReason: "toolUse", toolCalls: calls }),
			...calls.slice(0, 8).map((call, index) => toolResultEntry(`r${index}`, call.id, "y".repeat(10_000))),
		];
		const doc = chainDoc(...entries);
		const info = computeRecoverableTurn(doc)!;
		const relay = buildInterruptedToolsRelay(doc, info);

		expect(info.kind).toBe("interruptedTools");
		expect(relay.length).toBeLessThan(12_500);
		expect(relay).toContain("[truncated]");
		expect(relay).toContain('"completed"');
		expect(relay).toContain('"unknown"');
	});

	it("derives unfinishedTurn when all tool calls are answered but no final assistant exists", () => {
		const doc = chainDoc(
			userEntry("u1", "build"),
			assistantEntry("a1", {
				stopReason: "toolUse",
				toolCalls: [{ id: "tc-build", name: "bash", arguments: { command: "make build" } }],
			}),
			toolResultEntry("r1", "tc-build", "build ok"),
		);
		expect(computeRecoverableTurn(doc)).toEqual({ kind: "unfinishedTurn", entryId: "a1" });
	});

	it("keeps unfinishedTurn regardless of trailing metadata or bash entries (nothing is discarded)", () => {
		const doc = chainDoc(
			userEntry("u1", "build"),
			assistantEntry("a1", {
				stopReason: "toolUse",
				toolCalls: [{ id: "tc-build", name: "bash" }],
			}),
			toolResultEntry("r1", "tc-build", "build ok"),
			bashEntry("b1", "git status", "clean"),
			stampEntry("s1"),
		);
		expect(computeRecoverableTurn(doc)?.kind).toBe("unfinishedTurn");
	});

	it("derives no unfinishedTurn for a run that reached its final assistant", () => {
		const doc = chainDoc(
			userEntry("u1", "build"),
			assistantEntry("a1", {
				stopReason: "toolUse",
				toolCalls: [{ id: "tc-build", name: "bash" }],
			}),
			toolResultEntry("r1", "tc-build", "build ok"),
			assistantEntry("a2", { text: "done" }),
		);
		expect(computeRecoverableTurn(doc)).toBeNull();
	});

	// Safe by construction, not by loss: pi's request-time transform
	// (pi-ai transform-messages) answers unresolved calls with synthetic
	// "No result provided" error results, so the later prompt was served —
	// the dangling batch never reaches a provider malformed. Recovery stays
	// tail-scoped so it never discards the newer turns to re-orient an
	// interruption the provider never sees.
	it("ignores dangling tool calls from a run the conversation moved past", () => {
		const doc = chainDoc(
			userEntry("u1", "build"),
			assistantEntry("a1", {
				stopReason: "toolUse",
				toolCalls: [
					{ id: "tc-ls", name: "bash" },
					{ id: "tc-make", name: "bash" },
				],
			}),
			toolResultEntry("r1", "tc-ls", "src"),
			assistantEntry("a2", { stopReason: "aborted" }),
			// The user moved on with a new turn that completed normally.
			userEntry("u2", "never mind, do this instead"),
			assistantEntry("a3", { text: "done" }),
		);
		expect(computeRecoverableTurn(doc)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Integration: recoverTurn through the Manager + faux provider
// ---------------------------------------------------------------------------

const harnesses: BridgeHarness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
});

describe("recoverTurn (integration)", () => {
	it("reports failedTurn after a terminal error and recovers by branching past it", async () => {
		const bh = await createBridgeHarness({
			fixturePath: BEFORE_COMPACTION.pathname,
			responses: [
				fauxAssistantMessage("broken", { stopReason: "error", errorMessage: "persistent 529" }),
				fauxAssistantMessage("Recovered response."),
			],
			settings: {
				retry: { enabled: false, provider: { maxRetries: 0 } },
			},
		});
		harnesses.push(bh);
		const mh = createMirrorHarness(bh);

		await bh.manager.prompt("hello");
		expect(bh.manager.document.status.recoverableTurn).toBe("failedTurn");

		// The error assistant is the tail.
		const errorEntryId = bh.manager.document.status.leafId!;
		const errorEntry = findMessage(bh.manager.document, (e) => e.id === errorEntryId)!;
		expect(errorEntry.stopReason).toBe("error");

		const action = await bh.manager.recoverTurn();
		expect(action).toBe("retry");

		const doc = bh.manager.document;
		expect(doc.status.isStreaming).toBe(false);
		expect(doc.status.recoverableTurn).toBeNull();
		const path = leafPathIds(doc);
		// The error entry is off the path; the recovered assistant is on it.
		expect(path).not.toContain(errorEntryId);
		const recovered = findMessage(doc, (e) => e.role === "assistant" && messageText(e) === "Recovered response.");
		expect(recovered).toBeDefined();
		expect(path).toContain(recovered!.id);
		expect(doc.status.leafId).toBe(recovered!.id);

		assertMirrorInSync(mh, "after recoverTurn (retry)");
	});

	// The logged failure (log-raw, 2026-10-16 10:06): after a user Stop of a
	// normal run, every recoverTurn continuation died within ~20ms with
	// "This operation was aborted". AgentSession's per-run abort flag is set
	// by Stop and — before the core fix — reset only by _startRun, so the
	// wrapper-less agent.continue() started with the stale flag set and the
	// agent_start handler killed the fresh run instantly.
	it("a retry after a user Stop is not instantly aborted by the stale stop flag", async () => {
		const until = async (pred: () => boolean) => {
			for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
			if (!pred()) throw new Error("condition not reached");
		};
		const bh = await createBridgeHarness({
			fixturePath: BEFORE_COMPACTION.pathname,
			responses: [
				fauxAssistantMessage("A slow reply that will be stopped mid-stream."),
				fauxAssistantMessage("Recovered response."),
			],
			tokensPerSecond: 50,
			settings: {
				retry: { enabled: false, provider: { maxRetries: 0 } },
			},
		});
		harnesses.push(bh);

		const promptP = bh.manager.prompt("hello").then(
			() => {},
			() => {},
		);
		// Stop the run mid-stream. The aborted marker becomes a failedTurn
		// tail, and the Stop leaves pi's internal abort flag set.
		await until(() => bh.manager.document.status.isStreaming);
		await bh.manager.abort();
		await promptP;
		expect(bh.manager.document.status.recoverableTurn).toBe("failedTurn");

		const action = await bh.manager.recoverTurn();
		expect(action).toBe("retry");

		// The continuation must actually run: the scripted response lands on
		// the branch, and no instant "This operation was aborted" error
		// re-arms the affordance.
		const doc = bh.manager.document;
		expect(doc.status.recoverableTurn).toBeNull();
		const recovered = findMessage(doc, (e) => e.role === "assistant" && messageText(e) === "Recovered response.");
		expect(recovered).toBeDefined();
		expect(doc.status.leafId).toBe(recovered!.id);
	});

	it("re-arms and leaves idle state when the retried run itself fails", async () => {
		const bh = await createBridgeHarness({
			fixturePath: BEFORE_COMPACTION.pathname,
			responses: [
				fauxAssistantMessage("broken", { stopReason: "error", errorMessage: "persistent 529" }),
				fauxAssistantMessage("still broken", { stopReason: "error", errorMessage: "still 529" }),
			],
			settings: {
				retry: { enabled: false, provider: { maxRetries: 0 } },
			},
		});
		harnesses.push(bh);
		const mh = createMirrorHarness(bh);

		await bh.manager.prompt("hello");
		expect(bh.manager.document.status.recoverableTurn).toBe("failedTurn");

		// The retried run errors again. The bypassed agent.continue() fires
		// no agent_settled, so the Manager's compensation must still reset
		// isStreaming and re-derive the recovery kind.
		const action = await bh.manager.recoverTurn();
		expect(action).toBe("retry");

		const doc = bh.manager.document;
		expect(doc.status.isStreaming).toBe(false);
		expect(doc.status.isCompacting).toBe(false);
		expect(doc.status.recoverableTurn).toBe("failedTurn");
		assertMirrorInSync(mh, "after failed retry");
	});

	it("relays completed results and unknown calls when recovering dangling tools", async () => {
		let providerUserMessages: string[] = [];
		const bh = await createBridgeHarness({
			fixturePath: INTERRUPTED_TOOLS.pathname,
			responses: [
				(context) => {
					providerUserMessages = context.messages.flatMap((message) => {
						if (message.role !== "user") return [];
						if (typeof message.content === "string") return [message.content];
						return [
							message.content
								.filter((block) => block.type === "text")
								.map((block) => block.text)
								.join("\n"),
						];
					});
					return fauxAssistantMessage("Build resumed.");
				},
			],
		});
		harnesses.push(bh);
		const mh = createMirrorHarness(bh);

		// The resumed session's first paint already carries the recovery kind.
		expect(bh.manager.document.status.recoverableTurn).toBe("interruptedTools");

		const danglingId = "e-asst-1";
		const action = await bh.manager.recoverTurn();
		expect(action).toBe("continue");

		const doc = bh.manager.document;
		expect(doc.status.recoverableTurn).toBeNull();
		const path = leafPathIds(doc);
		expect(path).not.toContain(danglingId);

		// The recovery re-prompts with a visible "Continue." user message and
		// carries completed results that branching removes from active context.
		const relay = findMessage(doc, (e) => e.role === "user" && messageText(e).startsWith("Continue."));
		expect(relay).toBeDefined();
		const relayText = messageText(relay!);
		expect(relayText).toContain("src\\ntest\\npackage.json");
		expect(relayText).toContain("toolu_make_001");
		expect(relayText).toContain("unknown outcomes");
		expect(providerUserMessages.join("\n")).toContain(relayText);
		expect(path).toContain(relay!.id);

		// The recovered assistant landed on the new branch.
		const recovered = findMessage(doc, (e) => e.role === "assistant" && messageText(e) === "Build resumed.");
		expect(recovered).toBeDefined();
		expect(path).toContain(recovered!.id);

		assertMirrorInSync(mh, "after recoverTurn (resume)");
	});

	it("continues an unfinished run from its valid tail — no branch, no message", async () => {
		const bh = await createBridgeHarness({
			fixturePath: UNFINISHED_TURN.pathname,
			responses: [fauxAssistantMessage("Build finished cleanly.")],
		});
		harnesses.push(bh);
		const mh = createMirrorHarness(bh);

		// The resumed session's first paint already carries the recovery kind.
		expect(bh.manager.document.status.recoverableTurn).toBe("unfinishedTurn");

		const assistantId = "f-asst-1";
		const resultId = "f-res-build";
		const action = await bh.manager.recoverTurn();
		expect(action).toBe("retry");

		const doc = bh.manager.document;
		expect(doc.status.recoverableTurn).toBeNull();
		const path = leafPathIds(doc);
		// No branch: the answered tool turn stays on the path.
		expect(path).toContain(assistantId);
		expect(path).toContain(resultId);

		// The continued assistant appended seamlessly after the tool result —
		// the transcript is indistinguishable from an uninterrupted run, and
		// no relay user message was added.
		const finalEntry = findMessage(
			doc,
			(e) => e.role === "assistant" && messageText(e) === "Build finished cleanly.",
		);
		expect(finalEntry).toBeDefined();
		expect(path).toContain(finalEntry!.id);
		expect(doc.status.leafId).toBe(finalEntry!.id);
		// The continued assistant lands after the tool result on the same path
		// (pi may append metadata entries — e.g. a restored thinking-level
		// change — in between; that is not a branch).
		expect(path.indexOf(resultId)).toBeLessThan(path.indexOf(finalEntry!.id));
		const relay = findMessage(doc, (e) => e.role === "user" && messageText(e).includes("interrupted"));
		expect(relay).toBeUndefined();

		assertMirrorInSync(mh, "after recoverTurn (continue)");
	});

	it("recovers an aborted tail by branching past the aborted message", async () => {
		const bh = await createBridgeHarness({
			fixturePath: ABORTED_TURN.pathname,
			responses: [fauxAssistantMessage("Regenerated answer.")],
		});
		harnesses.push(bh);
		const mh = createMirrorHarness(bh);

		// The aborted tail (user Stop or dispose-abort) derives failedTurn.
		expect(bh.manager.document.status.recoverableTurn).toBe("failedTurn");

		const action = await bh.manager.recoverTurn();
		expect(action).toBe("retry");

		const doc = bh.manager.document;
		expect(doc.status.recoverableTurn).toBeNull();
		const path = leafPathIds(doc);
		// The aborted entry is off the path; the regenerated answer is on it.
		expect(path).not.toContain("g-asst-1");
		const regenerated = findMessage(doc, (e) => e.role === "assistant" && messageText(e) === "Regenerated answer.");
		expect(regenerated).toBeDefined();
		expect(path).toContain(regenerated!.id);
		expect(doc.status.leafId).toBe(regenerated!.id);

		assertMirrorInSync(mh, "after recoverTurn (aborted)");
	});

	it("sends a visible Continue when a stop terminated the in-flight tool mid-run", async () => {
		const bh = await createBridgeHarness({
			fixturePath: STOPPED_MID_TOOL.pathname,
			responses: [fauxAssistantMessage("Checked the tree and resumed.")],
		});
		harnesses.push(bh);
		const mh = createMirrorHarness(bh);

		// The killed tool's error result landed last — interrupted tools.
		expect(bh.manager.document.status.recoverableTurn).toBe("interruptedTools");

		const action = await bh.manager.recoverTurn();
		expect(action).toBe("continue");

		const doc = bh.manager.document;
		expect(doc.status.recoverableTurn).toBeNull();
		const path = leafPathIds(doc);
		// The abort marker is branched past; the aborted tool result stays on
		// the path — the agent reads it when re-orienting — and the visible
		// "Continue." turn follows it.
		expect(path).not.toContain("h-asst-2");
		expect(path).toContain("h-res-make");
		const nudge = findMessage(doc, (e) => e.role === "user" && messageText(e) === "Continue.");
		expect(nudge).toBeDefined();
		// The nudge follows the aborted result on the same path (pi may append
		// metadata — e.g. a restored thinking-level change — in between).
		expect(path.indexOf("h-res-make")).toBeLessThan(path.indexOf(nudge!.id));
		expect(path).toContain(nudge!.id);

		assertMirrorInSync(mh, "after recoverTurn (stopped mid-tool)");
	});

	it("refuses recovery when the tail is not broken", async () => {
		const bh = await createBridgeHarness({
			fixturePath: BEFORE_COMPACTION.pathname,
			responses: [fauxAssistantMessage("All good.")],
		});
		harnesses.push(bh);

		expect(bh.manager.document.status.recoverableTurn).toBeNull();
		await expect(bh.manager.recoverTurn()).rejects.toThrow(/No failed or interrupted turn/);

		// Still nothing after a successful turn.
		await bh.manager.prompt("hello");
		expect(bh.manager.document.status.recoverableTurn).toBeNull();
		await expect(bh.manager.recoverTurn()).rejects.toThrow(/No failed or interrupted turn/);
	});

	it("Stop during a silent recovery continuation waits for the run to flush", async () => {
		// Regression: agent.continue() bypasses AgentSession's run-active flag,
		// so session.abort()'s idle-wait returned while the recovery run was
		// still streaming — Stop reported done before the aborted tail existed.
		// The Manager tracks the run; abort awaits it.
		const gated = gatedResponse();
		const bh = await createBridgeHarness({
			fixturePath: ABORTED_TURN.pathname,
			responses: [gated.step],
		});
		harnesses.push(bh);
		const mh = createMirrorHarness(bh);

		expect(bh.manager.document.status.recoverableTurn).toBe("failedTurn");
		const streaming = streamingBecomes(bh, true);
		const recovering = bh.manager.recoverTurn();
		await streaming;

		await bh.manager.abort();
		// abort resolved only after the recovery run flushed: streaming is off,
		// and a fresh terminal assistant (not the fixture's) is already the
		// derived tail — without the tracked wait these would still be pending.
		// (An aborted continuation persists as stopReason "error" — "This
		// operation was aborted" — the stream layer's AbortError wrapping; the
		// recovery kind is the same either way.)
		const doc = bh.manager.document;
		expect(doc.status.isStreaming).toBe(false);
		expect(doc.status.recoverableTurn).toBe("failedTurn");
		expect(doc.status.leafId).not.toBe("g-asst-1");
		const branchPoint = doc.entries["g-asst-1"]!.parentId;
		const leaf = doc.status.leafId ? doc.entries[doc.status.leafId] : undefined;
		expect(leaf?.kind === "message" && leaf.role === "assistant").toBe(true);
		// On the recovered branch (pi may append metadata — e.g. a restored
		// thinking-level change — between the branch point and the new entry).
		const path = leafPathIds(doc);
		expect(path).toContain(branchPoint!);
		expect(path).not.toContain("g-asst-1");

		await expect(recovering).resolves.toBe("retry");
		gated.release();
		assertMirrorInSync(mh, "after abort during a recovery continuation");
	});

	it("dispose during a silent recovery continuation persists the aborted tail before teardown", async () => {
		// Regression: dispose could unsubscribe and tear down the runtime while
		// the recovery run was still finalizing — its aborted tail never
		// flushed. dispose awaits the tracked run; the file is complete when it
		// returns.
		const gated = gatedResponse();
		const bh = await createBridgeHarness({
			fixturePath: ABORTED_TURN.pathname,
			responses: [gated.step],
		});
		const streaming = streamingBecomes(bh, true);
		const recovering = bh.manager.recoverTurn();
		await streaming;

		try {
			await bh.manager.dispose();
			await expect(recovering).resolves.toBe("retry");

			// The recovery run's terminal assistant (an abort surfaces as
			// stopReason "error", "This operation was aborted") was persisted
			// before teardown: the file holds a fresh assistant parented on the
			// fixture aborted tail's parent — not just the fixture's own.
			const lines = readFileSync(bh.manager.sessionFile, "utf8")
				.split("\n")
				.filter((line) => line.trim() !== "");
			const newTail = lines
				.map(
					(line) =>
						JSON.parse(line) as {
							id?: string;
							type: string;
							message?: { role: string; stopReason?: string };
						},
				)
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message?.role === "assistant" &&
						(entry.message?.stopReason === "error" || entry.message?.stopReason === "aborted"),
				)
				.find((entry) => entry.id !== "g-asst-1");
			expect(newTail).toBeDefined();
		} finally {
			gated.release();
			bh.faux.unregister();
			if (existsSync(bh.tempCwd)) rmSync(bh.tempCwd, { recursive: true, force: true });
		}
	});
});

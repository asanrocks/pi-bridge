// ============================================================================
// ViewModel unit tests — computeViewModel: flatten + structure pipeline,
// turn collapsing (cross-entry merge), siblings, step summaries,
// move migration (migrateExpandKeys delegated to store tests).
// Pure tests — no mirror, no WebSocket, no transport.
// biome-ignore-all lint/complexity/useLiteralKeys: test fixtures use string-keyed entry names for readability
// ============================================================================

import { describe, expect, it } from "vitest";
import type { Document } from "../../src/core/types.ts";
import {
	beautifyShellCommand,
	computeViewModel,
	makeActionIdentity,
	makeActionSummary,
	newestLeafInSubtree,
	parseProviderError,
	segmentBlocks,
} from "../../src/viewmodel/index.ts";

// ---------------------------------------------------------------------------
// Helpers — build synthetic Documents
// ---------------------------------------------------------------------------

function emptyDoc(): Document {
	return {
		status: {
			leafId: null,
			name: "",
			model: { provider: "", modelId: "" },
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
			contextUsage: null,
			pendingSteer: [],
		},
		scopedModels: [],
		entries: {},
	};
}

function makeEntry(
	id: string,
	parentId: string | null,
	ts: string,
	kind: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { id, parentId, timestamp: ts, kind, ...extra };
}

function appendEntry(doc: Document, entry: Record<string, unknown>): Document {
	doc.entries[entry.id as string] = entry as unknown as Document["entries"][string];
	doc.status.leafId = entry.id as string;
	return doc;
}

// ---------------------------------------------------------------------------
// computeViewModel — empty / basic
// ---------------------------------------------------------------------------

describe("computeViewModel", () => {
	it("returns empty turns list for empty document", () => {
		const doc = emptyDoc();
		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toEqual([]);
		expect(vm.leafEntryId).toBeNull();
	});

	it("projects user → model_change → assistant path as three turns", () => {
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("e1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(doc, makeEntry("e2", "e1", "2024-01-01T00:01:00Z", "model_change", { provider: "x", modelId: "m" }));
		appendEntry(
			doc,
			makeEntry("e3", "e2", "2024-01-01T00:02:00Z", "message", {
				role: "assistant",
				content: [{ type: "text", text: "Hello" }],
				model: "m1",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toHaveLength(3);
		expect(vm.turns[0].kind).toBe("user");
		expect(vm.turns[1].kind).toBe("system");
		if (vm.turns[1].kind === "system") expect(vm.turns[1].type).toBe("model_switch");
		expect(vm.turns[2].kind).toBe("assistant");
		expect(vm.leafEntryId).toBe("e3");
	});

	it("handles provisional entries on path", () => {
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("e1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		doc.entries["pending:message"] = {
			kind: "message",
			id: "pending:message",
			parentId: "e1",
			timestamp: "",
			role: "assistant",
			content: [{ type: "text", text: "" }],
		} as unknown as Document["entries"][string];
		doc.status.leafId = "pending:message";

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toHaveLength(2);
		expect(vm.turns[0].kind).toBe("user");
		expect(vm.turns[1].kind).toBe("assistant");
		expect(vm.leafEntryId).toBe("pending:message");
	});

	it("user turns concatenate text content", () => {
		const doc = emptyDoc();
		appendEntry(
			doc,
			makeEntry("e1", null, "2024-01-01T00:00:00Z", "message", {
				role: "user",
				content: [
					{ type: "text", text: "Hello" },
					{ type: "text", text: "World" },
				],
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const u = vm.turns[0];
		expect(u.kind).toBe("user");
		if (u.kind === "user") expect(u.text).toBe("Hello\nWorld");
	});

	it("user turns extract image attachments and keep text separate", () => {
		const doc = emptyDoc();
		appendEntry(
			doc,
			makeEntry("e1", null, "2024-01-01T00:00:00Z", "message", {
				role: "user",
				content: [
					{ type: "text", text: "What is this?" },
					{ type: "image", data: "aGk=", mimeType: "image/png" },
				],
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const u = vm.turns[0];
		expect(u.kind).toBe("user");
		if (u.kind === "user") {
			expect(u.text).toBe("What is this?");
			expect(u.images).toEqual([{ type: "image", data: "aGk=", mimeType: "image/png" }]);
		}
	});

	it("image-only user turns render with empty text", () => {
		const doc = emptyDoc();
		appendEntry(
			doc,
			makeEntry("e1", null, "2024-01-01T00:00:00Z", "message", {
				role: "user",
				content: [{ type: "image", data: "aGk=", mimeType: "image/jpeg" }],
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const u = vm.turns[0];
		expect(u.kind).toBe("user");
		if (u.kind === "user") {
			expect(u.text).toBe("");
			expect(u.images).toHaveLength(1);
		}
	});

	it("assistant turns get blocks and model/usage", () => {
		const doc = emptyDoc();
		appendEntry(
			doc,
			makeEntry("e1", null, "2024-01-01T00:01:00Z", "message", {
				role: "assistant",
				content: [{ type: "text", text: "Hello world" }],
				model: "claude-sonnet-4-5",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const a = vm.turns[0];
		expect(a.kind).toBe("assistant");
		if (a.kind === "assistant") {
			expect(a.blocks).toHaveLength(1);
			expect(a.blocks[0].blockType).toBe("text");
			expect(a.model).toBe("claude-sonnet-4-5");
			expect(a.usage).toBeDefined();
		}
	});
});

// ---------------------------------------------------------------------------
// Turn structure — consecutive assistant entries merge into one run;
// text never splits a turn.
// ---------------------------------------------------------------------------

describe("turn separation by text", () => {
	it("merges a multi-response run into one turn per run", () => {
		// The canonical multi-response shape: [think,text] [think,text] [tool]
		// entries under one user turn render as ONE assistant turn — text
		// does not split; segmentBlocks renders the interleaving in order.
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a1", "u1", "2024-01-01T00:01:00Z", "message", {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "first" },
				],
			}),
		);
		appendEntry(
			doc,
			makeEntry("a2", "a1", "2024-01-01T00:02:00Z", "message", {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm2" },
					{ type: "text", text: "second" },
				],
			}),
		);
		appendEntry(
			doc,
			makeEntry("a3", "a2", "2024-01-01T00:03:00Z", "message", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a" } }],
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toHaveLength(2); // user + merged assistant run
		const run = vm.turns[1];
		expect(run.kind).toBe("assistant");
		if (run.kind === "assistant") {
			expect(run.entryId).toBe("a1");
			expect(run.turnKey).toBe("a1");
			expect(run.blocks.map((b) => b.blockType)).toEqual(["thinking", "text", "thinking", "text", "tool"]);
		}
	});

	it("accumulated tools, a message, and its trailing tools merge into one turn", () => {
		// a1 is tool-only; a2 = [text, toolCall]: everything accumulates into
		// a single run turn — a1's tool, the message, and a2's trailing tool
		// call render in block order within the turn.
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a1", "u1", "2024-01-01T00:01:00Z", "message", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a" } }],
			}),
		);
		appendEntry(
			doc,
			makeEntry("a2", "a1", "2024-01-01T00:02:00Z", "message", {
				role: "assistant",
				content: [
					{ type: "text", text: "Here's result" },
					{ type: "toolCall", id: "tc2", name: "bash", arguments: { command: "x" } },
				],
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toHaveLength(2); // user + one merged run turn
		const run = vm.turns[1];
		expect(run.kind).toBe("assistant");
		if (run.kind === "assistant") {
			expect(run.turnKey).toBe("a1");
			expect(run.entryId).toBe("a1");
			expect(run.blocks.map((b) => b.blockType)).toEqual(["tool", "text", "tool"]);
		}
	});

	it("[think, text, toolCall] stays one turn; segmentBlocks renders the interleaving", () => {
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a1", "u1", "2024-01-01T00:00:10Z", "message", {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "msg" },
					{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "x" } },
				],
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toHaveLength(2); // user + one merged turn
		const run = vm.turns[1];
		if (run.kind === "assistant") {
			expect(run.turnKey).toBe("a1");
			expect(run.entryId).toBe("a1");
			expect(run.blocks.map((b) => b.blockType)).toEqual(["thinking", "text", "tool"]);
			// Run timing: anchored on the user seal, window extends past the
			// entry's seal to its tool results.
			expect(run.turnStartedAt).toBe("2024-01-01T00:00:00Z");
		}
	});

	it("aborted entry carries stopReason/errorMessage once, on the run turn", () => {
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a1", "u1", "2024-01-01T00:00:10Z", "message", {
				role: "assistant",
				content: [
					{ type: "text", text: "partial" },
					{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "x" } },
				],
				stopReason: "aborted",
				errorMessage: "Operation aborted",
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toHaveLength(2); // user + one merged turn
		const run = vm.turns[1];
		if (run.kind === "assistant") {
			// The turn's last ref is the entry's last block → the anomaly
			// fields attach exactly once.
			expect(run.stopReason).toBe("aborted");
			expect(run.errorMessage).toBe("Operation aborted");
		}
	});

	it("empty-content error entry produces a turn carrying the error message", () => {
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a1", "u1", "2024-01-01T00:00:10Z", "message", {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage:
					'400: {"code":"InvalidParameter","message":"max_tokens exceeds limit","param":"max_tokens","type":"BadRequest"}',
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toHaveLength(2);
		const turn = vm.turns[1];
		if (turn.kind === "assistant") {
			expect(turn.stopReason).toBe("error");
			expect(turn.errorMessage).toBe(
				'400: {"code":"InvalidParameter","message":"max_tokens exceeds limit","param":"max_tokens","type":"BadRequest"}',
			);
			// Structured parse of the "<status>: {json}" error.
			expect(turn.parsedError).toEqual({
				status: 400,
				message: "max_tokens exceeds limit",
				attrs: { code: "InvalidParameter", param: "max_tokens", type: "BadRequest" },
			});
		}
	});

	describe("parseProviderError", () => {
		it("parses '<status>: {json}' into status/message/attrs", () => {
			const parsed = parseProviderError(
				'400: {"code":"InvalidParameter","message":"The parameter `max_tokens` specified in the request are not valid","param":"max_tokens","type":"BadRequest"}',
			);
			expect(parsed.status).toBe(400);
			expect(parsed.message).toBe("The parameter `max_tokens` specified in the request are not valid");
			expect(parsed.attrs).toEqual({
				code: "InvalidParameter",
				param: "max_tokens",
				type: "BadRequest",
			});
		});

		it("parses the provider-prefixed '<prefix> (<status>): {json}' shape", () => {
			const parsed = parseProviderError('DeepSeek (429): {"error":{"message":"rate limited","type":"rate_limit"}}');
			expect(parsed.status).toBe(429);
			expect(parsed.message).toBe("rate limited");
			expect(parsed.attrs).toEqual({ type: "rate_limit" });
		});

		it("falls back to the raw string for a plain message", () => {
			const raw = "Connection reset by peer";
			expect(parseProviderError(raw)).toEqual({ message: raw, attrs: {} });
		});

		it("falls back when the JSON is truncated", () => {
			const raw = '400: {"code":"InvalidParameter","message":"trunc'; // cut off mid-JSON
			expect(parseProviderError(raw)).toEqual({ message: raw, attrs: {} });
		});

		it("handles braces inside JSON string values", () => {
			const parsed = parseProviderError('400: {"message":"expected { count","param":"x"}');
			expect(parsed.status).toBe(400);
			expect(parsed.message).toBe("expected { count");
			expect(parsed.attrs).toEqual({ param: "x" });
		});

		it("ignores trailing non-JSON lines after the object", () => {
			const parsed = parseProviderError('400: {"message":"boom","code":"E"}\nextra provider metadata');
			expect(parsed.status).toBe(400);
			expect(parsed.message).toBe("boom");
			expect(parsed.attrs).toEqual({ code: "E" });
		});

		it("falls back when the JSON lacks a message field", () => {
			const raw = '400: {"code":"NoMessage"}';
			expect(parseProviderError(raw)).toEqual({ message: raw, attrs: {} });
		});
	});

	it("merged run anchors on the user seal and spans to the last entry's seal", () => {
		// a1 and a2 are both text-final entries — they merge into ONE turn,
		// so the run's timing spans the user seal to the last entry's seal
		// (per-response anchors exist only for mid-entry splits).
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a1", "u1", "2024-01-01T00:00:10Z", "message", {
				role: "assistant",
				content: [{ type: "text", text: "first" }],
			}),
		);
		appendEntry(
			doc,
			makeEntry("a2", "a1", "2024-01-01T00:00:25Z", "message", {
				role: "assistant",
				content: [{ type: "text", text: "second" }],
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toHaveLength(2); // user + merged assistant run
		const t = vm.turns[1];
		if (t.kind === "assistant") {
			expect(t.turnStartedAt).toBe("2024-01-01T00:00:00Z"); // user seal
			expect(t.totalMs).toBe(25_000); // u1 seal → a2 seal
		}
	});
});

// ---------------------------------------------------------------------------
// Cross-entry merge (textless entries)
// ---------------------------------------------------------------------------

describe("cross-entry merge", () => {
	it("merges consecutive textless assistant messages into one AssistantTurn", () => {
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a1", "u1", "2024-01-01T00:01:00Z", "message", {
				role: "assistant",
				content: [{ type: "thinking", thinking: "hmm" }],
				model: "m1",
			}),
		);
		appendEntry(
			doc,
			makeEntry("a2", "a1", "2024-01-01T00:02:00Z", "message", {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "tc1", name: "read", arguments: '{"path":"a"}' },
					{ type: "toolCall", id: "tc2", name: "bash", arguments: '{"command":"ls"}' },
				],
				model: "m2",
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toHaveLength(2); // user + merged assistant
		const a = vm.turns[1];
		expect(a.kind).toBe("assistant");
		if (a.kind === "assistant") {
			expect(a.blocks).toHaveLength(3);
			expect(a.blocks[0].blockType).toBe("thinking");
			expect(a.blocks[1].blockType).toBe("tool");
			expect(a.blocks[2].blockType).toBe("tool");
			expect(a.model).toBe("m2"); // last entry's model
			expect(a.entryId).toBe("a1"); // first entry id
		}
	});

	// Text-bearing entries merge like textless ones unless an action block
	// follows the text in the same entry — see the dedicated describe block
	// above.

	it("keeps the last sealed timestamp while a later entry streams", () => {
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a1", "u1", "2024-01-01T00:01:00Z", "message", {
				role: "assistant",
				content: [{ type: "text", text: "first" }],
			}),
		);
		doc.entries["pending:a2"] = {
			kind: "message",
			id: "pending:a2",
			parentId: "a1",
			timestamp: "",
			role: "assistant",
			content: [{ type: "text", text: "" }],
		} as unknown as Document["entries"][string];
		doc.status.leafId = "pending:a2";

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		// user + one merged run turn (both entries text-final → merged)
		expect(vm.turns).toHaveLength(2);
		const a = vm.turns[1];
		expect(a.kind).toBe("assistant");
		if (a.kind === "assistant") {
			// Display timestamp stays on the last SEALED entry (a1) while the
			// provisional a2 streams — no flicker.
			expect(a.timestamp).toBe("2024-01-01T00:01:00Z");
			expect(a.totalMs).toBeUndefined(); // still streaming
			expect(a.turnStartedAt).toBe("2024-01-01T00:00:00Z"); // user seal
		}
	});

	// (Text-bearing entries merge into the run unless an action block
	// follows the text in the same entry — see "turn separation by text".)
	it("tool_result between textless assistant entries does not break the merge", () => {
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a1", "u1", "2024-01-01T00:01:00Z", "message", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: '{"path":"a"}' }],
			}),
		);
		appendEntry(
			doc,
			makeEntry("tr1", "a1", "2024-01-01T00:02:00Z", "tool_result", {
				toolCallId: "tc1",
				toolName: "read",
				content: [],
				details: null,
				isError: false,
			}),
		);
		appendEntry(
			doc,
			makeEntry("a2", "tr1", "2024-01-01T00:03:00Z", "message", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc2", name: "bash", arguments: '{"command":"x"}' }],
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		// user + merged assistant (no separate tool_result turn)
		expect(vm.turns).toHaveLength(2);
		const a = vm.turns[1];
		expect(a.kind).toBe("assistant");
		if (a.kind === "assistant") expect(a.blocks).toHaveLength(2);
	});

	it("user message breaks the assistant run", () => {
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a1", "u1", "2024-01-01T00:01:00Z", "message", {
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
			}),
		);
		appendEntry(
			doc,
			makeEntry("u2", "a1", "2024-01-01T00:02:00Z", "message", {
				role: "user",
				content: [{ type: "text", text: "again" }],
			}),
		);
		appendEntry(
			doc,
			makeEntry("a2", "u2", "2024-01-01T00:03:00Z", "message", {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toHaveLength(4);
		expect(vm.turns[0].kind).toBe("user");
		expect(vm.turns[1].kind).toBe("assistant");
		expect(vm.turns[2].kind).toBe("user");
		expect(vm.turns[3].kind).toBe("assistant");
	});
});

// ---------------------------------------------------------------------------
// System turns
// ---------------------------------------------------------------------------

describe("system turns", () => {
	it("compaction entries produce SystemTurn with summary", () => {
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("c1", null, "2024-01-01T00:00:00Z", "compaction", { summary: "Compacted context" }));

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toHaveLength(1);
		const st = vm.turns[0];
		expect(st.kind).toBe("system");
		if (st.kind === "system") {
			expect(st.type).toBe("compaction");
			expect(st.summary).toBe("Compacted context");
		}
	});

	it("model_change entries produce SystemTurn with switchTo", () => {
		const doc = emptyDoc();
		appendEntry(
			doc,
			makeEntry("m1", null, "2024-01-01T00:00:00Z", "model_change", { provider: "faux", modelId: "gpt-7" }),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const st = vm.turns[0];
		expect(st.kind).toBe("system");
		if (st.kind === "system") {
			expect(st.type).toBe("model_switch");
			expect(st.switchTo).toEqual({ provider: "faux", modelId: "gpt-7", thinkingLevel: undefined });
		}
	});

	it("merges consecutive model/thinking changes into one turn with the final state", () => {
		const doc = emptyDoc();
		appendEntry(
			doc,
			makeEntry("t1", null, "2024-01-01T00:00:00Z", "thinking_level_change", { thinkingLevel: "low" }),
		);
		appendEntry(
			doc,
			makeEntry("m1", "t1", "2024-01-01T00:01:00Z", "model_change", {
				provider: "deepseek",
				modelId: "deepseek-v4-pro",
			}),
		);
		appendEntry(
			doc,
			makeEntry("t2", "m1", "2024-01-01T00:02:00Z", "thinking_level_change", { thinkingLevel: "high" }),
		);
		appendEntry(
			doc,
			makeEntry("m2", "t2", "2024-01-01T00:03:00Z", "model_change", {
				provider: "deepseek",
				modelId: "deepseek-v4-flash",
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toHaveLength(1);
		const st = vm.turns[0];
		expect(st.kind).toBe("system");
		if (st.kind === "system") {
			expect(st.type).toBe("model_switch");
			// Last model_change and last thinking_level_change win; the
			// leading "low" is the pre-switch state and is dropped.
			expect(st.switchTo).toEqual({ provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "high" });
		}
	});

	it("a thinking-only run produces a switch turn without a model", () => {
		const doc = emptyDoc();
		appendEntry(
			doc,
			makeEntry("t1", null, "2024-01-01T00:00:00Z", "thinking_level_change", { thinkingLevel: "low" }),
		);
		appendEntry(
			doc,
			makeEntry("t2", "t1", "2024-01-01T00:01:00Z", "thinking_level_change", { thinkingLevel: "high" }),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toHaveLength(1);
		const st = vm.turns[0];
		expect(st.kind).toBe("system");
		if (st.kind === "system") {
			expect(st.type).toBe("model_switch");
			expect(st.switchTo).toEqual({ provider: "", modelId: "", thinkingLevel: "high" });
		}
	});

	it("a model switch without a thinking change omits the level", () => {
		const doc = emptyDoc();
		appendEntry(
			doc,
			makeEntry("m1", null, "2024-01-01T00:00:00Z", "model_change", {
				provider: "deepseek",
				modelId: "deepseek-v4-flash",
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const st = vm.turns[0];
		expect(st.kind).toBe("system");
		if (st.kind === "system") {
			expect(st.switchTo).toEqual({ provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: undefined });
		}
	});

	it("model/thinking changes before and after a user message stay separate", () => {
		const doc = emptyDoc();
		appendEntry(
			doc,
			makeEntry("m1", null, "2024-01-01T00:00:00Z", "model_change", {
				provider: "deepseek",
				modelId: "deepseek-v4-pro",
			}),
		);
		appendEntry(doc, makeEntry("u1", "m1", "2024-01-01T00:01:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("m2", "u1", "2024-01-01T00:02:00Z", "model_change", {
				provider: "deepseek",
				modelId: "deepseek-v4-flash",
			}),
		);

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toHaveLength(3);
		const kinds = vm.turns.map((t) => (t.kind === "system" ? t.type : t.kind));
		expect(kinds).toEqual(["model_switch", "user", "model_switch"]);
	});
});

// ---------------------------------------------------------------------------
// Tool result join + status
// ---------------------------------------------------------------------------

describe("tool result join", () => {
	it("folds tool_result into the matching ToolActionStepVM result", () => {
		const doc = emptyDoc();
		doc.entries["a1"] = {
			kind: "message",
			id: "a1",
			parentId: null,
			timestamp: "2024-01-01T00:01:00Z",
			role: "assistant",
			content: [{ type: "toolCall", id: "tc1", name: "read", arguments: '{"path":"a"}' }],
		} as unknown as Document["entries"][string];
		doc.entries["tr1"] = {
			kind: "tool_result",
			id: "tr1",
			parentId: "a1",
			timestamp: "2024-01-01T00:02:00Z",
			toolCallId: "tc1",
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			details: null,
			isError: false,
		} as unknown as Document["entries"][string];
		doc.status.leafId = "tr1";

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const a = vm.turns[0];
		expect(a.kind).toBe("assistant");
		if (a.kind === "assistant") {
			const h = a.blocks[0];
			expect(h.blockType).toBe("tool");
			if (h.blockType === "tool") {
				expect(h.result).not.toBeNull();
				expect(h.result!.entryId).toBe("tr1");
				expect(h.status).toBe("done");
			}
		}
	});

	it("tool error status propagates", () => {
		const doc = emptyDoc();
		doc.entries["a1"] = {
			kind: "message",
			id: "a1",
			parentId: null,
			timestamp: "2024-01-01T00:01:00Z",
			role: "assistant",
			content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: '{"command":"fail"}' }],
		} as unknown as Document["entries"][string];
		doc.entries["tr1"] = {
			kind: "tool_result",
			id: "tr1",
			parentId: "a1",
			timestamp: "2024-01-01T00:02:00Z",
			toolCallId: "tc1",
			toolName: "bash",
			content: [],
			details: null,
			isError: true,
		} as unknown as Document["entries"][string];
		doc.status.leafId = "tr1";

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const a = vm.turns[0];
		if (a.kind === "assistant" && a.blocks[0].blockType === "tool") {
			expect(a.blocks[0].status).toBe("error");
		}
	});

	it("tool with arguments but no result shows running", () => {
		const doc = emptyDoc();
		doc.entries["a1"] = {
			kind: "message",
			id: "a1",
			parentId: null,
			timestamp: "",
			role: "assistant",
			content: [{ type: "toolCall", id: "tc1", name: "read", arguments: '{"path":"a"}' }],
		} as unknown as Document["entries"][string];
		doc.status.leafId = "a1";

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const a = vm.turns[0];
		if (a.kind === "assistant" && a.blocks[0].blockType === "tool") {
			expect(a.blocks[0].status).toBe("running");
		}
	});

	it("tool without arguments shows pending", () => {
		const doc = emptyDoc();
		doc.entries["a1"] = {
			kind: "message",
			id: "a1",
			parentId: null,
			timestamp: "",
			role: "assistant",
			content: [{ type: "toolCall", id: "tc1", name: "read", arguments: null }],
		} as unknown as Document["entries"][string];
		doc.status.leafId = "a1";

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const a = vm.turns[0];
		if (a.kind === "assistant" && a.blocks[0].blockType === "tool") {
			expect(a.blocks[0].status).toBe("pending");
		}
	});

	it("tool with provisional result entry (tool_execution_start) shows running", () => {
		// A provisional tool_result (pending: prefix) is created at
		// tool_execution_start, before tool_execution_end seals it. The
		// step is running, not done.
		const doc = emptyDoc();
		doc.entries["a1"] = {
			kind: "message",
			id: "a1",
			parentId: null,
			timestamp: "",
			role: "assistant",
			content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: '{"command":"sleep 5"}' }],
		} as unknown as Document["entries"][string];
		doc.entries["pending:tc1"] = {
			kind: "tool_result",
			id: "pending:tc1",
			parentId: "a1",
			timestamp: "",
			toolCallId: "tc1",
			toolName: "bash",
			content: [{ type: "text", text: "" }],
			details: null,
			isError: false,
		} as unknown as Document["entries"][string];
		doc.status.leafId = "pending:tc1";

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const a = vm.turns[0];
		if (a.kind === "assistant" && a.blocks[0].blockType === "tool") {
			expect(a.blocks[0].status).toBe("running");
			expect(a.blocks[0].result?.entryId).toBe("pending:tc1");
		}
	});
});

// ---------------------------------------------------------------------------
// Heading summaries
// ---------------------------------------------------------------------------

describe("tool step summaries", () => {
	function docWithTool(args: Record<string, unknown> | null): Document {
		const doc = emptyDoc();
		doc.entries["a1"] = {
			kind: "message",
			id: "a1",
			parentId: null,
			timestamp: "2024-01-01T00:01:00Z",
			role: "assistant",
			content: [{ type: "toolCall", id: "tc1", name: "read", arguments: args }],
		} as unknown as Document["entries"][string];
		doc.status.leafId = "a1";
		return doc;
	}

	function summary(args: Record<string, unknown> | null): string {
		const vm = computeViewModel({ document: docWithTool(args), sessions: [], models: [] });
		const h = vm.turns[0];
		if (h.kind === "assistant" && h.blocks[0].blockType === "tool") return h.blocks[0].summary;
		return "";
	}

	it("read shows path", () => {
		expect(summary({ path: "src/main.ts" })).toBe("read: src/main.ts");
	});

	it("edit shows path", () => {
		const doc = emptyDoc();
		doc.entries["a1"] = {
			kind: "message",
			id: "a1",
			parentId: null,
			timestamp: "",
			role: "assistant",
			content: [{ type: "toolCall", id: "tc1", name: "edit", arguments: { filePath: "src/foo.ts" } }],
		} as unknown as Document["entries"][string];
		doc.status.leafId = "a1";
		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const h = vm.turns[0];
		if (h.kind === "assistant" && h.blocks[0].blockType === "tool") {
			expect(h.blocks[0].summary).toBe("edit: src/foo.ts");
		}
	});

	it("bash shows command", () => {
		const doc = emptyDoc();
		doc.entries["a1"] = {
			kind: "message",
			id: "a1",
			parentId: null,
			timestamp: "",
			role: "assistant",
			content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "npm test" } }],
		} as unknown as Document["entries"][string];
		doc.status.leafId = "a1";
		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const h = vm.turns[0];
		if (h.kind === "assistant" && h.blocks[0].blockType === "tool") {
			expect(h.blocks[0].summary).toBe("bash: npm test");
		}
	});
});

// ---------------------------------------------------------------------------

describe("user bash turns", () => {
	function docWithBash(): Document {
		const doc = emptyDoc();
		appendEntry(
			doc,
			makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", {
				role: "user",
				content: [{ type: "text", text: "hi" }],
			}),
		);
		appendEntry(
			doc,
			makeEntry("b1", "u1", "2024-01-01T00:01:00Z", "bash_execution", {
				command: "npm test",
				output: "ok",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				fullOutputPath: null,
				excludeFromContext: false,
			}),
		);
		appendEntry(
			doc,
			makeEntry("u2", "b1", "2024-01-01T00:02:00Z", "message", {
				role: "user",
				content: [{ type: "text", text: "and now?" }],
			}),
		);
		return doc;
	}

	it("bash_execution becomes its own turn between user turns", () => {
		const vm = computeViewModel({ document: docWithBash(), sessions: [], models: [] });
		expect(vm.turns.map((t) => t.kind)).toEqual(["user", "userBash", "user"]);
		const bashTurn = vm.turns[1];
		if (bashTurn.kind !== "userBash") throw new Error("unreachable");
		expect(bashTurn.entryId).toBe("b1");
		expect(bashTurn.command).toBe("npm test");
		expect(bashTurn.output).toBe("ok");
		expect(bashTurn.exitCode).toBe(0);
		expect(bashTurn.excludeFromContext).toBe(false);
	});

	it("failed run carries exit code and context exclusion", () => {
		const doc = emptyDoc();
		appendEntry(
			doc,
			makeEntry("b1", null, "2024-01-01T00:00:00Z", "bash_execution", {
				command: "false",
				output: "",
				exitCode: 1,
				cancelled: true,
				truncated: true,
				fullOutputPath: "/tmp/pi-bash1.log",
				excludeFromContext: true,
			}),
		);
		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const t = vm.turns[0];
		if (t.kind !== "userBash") throw new Error("unreachable");
		expect(t.exitCode).toBe(1);
		expect(t.cancelled).toBe(true);
		expect(t.truncated).toBe(true);
		expect(t.fullOutputPath).toBe("/tmp/pi-bash1.log");
		expect(t.excludeFromContext).toBe(true);
	});
});

describe("read compact classifications — makeActionSummary", () => {
	it("SKILL.md summarizes as the skill folder", () => {
		expect(makeActionSummary("read", { path: "/home/x/.pi/skills/git-helper/SKILL.md" }, "/repo")).toBe(
			"[skill] git-helper",
		);
		expect(makeActionSummary("read", { path: "skills/foo/SKILL.md" }, "/repo")).toBe("[skill] foo");
	});

	it("skill summary keeps the line range", () => {
		expect(makeActionSummary("read", { path: "skills/foo/SKILL.md", offset: 1, limit: 80 }, "/repo")).toBe(
			"[skill] foo L1-80",
		);
	});

	it("agent resource files summarize as read resource", () => {
		expect(makeActionSummary("read", { path: "AGENTS.md" }, "/repo")).toBe("read resource AGENTS.md");
		expect(makeActionSummary("read", { path: "sub/dir/AGENTS.md" }, "/repo")).toBe("read resource sub/dir/AGENTS.md");
		expect(makeActionSummary("read", { path: "CLAUDE.MD" }, "/repo")).toBe("read resource CLAUDE.MD");
	});

	it("resource outside cwd stays absolute", () => {
		expect(makeActionSummary("read", { path: "/etc/AGENTS.md" }, "/repo")).toBe("read resource /etc/AGENTS.md");
	});

	it("ordinary reads keep the basename summary", () => {
		expect(makeActionSummary("read", { path: "src/main.ts" }, "/repo")).toBe("read: main.ts");
		expect(makeActionSummary("read", { path: "SKILL.md.txt" }, "/repo")).toBe("read: SKILL.md.txt");
	});

	it("no cwd falls back to the basename summary (cannot resolve)", () => {
		expect(makeActionSummary("read", { path: "AGENTS.md" })).toBe("read: AGENTS.md");
	});
});

describe("tool step identity — makeActionIdentity", () => {
	// Pure function tests (no document): the identity is the full-form
	// counterpart of the abbreviated band summary — cwd-relative full paths
	// with the read line range, the whole bash command.
	it("read shows the full path with line range", () => {
		expect(makeActionIdentity("read", { path: "src/main.ts", offset: 12, limit: 80 }, "/repo")).toBe(
			"src/main.ts:12-91",
		);
		expect(makeActionIdentity("read", { path: "/repo/src/main.ts", offset: 5 }, "/repo")).toBe("src/main.ts:5");
		expect(makeActionIdentity("read", { path: "src/main.ts" })).toBe("src/main.ts");
	});

	it("read honors the filePath alias", () => {
		expect(makeActionIdentity("read", { filePath: "src/main.ts" })).toBe("src/main.ts");
	});

	it("paths outside cwd stay absolute", () => {
		expect(makeActionIdentity("read", { path: "/etc/hosts" }, "/repo")).toBe("/etc/hosts");
	});

	it("edit and write show the full path", () => {
		expect(makeActionIdentity("edit", { path: "packages/bridge/src/cli.ts" }, "/repo")).toBe(
			"packages/bridge/src/cli.ts",
		);
		expect(makeActionIdentity("write", { filePath: "packages/bridge/src/cli.ts" }, "/repo")).toBe(
			"packages/bridge/src/cli.ts",
		);
	});

	it("bash shows the whole command, multi-line preserved", () => {
		expect(makeActionIdentity("bash", { command: "npm test" })).toBe("npm test");
		expect(makeActionIdentity("bash", { command: "cd /tmp\nls -la" })).toBe("cd /tmp\nls -la");
	});

	it("grep identity shows pattern, path, glob, limit", () => {
		expect(makeActionIdentity("grep", { pattern: "TODO" }, "/repo")).toBe("/TODO/ in .");
		expect(makeActionIdentity("grep", { pattern: "TODO", path: "src" }, "/repo")).toBe("/TODO/ in src");
		expect(makeActionIdentity("grep", { pattern: "TODO", path: "/repo/src", glob: "*.ts", limit: 50 }, "/repo")).toBe(
			"/TODO/ in src (*.ts) limit 50",
		);
		expect(makeActionIdentity("grep", { query: "alt" })).toBe("/alt/ in .");
	});

	it("find identity shows pattern, path, limit", () => {
		expect(makeActionIdentity("find", { pattern: "*.ts" }, "/repo")).toBe("*.ts in .");
		expect(makeActionIdentity("find", { pattern: "*.ts", path: "src", limit: 10 }, "/repo")).toBe(
			"*.ts in src limit 10",
		);
	});

	it("ls identity shows path and limit", () => {
		expect(makeActionIdentity("ls", {}, "/repo")).toBe("ls .");
		expect(makeActionIdentity("ls", { path: "src/web", limit: 100 }, "/repo")).toBe("ls src/web limit 100");
	});

	it("unknown tools fall back to the first string argument, uncapped", () => {
		const long = "x".repeat(200);
		expect(makeActionIdentity("todoSearch", { pattern: long })).toBe(long);
	});

	it("returns null while the identifier argument has not streamed", () => {
		expect(makeActionIdentity("read", null)).toBeNull();
		expect(makeActionIdentity("read", {})).toBeNull();
		expect(makeActionIdentity("bash", { command: "" })).toBeNull();
		expect(makeActionIdentity("read", { path: "" })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// segmentBlocks — renderer-owned grouping helper
// ---------------------------------------------------------------------------

describe("segmentBlocks", () => {
	it("splits flat blocks into text + groups of steps", () => {
		const blocks = [
			{ blockType: "text" as const, entryId: "e1", blockIndex: 0, text: "Hi", isProvisional: false },
			{
				blockType: "thinking" as const,
				entryId: "e1",
				blockIndex: 1,
				thinking: "hmm",
				isProvisional: false,
				redacted: false,
			},
			{
				blockType: "tool" as const,
				entryId: "e1",
				blockIndex: 2,
				toolName: "read",
				toolCallId: "tc1",
				arguments: null,
				result: null,
				summary: "read: a",
				status: "done" as const,
			},
			{ blockType: "text" as const, entryId: "e1", blockIndex: 3, text: "Done", isProvisional: false },
		];

		const segs = segmentBlocks(blocks);
		expect(segs).toHaveLength(3);
		expect(segs[0].kind).toBe("text");
		expect(segs[1].kind).toBe("group");
		if (segs[1].kind === "group") {
			expect(segs[1].steps).toHaveLength(2);
			expect(segs[1].key).toBe("e1:1");
		}
		expect(segs[2].kind).toBe("text");
	});

	it("merges consecutive steps into one group with correct key", () => {
		const blocks = [
			{
				blockType: "thinking" as const,
				entryId: "e1",
				blockIndex: 0,
				thinking: null,
				isProvisional: false,
				redacted: false,
			},
			{
				blockType: "tool" as const,
				entryId: "e1",
				blockIndex: 1,
				toolName: "read",
				toolCallId: "tc1",
				arguments: null,
				result: null,
				summary: "read: a",
				status: "pending" as const,
			},
			{
				blockType: "tool" as const,
				entryId: "e2",
				blockIndex: 0,
				toolName: "bash",
				toolCallId: "tc2",
				arguments: null,
				result: null,
				summary: "bash: x",
				status: "pending" as const,
			},
		];

		const segs = segmentBlocks(blocks);
		expect(segs).toHaveLength(1);
		expect(segs[0].kind).toBe("group");
		if (segs[0].kind === "group") {
			expect(segs[0].steps).toHaveLength(3);
			expect(segs[0].key).toBe("e1:0");
		}
	});
});

// ---------------------------------------------------------------------------
// Sibling pager
// ---------------------------------------------------------------------------

describe("sibling pager", () => {
	it("computes siblings for user messages sharing parentId", () => {
		const doc = emptyDoc();
		doc.entries.root = makeEntry("root", null, "2024-01-01T00:00:00Z", "message", {
			role: "user",
			content: [],
		}) as unknown as Document["entries"][string];
		doc.entries["child-a"] = makeEntry("child-a", "root", "2024-01-01T00:01:00Z", "message", {
			role: "user",
			content: [],
		}) as unknown as Document["entries"][string];
		doc.entries["asst-a"] = makeEntry("asst-a", "child-a", "2024-01-01T00:02:00Z", "message", {
			role: "assistant",
			content: [{ type: "text", text: "Reply A" }],
		}) as unknown as Document["entries"][string];
		doc.entries["child-b"] = makeEntry("child-b", "root", "2024-01-01T00:03:00Z", "message", {
			role: "user",
			content: [],
		}) as unknown as Document["entries"][string];
		doc.entries["asst-b"] = makeEntry("asst-b", "child-b", "2024-01-01T00:04:00Z", "message", {
			role: "assistant",
			content: [{ type: "text", text: "Reply B" }],
		}) as unknown as Document["entries"][string];
		doc.status.leafId = "asst-b";

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		// root → child-b → asst-b = 3 turns (user, user, assistant)
		expect(vm.turns).toHaveLength(3);

		const childB = vm.turns[1];
		expect(childB.kind).toBe("user");
		if (childB.kind === "user") {
			expect(childB.siblings).toEqual(["child-a", "child-b"]);
			expect(childB.currentSiblingIndex).toBe(1);
		}
	});

	it("single user message has siblings = [itself]", () => {
		const doc = emptyDoc();
		doc.entries.only = makeEntry("only", null, "2024-01-01T00:00:00Z", "message", {
			role: "user",
			content: [],
		}) as unknown as Document["entries"][string];
		doc.status.leafId = "only";

		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const u = vm.turns[0];
		if (u.kind === "user") {
			expect(u.siblings).toEqual(["only"]);
			expect(u.currentSiblingIndex).toBe(0);
		}
	});
});

// ---------------------------------------------------------------------------
// Turn context usage — cumulative occupancy + delta
// ---------------------------------------------------------------------------

describe("turn context usage", () => {
	function usageIn(fed: number, output = 100): Record<string, unknown> {
		return {
			input: fed,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: fed + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	function ctxDoc(): Document {
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a1", "u1", "2024-01-01T00:00:10Z", "message", {
				role: "assistant",
				model: "m1",
				provider: "p",
				content: [{ type: "text", text: "one" }],
				usage: usageIn(25_000),
			}),
		);
		appendEntry(doc, makeEntry("u2", "a1", "2024-01-01T00:01:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a2", "u2", "2024-01-01T00:01:10Z", "message", {
				role: "assistant",
				model: "m1",
				provider: "p",
				content: [{ type: "text", text: "two" }],
				usage: usageIn(52_000),
			}),
		);
		return doc;
	}

	const models = [{ provider: "p", id: "m1", name: "M1", reasoning: false, contextWindow: 100_000 }];

	it("reports cumulative occupancy and a delta above the threshold", () => {
		const vm = computeViewModel({ document: ctxDoc(), sessions: [], models });
		const t1 = vm.turns[1];
		const t2 = vm.turns[3];
		if (t1.kind === "assistant" && t2.kind === "assistant") {
			expect(t1.contextPercent).toBeCloseTo(25, 5);
			expect(t1.contextDeltaPercent).toBeUndefined(); // first reading — no prior
			expect(t2.contextPercent).toBeCloseTo(52, 5);
			expect(t2.contextDeltaPercent).toBeCloseTo(27, 5);
		}
	});

	it("omits the delta below the 1pp threshold; keeps negative (compaction) deltas", () => {
		const doc = ctxDoc();
		// Third turn: small growth (+0.4pp) then a compaction-style drop (−40pp).
		appendEntry(doc, makeEntry("u3", "a2", "2024-01-01T00:02:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a3", "u3", "2024-01-01T00:02:10Z", "message", {
				role: "assistant",
				model: "m1",
				provider: "p",
				content: [{ type: "text", text: "three" }],
				usage: usageIn(52_400),
			}),
		);
		appendEntry(doc, makeEntry("u4", "a3", "2024-01-01T00:03:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a4", "u4", "2024-01-01T00:03:10Z", "message", {
				role: "assistant",
				model: "m1",
				provider: "p",
				content: [{ type: "text", text: "four" }],
				usage: usageIn(12_000),
			}),
		);
		const vm = computeViewModel({ document: doc, sessions: [], models });
		const t3 = vm.turns[5];
		const t4 = vm.turns[7];
		if (t3.kind === "assistant" && t4.kind === "assistant") {
			expect(t3.contextPercent).toBeCloseTo(52.4, 5);
			expect(t3.contextDeltaPercent).toBeUndefined(); // +0.4pp — below threshold
			expect(t4.contextPercent).toBeCloseTo(12, 5);
			expect(t4.contextDeltaPercent).toBeCloseTo(-40.4, 5); // drop always renders
		}
	});

	it("skips invalid usage (aborted stop, all-zero) and breaks the delta chain", () => {
		const doc = ctxDoc();
		appendEntry(doc, makeEntry("u3", "a2", "2024-01-01T00:02:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a3", "u3", "2024-01-01T00:02:10Z", "message", {
				role: "assistant",
				model: "m1",
				provider: "p",
				content: [{ type: "text", text: "aborted" }],
				stopReason: "aborted",
				usage: usageIn(60_000),
			}),
		);
		appendEntry(doc, makeEntry("u4", "a3", "2024-01-01T00:03:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a4", "u4", "2024-01-01T00:03:10Z", "message", {
				role: "assistant",
				model: "m1",
				provider: "p",
				content: [{ type: "text", text: "after" }],
				usage: usageIn(55_000),
			}),
		);
		const vm = computeViewModel({ document: doc, sessions: [], models });
		const t3 = vm.turns[5];
		const t4 = vm.turns[7];
		if (t3.kind === "assistant" && t4.kind === "assistant") {
			expect(t3.contextPercent).toBeUndefined(); // aborted — untrustworthy
			expect(t4.contextPercent).toBeCloseTo(55, 5);
			expect(t4.contextDeltaPercent).toBeUndefined(); // chain broken by the invalid reading
		}
	});

	it("no contextWindow in the model list → no percent; model switch → no delta", () => {
		const vm = computeViewModel({ document: ctxDoc(), sessions: [], models: [] });
		const t1 = vm.turns[1];
		if (t1.kind === "assistant") expect(t1.contextPercent).toBeUndefined();

		// Model switch mid-session: absolute percent under the new model,
		// delta omitted (readings incomparable across contextWindows).
		const models2 = [
			{ provider: "p", id: "m1", name: "M1", reasoning: false, contextWindow: 100_000 },
			{ provider: "p", id: "m2", name: "M2", reasoning: false, contextWindow: 50_000 },
		];
		const doc = ctxDoc();
		appendEntry(doc, makeEntry("u3", "a2", "2024-01-01T00:02:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a3", "u3", "2024-01-01T00:02:10Z", "message", {
				role: "assistant",
				model: "m2",
				provider: "p",
				content: [{ type: "text", text: "switched" }],
				usage: usageIn(30_000),
			}),
		);
		const vm2 = computeViewModel({ document: doc, sessions: [], models: models2 });
		const t3 = vm2.turns[5];
		if (t3.kind === "assistant") {
			expect(t3.contextPercent).toBeCloseTo(60, 5); // 30k of m2's 50k window
			expect(t3.contextDeltaPercent).toBeUndefined(); // not comparable to m1's 52%
		}
	});

	it("one merged turn reports the run's usage reading once", () => {
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a1", "u1", "2024-01-01T00:00:10Z", "message", {
				role: "assistant",
				model: "m1",
				provider: "p",
				content: [
					{ type: "text", text: "msg" },
					{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "x" } },
				],
				usage: usageIn(25_000),
			}),
		);
		const vm = computeViewModel({ document: doc, sessions: [], models });
		expect(vm.turns).toHaveLength(2); // user + one merged turn
		const run = vm.turns[1];
		if (run.kind === "assistant") {
			expect(run.contextPercent).toBeCloseTo(25, 5); // reported exactly once
		}
	});
});

// ---------------------------------------------------------------------------
// Turn timing — thought-for / worked-for / tool split
// ---------------------------------------------------------------------------

describe("turn timing", () => {
	it("omits thoughtForMs on the first user turn (no previous turn)", () => {
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const u = vm.turns[0];
		if (u.kind === "user") expect(u.thoughtForMs).toBeUndefined();
	});

	it("computes thoughtForMs from the previous turn's seal to this send", () => {
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a1", "u1", "2024-01-01T00:00:30Z", "message", {
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
			}),
		);
		appendEntry(doc, makeEntry("u2", "a1", "2024-01-01T00:01:15Z", "message", { role: "user", content: [] }));
		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const u2 = vm.turns[2];
		expect(u2.kind).toBe("user");
		if (u2.kind === "user") expect(u2.thoughtForMs).toBe(45_000);
	});

	it("anchors thoughtForMs on the wall-clock previous assistant across branches (re-edit)", () => {
		// A→B→C→D, then user re-edits A into A0 (a sibling of A, parentId
		// null). A0's leaf path is just [A0] — no on-path predecessor — yet
		// the user's deliberation runs from the last assistant they saw (D,
		// the old branch's leaf), so thought-for = A0 − D.
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("a", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("b", "a", "2024-01-01T00:00:30Z", "message", {
				role: "assistant",
				content: [{ type: "text", text: "B" }],
			}),
		);
		appendEntry(doc, makeEntry("c", "b", "2024-01-01T00:01:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("d", "c", "2024-01-01T00:01:20Z", "message", {
				role: "assistant",
				content: [{ type: "text", text: "D" }],
			}),
		);
		// The re-edit: A0 is a sibling of A (same parentId null), sent at 00:02:10.
		appendEntry(doc, makeEntry("a0", null, "2024-01-01T00:02:10Z", "message", { role: "user", content: [] }));
		doc.status.leafId = "a0";
		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toHaveLength(1); // only A0 is on the leaf path
		const a0 = vm.turns[0];
		expect(a0.kind).toBe("user");
		// D sealed at 00:01:20; A0 sent at 00:02:10 → 50s.
		if (a0.kind === "user") expect(a0.thoughtForMs).toBe(50_000);
	});

	it("omits thoughtForMs when no assistant has completed before this send (first turn)", () => {
		// A provisional assistant with no sealed predecessor: nothing to anchor on.
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		doc.entries["pending:message"] = {
			kind: "message",
			id: "pending:message",
			parentId: "u1",
			timestamp: "",
			role: "assistant",
			content: [{ type: "text", text: "" }],
		} as unknown as Document["entries"][string];
		doc.status.leafId = "pending:message";
		// A second user turn whose only predecessor is the unsealed provisional.
		appendEntry(
			doc,
			makeEntry("u2", "pending:message", "2024-01-01T00:00:20Z", "message", { role: "user", content: [] }),
		);
		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const u2 = vm.turns[2];
		if (u2.kind === "user") expect(u2.thoughtForMs).toBeUndefined();
	});

	it("assistant totalMs spans user-send to last seal; toolMs=0 with no tools", () => {
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a1", "u1", "2024-01-01T00:00:12Z", "message", {
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
			}),
		);
		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		const a = vm.turns[1];
		expect(a.kind).toBe("assistant");
		if (a.kind === "assistant") {
			expect(a.turnStartedAt).toBe("2024-01-01T00:00:00Z");
			expect(a.totalMs).toBe(12_000);
			expect(a.toolMs).toBe(0);
		}
	});

	it("run timing across a multi-batch run (parallel-safe)", () => {
		// Timeline (all sealed):
		//   00:00  user send (t_user)
		//   00:10  asst gen1 seals (toolUse)            → gen1 = 10s
		//   00:16  tool A seals (ran 6s, parallel with B)
		//   00:14  tool B seals (ran 4s, parallel with A)  ← max batch1 = 00:16
		//   00:20  asst gen2 seals (end_turn)           → gen2 = 20-16 = 4s
		// One merged turn [text, toolA, toolB, text]: window 00:00–00:20 →
		// total 20s; toolMs = 20 − (10+4) = 6s (the parallel span, not
		// 6+4=10 — per-batch max, not per-tool sum).
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a1", "u1", "2024-01-01T00:00:10Z", "message", {
				role: "assistant",
				content: [
					{ type: "text", text: "working" },
					{ type: "toolCall", id: "tcA", name: "read", arguments: { path: "a" } },
					{ type: "toolCall", id: "tcB", name: "bash", arguments: { command: "x" } },
				],
			}),
		);
		appendEntry(
			doc,
			makeEntry("trB", "a1", "2024-01-01T00:00:14Z", "tool_result", {
				toolCallId: "tcB",
				toolName: "bash",
				content: [],
				details: null,
				isError: false,
			}),
		);
		appendEntry(
			doc,
			makeEntry("trA", "trB", "2024-01-01T00:00:16Z", "tool_result", {
				toolCallId: "tcA",
				toolName: "read",
				content: [],
				details: null,
				isError: false,
			}),
		);
		appendEntry(
			doc,
			makeEntry("a2", "trA", "2024-01-01T00:00:20Z", "message", {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
			}),
		);
		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		expect(vm.turns).toHaveLength(2); // user + one merged run turn
		const t1 = vm.turns[1];
		expect(t1.kind).toBe("assistant");
		if (t1.kind === "assistant") {
			expect(t1.turnKey).toBe("a1");
			expect(t1.turnStartedAt).toBe("2024-01-01T00:00:00Z"); // user seal
			expect(t1.totalMs).toBe(20_000); // 00:00 → 00:20
			expect(t1.toolMs).toBe(6_000); // parallel batch max, not the 10s sum
		}
	});

	it("provisional trailing entry leaves totalMs/toolMs undefined (streaming)", () => {
		const doc = emptyDoc();
		appendEntry(doc, makeEntry("u1", null, "2024-01-01T00:00:00Z", "message", { role: "user", content: [] }));
		appendEntry(
			doc,
			makeEntry("a1", "u1", "2024-01-01T00:00:10Z", "message", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a" } }],
			}),
		);
		appendEntry(
			doc,
			makeEntry("tr1", "a1", "2024-01-01T00:00:16Z", "tool_result", {
				toolCallId: "tc1",
				toolName: "read",
				content: [],
				details: null,
				isError: false,
			}),
		);
		// Second assistant gen still streaming (provisional, no timestamp).
		doc.entries["pending:message"] = {
			kind: "message",
			id: "pending:message",
			parentId: "tr1",
			timestamp: "",
			role: "assistant",
			content: [{ type: "text", text: "" }],
		} as unknown as Document["entries"][string];
		doc.status.leafId = "pending:message";
		const vm = computeViewModel({ document: doc, sessions: [], models: [] });
		// One turn: gen1's tool call accumulated and joined the streaming
		// message's turn. The provisional entry keeps the turn unsealed —
		// totals stay undefined until it seals.
		const streaming = vm.turns[1];
		expect(streaming.kind).toBe("assistant");
		if (streaming.kind === "assistant") {
			expect(streaming.turnKey).toBe("a1");
			expect(streaming.blocks.map((b) => b.blockType)).toEqual(["tool", "text"]);
			expect(streaming.turnStartedAt).toBe("2024-01-01T00:00:00Z");
			expect(streaming.totalMs).toBeUndefined();
			expect(streaming.toolMs).toBeUndefined();
		}
	});
});

// ---------------------------------------------------------------------------
// newestLeafInSubtree
// ---------------------------------------------------------------------------

describe("newestLeafInSubtree", () => {
	it("returns the entryId itself for a leaf", () => {
		const doc = emptyDoc();
		doc.entries.leaf = makeEntry("leaf", "parent", "2024-01-01T00:00:00Z", "message", {
			role: "assistant",
			content: [],
		}) as unknown as Document["entries"][string];
		expect(newestLeafInSubtree("leaf", doc.entries)).toBe("leaf");
	});

	it("finds the newest descendant by timestamp", () => {
		const doc = emptyDoc();
		doc.entries.root = makeEntry("root", null, "2024-01-01T00:00:00Z", "message", {
			role: "user",
			content: [],
		}) as unknown as Document["entries"][string];
		doc.entries["child-a"] = makeEntry("child-a", "root", "2024-01-01T00:01:00Z", "message", {
			role: "assistant",
			content: [],
		}) as unknown as Document["entries"][string];
		doc.entries["child-b"] = makeEntry("child-b", "root", "2024-01-01T00:05:00Z", "message", {
			role: "assistant",
			content: [],
		}) as unknown as Document["entries"][string];
		doc.entries.grandchild = makeEntry("grandchild", "child-b", "2024-01-01T00:06:00Z", "message", {
			role: "assistant",
			content: [],
		}) as unknown as Document["entries"][string];

		expect(newestLeafInSubtree("root", doc.entries)).toBe("grandchild");
	});
});

// ---------------------------------------------------------------------------
// Identity preservation — TurnVM references across recomputations
// ---------------------------------------------------------------------------

describe("identity preservation", () => {
	it("preserves TurnVM reference when entry is structurally identical", () => {
		const doc = emptyDoc();
		doc.entries["a1"] = {
			kind: "message",
			id: "a1",
			parentId: null,
			timestamp: "2024-01-01T00:01:00Z",
			role: "assistant",
			content: [{ type: "text", text: "Hello" }],
		} as unknown as Document["entries"][string];
		doc.status.leafId = "a1";

		const vm1 = computeViewModel({ document: doc, sessions: [], models: [] });
		const vm2 = computeViewModel({ document: doc, sessions: [], models: [] }, vm1);

		expect(vm2.turns[0]).toBe(vm1.turns[0]);
	});

	it("preserves block VM references when block unchanged", () => {
		const content = [
			{ type: "thinking" as const, thinking: "hmm" },
			{ type: "toolCall" as const, id: "tc1", name: "read", arguments: '{"path":"a"}' },
		];
		const doc = emptyDoc();
		doc.entries["a1"] = {
			kind: "message",
			id: "a1",
			parentId: null,
			timestamp: "",
			role: "assistant",
			content,
		} as unknown as Document["entries"][string];
		doc.status.leafId = "a1";

		const vm1 = computeViewModel({ document: doc, sessions: [], models: [] });
		const vm2 = computeViewModel({ document: doc, sessions: [], models: [] }, vm1);

		const a1 = vm1.turns[0];
		const a2 = vm2.turns[0];
		expect(a1.kind).toBe("assistant");
		expect(a2.kind).toBe("assistant");
		if (a1.kind === "assistant" && a2.kind === "assistant") {
			expect(a2.blocks[0]).toBe(a1.blocks[0]);
			expect(a2.blocks[1]).toBe(a1.blocks[1]);
		}
	});

	it("returns new block VM when same-index content changes", () => {
		const doc1 = emptyDoc();
		doc1.entries["a1"] = {
			kind: "message",
			id: "a1",
			parentId: null,
			timestamp: "",
			role: "assistant",
			content: [{ type: "thinking", thinking: "hmm" }],
		} as unknown as Document["entries"][string];
		doc1.status.leafId = "a1";

		const vm1 = computeViewModel({ document: doc1, sessions: [], models: [] });

		// New document with a new thinking block at the same index
		const doc2 = emptyDoc();
		doc2.entries["a1"] = {
			kind: "message",
			id: "a1",
			parentId: null,
			timestamp: "",
			role: "assistant",
			content: [{ type: "thinking", thinking: "different" }],
		} as unknown as Document["entries"][string];
		doc2.status.leafId = "a1";

		const vm2 = computeViewModel({ document: doc2, sessions: [], models: [] }, vm1);
		const a1 = vm1.turns[0];
		const a2 = vm2.turns[0];
		if (a1.kind === "assistant" && a2.kind === "assistant") {
			expect(a2.blocks[0]).not.toBe(a1.blocks[0]);
		}
	});
});

describe("beautifyShellCommand — folded shell summaries", () => {
	const CWD = "/home/x/inst";

	it("folds a leading cd to a cwd-relative chip", () => {
		const segs = beautifyShellCommand(`cd ${CWD}/and/sub/dir && npm run check`, CWD);
		expect(segs).toEqual([
			{ kind: "fold", label: "cd and/sub/dir", original: `cd ${CWD}/and/sub/dir &&` },
			{ kind: "text", text: " " },
			{ kind: "cmd", text: "npm run" },
			{ kind: "text", text: " check" },
		]);
	});

	it("folds deep absolute paths to the last two segments", () => {
		const segs = beautifyShellCommand(`npm run check ${CWD}/and/sub/dir/to/path.tsx`, CWD);
		expect(segs).toEqual([
			{ kind: "cmd", text: "npm run" },
			{ kind: "text", text: " check " },
			{ kind: "fold", label: "...to/path.tsx", original: `${CWD}/and/sub/dir/to/path.tsx` },
		]);
	});

	it("combines fold rules with command chips", () => {
		const segs = beautifyShellCommand(`cd ${CWD}/sub && npm run check ${CWD}/sub/to/path.tsx`, CWD);
		expect(segs).toEqual([
			{ kind: "fold", label: "cd sub", original: `cd ${CWD}/sub &&` },
			{ kind: "text", text: " " },
			{ kind: "cmd", text: "npm run" },
			{ kind: "text", text: " check " },
			{ kind: "fold", label: "...to/path.tsx", original: `${CWD}/sub/to/path.tsx` },
		]);
	});

	it("leaves short and shallow paths alone", () => {
		expect(beautifyShellCommand("cat /tmp/a.ts", CWD)).toEqual([{ kind: "text", text: "cat /tmp/a.ts" }]);
		expect(beautifyShellCommand("echo hello", CWD)).toEqual([{ kind: "text", text: "echo hello" }]);
	});

	it("cd to the cwd itself folds to a no-op chip", () => {
		expect(beautifyShellCommand(`cd ${CWD} && npm test 2>&1 | tail -4`, CWD)).toEqual([
			{ kind: "fold", label: "cd;", original: `cd ${CWD} &&` },
			{ kind: "text", text: " " },
			{ kind: "cmd", text: "npm test" },
			{ kind: "text", text: " 2>&1 | tail -4" },
		]);
	});

	it("cd outside cwd keeps cd plain and elides the dir prefix", () => {
		// The cd target is an ancestor of the cwd — no cwd-relative form, so
		// "cd"/"&&" stay plain and the deep dir elides to a "…" chip + tail.
		const dir = "/home/hugh/project/agenty/pi";
		const cwd = "/home/hugh/project/agenty/pi/packages/bridge";
		expect(beautifyShellCommand(`cd ${dir} && npm run check`, cwd)).toEqual([
			{ kind: "text", text: "cd " },
			{ kind: "fold", label: "…", original: dir },
			{ kind: "text", text: "agenty/pi && " },
			{ kind: "cmd", text: "npm run" },
			{ kind: "text", text: " check" },
		]);
	});

	it("does not fold a cd outside cwd when eliding gains nothing", () => {
		expect(beautifyShellCommand("cd /tmp && ls", CWD)).toEqual([{ kind: "text", text: "cd /tmp && ls" }]);
		expect(beautifyShellCommand("cd /a/b && ls", CWD)).toEqual([{ kind: "text", text: "cd /a/b && ls" }]);
	});

	it("cd without a chained command is not folded", () => {
		expect(beautifyShellCommand("cd somewhere", CWD)).toEqual([{ kind: "text", text: "cd somewhere" }]);
	});

	it("chips the first command of every chained segment", () => {
		expect(beautifyShellCommand("git commit -m x && git push origin main", CWD)).toEqual([
			{ kind: "cmd", text: "git commit" },
			{ kind: "text", text: " -m x && " },
			{ kind: "cmd", text: "git push" },
			{ kind: "text", text: " origin main" },
		]);
		expect(beautifyShellCommand("cargo build --release | gzip > out.tgz", CWD)).toEqual([
			{ kind: "cmd", text: "cargo build" },
			{ kind: "text", text: " --release | " },
			{ kind: "cmd", text: "gzip" },
			{ kind: "text", text: " > out.tgz" },
		]);
	});

	it("boring commands stay plain", () => {
		expect(beautifyShellCommand("ls -la", CWD)).toEqual([{ kind: "text", text: "ls -la" }]);
		expect(beautifyShellCommand("cat a.ts | rg foo | head -5", CWD)).toEqual([
			{ kind: "text", text: "cat a.ts | rg foo | head -5" },
		]);
		expect(beautifyShellCommand("sed -n 1,5p x.ts && tail -3 y.ts", CWD)).toEqual([
			{ kind: "text", text: "sed -n 1,5p x.ts && tail -3 y.ts" },
		]);
	});

	it("non-command first tokens stay plain", () => {
		// assignment prefix and paths — only a plain-word first token chips
		expect(beautifyShellCommand("FOO=1 npm test", CWD)).toEqual([{ kind: "text", text: "FOO=1 npm test" }]);
		expect(beautifyShellCommand("./scripts/x.sh run", CWD)).toEqual([{ kind: "text", text: "./scripts/x.sh run" }]);
	});

	it("folds ../-prefixed path tokens whole — no dot collision with the label", () => {
		// Regression: the old regex started mid-token at "/node_modules/...",
		// leaving " .." plain text right before the "..." label ("......").
		expect(beautifyShellCommand("node ../../node_modules/vitest/dist/cli.js --run x", CWD)).toEqual([
			{ kind: "cmd", text: "node" },
			{ kind: "text", text: " " },
			{ kind: "fold", label: "...dist/cli.js", original: "../../node_modules/vitest/dist/cli.js" },
			{ kind: "text", text: " --run x" },
		]);
	});

	it("dot-only path tails stay plain", () => {
		expect(beautifyShellCommand("cd ../../a.ts && ls", "/somewhere/else")).toEqual([
			{ kind: "text", text: "cd ../../a.ts && ls" },
		]);
		expect(beautifyShellCommand("ls ../../..", CWD)).toEqual([{ kind: "text", text: "ls ../../.." }]);
	});

	it("paths not at a token boundary stay plain", () => {
		expect(beautifyShellCommand("grep --foo=/a/b/c/d.ts x", CWD)).toEqual([
			{ kind: "text", text: "grep --foo=/a/b/c/d.ts x" },
		]);
	});
});

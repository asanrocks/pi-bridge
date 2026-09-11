// ============================================================================
// Session accounting unit tests — sessionAccounting: session billing ledger
// over the wire document. Pure tests — no mirror, no WebSocket, no transport.
// Covers: empty doc, single-message sums, per-model grouping + sort,
// non-message entries ignored, hit-rate math.
// ============================================================================

import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/core/types.ts";
import { sessionAccounting } from "../../src/viewmodel/index.ts";

function makeAssistantEntry(id: string, extra: Partial<Record<string, unknown>>): Entry {
	return {
		id,
		parentId: null,
		timestamp: "2024-01-01T00:00:00Z",
		kind: "message",
		role: "assistant",
		content: [],
		provider: "anthropic",
		model: "claude-sonnet-4",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...extra,
	} as unknown as Entry;
}

describe("sessionAccounting", () => {
	it("returns a zero ledger for an empty document", () => {
		const acc = sessionAccounting({});
		expect(acc).toEqual({
			cost: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			requests: 0,
			hitRate: 0,
			byModel: [],
		});
	});

	it("sums usage from a single assistant message", () => {
		const acc = sessionAccounting({
			a1: makeAssistantEntry("a1", {
				provider: "anthropic",
				responseModel: "claude-sonnet-4",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 100,
					cacheWrite: 2,
					totalTokens: 117,
					cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.004, total: 0.064 },
				},
			}),
		});
		expect(acc.cost).toBeCloseTo(0.064);
		expect(acc.input).toBe(10);
		expect(acc.output).toBe(5);
		expect(acc.cacheRead).toBe(100);
		expect(acc.cacheWrite).toBe(2);
		expect(acc.requests).toBe(1);
		// 100 / (10 + 100) = 90.9%
		expect(acc.hitRate).toBeCloseTo(90.909, 2);
		expect(acc.byModel).toEqual([
			{
				key: "anthropic/claude-sonnet-4",
				provider: "anthropic",
				modelId: "claude-sonnet-4",
				cost: 0.064,
				tokens: 117,
				input: 10,
				output: 5,
				cacheRead: 100,
				cacheWrite: 2,
				requests: 1,
			},
		]);
	});

	it("groups by model and sorts by cost descending", () => {
		const acc = sessionAccounting({
			a1: makeAssistantEntry("a1", {
				provider: "anthropic",
				responseModel: "claude-sonnet-4",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.2 } },
			}),
			a2: makeAssistantEntry("a2", {
				provider: "openai",
				responseModel: "gpt-4o",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.8 } },
			}),
			a3: makeAssistantEntry("a3", {
				provider: "openai",
				responseModel: "gpt-4o",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.1 } },
			}),
		});
		expect(acc.cost).toBeCloseTo(1.1);
		expect(acc.requests).toBe(3);
		expect(acc.byModel.map((r) => r.key)).toEqual(["openai/gpt-4o", "anthropic/claude-sonnet-4"]);
		expect(acc.byModel[0].cost).toBeCloseTo(0.9);
		expect(acc.byModel[0].requests).toBe(2);
		expect(acc.byModel[1].cost).toBeCloseTo(0.2);
	});

	it("falls back to model when responseModel is absent", () => {
		const acc = sessionAccounting({
			a1: makeAssistantEntry("a1", {
				provider: "anthropic",
				responseModel: undefined,
				model: "claude-sonnet-4",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.01 } },
			}),
		});
		expect(acc.byModel[0].key).toBe("anthropic/claude-sonnet-4");
	});

	it("merges a responseModel snapshot alias into the requested model when it is not in the catalog", () => {
		const models = [{ provider: "volce", id: "glm-5.3", name: "GLM-5.3", reasoning: true }];
		const acc = sessionAccounting(
			{
				a1: makeAssistantEntry("a1", {
					provider: "volce",
					model: "glm-5.3",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 7.82 } },
				}),
				a2: makeAssistantEntry("a2", {
					provider: "volce",
					model: "glm-5.3",
					responseModel: "glm-5-3-260814",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 11.32 } },
				}),
			},
			models,
		);
		expect(acc.byModel).toEqual([
			{
				key: "volce/glm-5.3",
				provider: "volce",
				modelId: "glm-5.3",
				cost: 19.14,
				tokens: 4,
				input: 2,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				requests: 2,
			},
		]);
	});

	it("keeps a responseModel that resolves in the catalog (router-resolved model)", () => {
		const models = [
			{ provider: "openrouter", id: "anthropic/claude-4.6-sonnet", name: "Claude 4.6 Sonnet", reasoning: true },
		];
		const acc = sessionAccounting(
			{
				a1: makeAssistantEntry("a1", {
					provider: "openrouter",
					model: "auto",
					responseModel: "anthropic/claude-4.6-sonnet",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.5 } },
				}),
			},
			models,
		);
		expect(acc.byModel[0].key).toBe("openrouter/anthropic/claude-4.6-sonnet");
	});

	it("trusts the reported id when the catalog is absent or empty", () => {
		const entry = {
			a1: makeAssistantEntry("a1", {
				provider: "volce",
				model: "glm-5.3",
				responseModel: "glm-5-3-260814",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 1 } },
			}),
		};
		expect(sessionAccounting(entry).byModel[0].key).toBe("volce/glm-5-3-260814");
		expect(sessionAccounting(entry, []).byModel[0].key).toBe("volce/glm-5-3-260814");
	});

	it("ignores user, tool_result, compaction, and other non-usage entries", () => {
		const acc = sessionAccounting({
			u1: {
				id: "u1",
				parentId: null,
				timestamp: "2024-01-01T00:00:00Z",
				kind: "message",
				role: "user",
				content: [{ type: "text", text: "hi" }],
			} as unknown as Entry,
			t1: {
				id: "t1",
				parentId: "a1",
				timestamp: "2024-01-01T00:00:00Z",
				kind: "tool_result",
				toolCallId: "tc1",
				toolName: "bash",
				content: null,
				details: {},
				isError: false,
			} as unknown as Entry,
			c1: {
				id: "c1",
				parentId: "t1",
				timestamp: "2024-01-01T00:00:00Z",
				kind: "compaction",
				summary: "sum",
				firstKeptEntryId: "a1",
				tokensBefore: 100,
				details: null,
				fromHook: false,
			} as unknown as Entry,
			a1: makeAssistantEntry("a1", {
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.07 } },
			}),
		});
		expect(acc.cost).toBeCloseTo(0.07);
		expect(acc.requests).toBe(1);
		expect(acc.byModel).toHaveLength(1);
	});

	it("ignores assistant entries without usage (provisional/error)", () => {
		const acc = sessionAccounting({
			a1: makeAssistantEntry("a1", { usage: undefined }),
		});
		expect(acc.requests).toBe(0);
		expect(acc.cost).toBe(0);
		expect(acc.byModel).toEqual([]);
	});

	it("computes hit rate across the whole session, not per request", () => {
		const acc = sessionAccounting({
			a1: makeAssistantEntry("a1", {
				usage: { input: 0, output: 1, cacheRead: 100, cacheWrite: 0, totalTokens: 101, cost: { total: 0.1 } },
			}),
			a2: makeAssistantEntry("a2", {
				usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 101, cost: { total: 0.1 } },
			}),
		});
		// 100 / (100 + 100) = 50%
		expect(acc.hitRate).toBeCloseTo(50, 5);
	});
});

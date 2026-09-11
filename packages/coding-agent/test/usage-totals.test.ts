import { describe, expect, it } from "vitest";
import { billingModelId, getUsageCostBreakdown, type ModelCatalogSource } from "../src/core/usage-totals.ts";

/** Fake catalog over an explicit [provider, modelId] allowlist. */
function catalog(...ids: [string, string][]): ModelCatalogSource {
	return {
		getModel: (provider, modelId) =>
			ids.some(([p, id]) => p === provider && id === modelId) ? { id: modelId } : undefined,
	};
}

function assistantEntry(provider: string, model: string, responseModel: string | undefined, cost: number) {
	return {
		type: "message" as const,
		id: `${provider}/${model}/${responseModel ?? "-"}:${cost}`,
		parentId: null,
		timestamp: "2026-09-01T00:00:00Z",
		message: {
			role: "assistant" as const,
			content: [],
			api: "openai-completions" as const,
			provider,
			model,
			...(responseModel ? { responseModel } : {}),
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
			},
			stopReason: "stop" as const,
			timestamp: 1,
		},
	};
}

describe("billingModelId", () => {
	it("returns the requested model when there is no responseModel", () => {
		expect(billingModelId({ provider: "volce", model: "glm-5.3" })).toBe("glm-5.3");
	});

	it("returns the requested model when the responseModel matches it", () => {
		expect(billingModelId({ provider: "volce", model: "glm-5.3", responseModel: "glm-5.3" })).toBe("glm-5.3");
	});

	it("trusts the reported id when no catalog is given", () => {
		expect(billingModelId({ provider: "volce", model: "glm-5.3", responseModel: "glm-5-3-260814" })).toBe(
			"glm-5-3-260814",
		);
	});

	it("keeps a reported id that resolves in the catalog (router-resolved model)", () => {
		expect(
			billingModelId(
				{ provider: "openrouter", model: "auto", responseModel: "anthropic/claude-4.6-sonnet" },
				catalog(["openrouter", "anthropic/claude-4.6-sonnet"]),
			),
		).toBe("anthropic/claude-4.6-sonnet");
	});

	it("falls back to the requested model when the reported id is not in the catalog (snapshot alias)", () => {
		expect(
			billingModelId(
				{ provider: "volce", model: "glm-5.3", responseModel: "glm-5-3-260814" },
				catalog(["volce", "glm-5.3"]),
			),
		).toBe("glm-5.3");
	});
});

describe("getUsageCostBreakdown", () => {
	it("merges a snapshot alias into the requested model's bucket", () => {
		const entries = [
			assistantEntry("volce", "glm-5.3", undefined, 7.82),
			assistantEntry("volce", "glm-5.3", "glm-5-3-260814", 11.32),
		];
		expect(getUsageCostBreakdown(entries, catalog(["volce", "glm-5.3"]))).toEqual([
			{ key: "volce/glm-5.3", cost: 19.14, tokens: 4 },
		]);
	});

	it("still groups router-resolved models separately when they are catalog entries", () => {
		const entries = [
			assistantEntry("openrouter", "auto", "anthropic/claude-4.6-sonnet", 1),
			assistantEntry("openrouter", "auto", "openai/gpt-5.5", 2),
		];
		const models = catalog(["openrouter", "anthropic/claude-4.6-sonnet"], ["openrouter", "openai/gpt-5.5"]);
		expect(getUsageCostBreakdown(entries, models).map((e) => e.key)).toEqual([
			"openrouter/openai/gpt-5.5",
			"openrouter/anthropic/claude-4.6-sonnet",
		]);
	});

	it("trusts reported ids when no catalog is given (previous behavior)", () => {
		const entries = [
			assistantEntry("volce", "glm-5.3", undefined, 7.82),
			assistantEntry("volce", "glm-5.3", "glm-5-3-260814", 11.32),
		];
		expect(getUsageCostBreakdown(entries).map((e) => e.key)).toEqual(["volce/glm-5-3-260814", "volce/glm-5.3"]);
	});
});

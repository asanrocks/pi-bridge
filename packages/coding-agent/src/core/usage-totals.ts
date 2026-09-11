import type { Usage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "./session-manager.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

/**
 * Minimal model-catalog lookup, satisfied by ModelRuntime. Existence check
 * only — used to decide whether a response-reported model id is a real
 * catalog entry.
 */
export interface ModelCatalogSource {
	getModel(provider: string, modelId: string): unknown;
}

/**
 * Billing identity of an assistant message. Prefers the response-reported
 * model when it resolves in the catalog (router providers like OpenRouter
 * `auto` resolve to a concrete catalog entry); falls back to the requested
 * model otherwise, so gateways that report unstable snapshot aliases for one
 * model (e.g. `glm-5-3-260814` for `glm-5.3`) don't split the ledger.
 * Without a catalog, the reported id is trusted (previous behavior).
 */
export function billingModelId(
	message: { provider: string; model: string; responseModel?: string },
	models?: ModelCatalogSource,
): string {
	const reported = message.responseModel;
	if (reported && reported !== message.model) {
		if (!models || models.getModel(message.provider, reported) !== undefined) {
			return reported;
		}
	}
	return message.model;
}

/** Group attributable assistant usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[], models?: ModelCatalogSource): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();

	for (const entry of entries) {
		let key: string | undefined;
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			key = `${entry.message.provider}/${billingModelId(entry.message, models)}`;
			usage = entry.message.usage;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			key = "Tools/summaries";
			usage = entry.message.usage;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			key = "Tools/summaries";
			usage = entry.usage;
		}
		if (!key || !usage) continue;

		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		addUsageToTotals(totals, usage);
	}

	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);
}

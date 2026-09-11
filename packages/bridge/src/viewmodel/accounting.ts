// ============================================================================
// accounting — session billing ledger over the wire document.
//
// The server attests per-message usage (pi-ai computes each request's cost
// from model pricing); the client aggregates — it never recomputes cost,
// since pricing tables live server-side. This sums usage over ALL entries
// in the document, regardless of branch or compaction, so the ledger is:
//   - monotonic (cost never drops after compaction, unlike the server's
//     thread-scoped /status/stats which skips pre-compaction messages),
//   - navigation-invariant (browsing side branches doesn't change it),
//   - consistent with pi-tui's session totals (summed billed tokens + cost).
//
// Only assistant message entries carry usage on the wire (the projection
// drops tool/compaction usage, which real sessions don't populate anyway —
// verified against fixtures: 0/448 tool results have usage).
//
// Pure + browser-safe: no node:* imports, no DOM.
// ============================================================================

import type { Entry, MessageEntry, ModelInfo } from "../core/types.ts";

/** Cost/token rollup for one model. `key` is the grouping identity
 * (`provider/responseModel`); `provider`/`modelId` are carried separately so
 * the UI can resolve display names from the model catalog. */
export interface ModelCostRow {
	key: string;
	provider: string;
	modelId: string;
	cost: number;
	tokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	requests: number;
}

export interface SessionAccounting {
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Count of usage-bearing (assistant) messages. */
	requests: number;
	/** Session-total cache hit rate, 0–100; 0 when no prompt tokens. */
	hitRate: number;
	/** Per-model rows, sorted by cost descending. */
	byModel: ModelCostRow[];
}

export function sessionAccounting(
	entries: Record<string, Entry>,
	/** Daemon model catalog; when absent or empty, reported ids are trusted
	 * as-is (the client may not have loaded the catalog yet). */
	models?: readonly ModelInfo[],
): SessionAccounting {
	let cost = 0;
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let requests = 0;
	const byModel = new Map<string, ModelCostRow>();

	for (const e of Object.values(entries)) {
		if (e.kind !== "message" || !e.usage) continue;
		const u = e.usage;
		const c = u.cost.total;
		const ic = u.input;
		const oc = u.output;
		const cr = u.cacheRead;
		const cw = u.cacheWrite;
		cost += c;
		input += ic;
		output += oc;
		cacheRead += cr;
		cacheWrite += cw;
		requests++;

		const modelId = billingModelId(e, models);
		const key = `${e.provider}/${modelId}`;
		let row = byModel.get(key);
		if (!row) {
			row = {
				key,
				provider: e.provider ?? "",
				modelId: modelId ?? "",
				cost: 0,
				tokens: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				requests: 0,
			};
			byModel.set(key, row);
		}
		row.cost += c;
		row.tokens += ic + oc + cr + cw;
		row.input += ic;
		row.output += oc;
		row.cacheRead += cr;
		row.cacheWrite += cw;
		row.requests++;
	}

	/**
	 * Billing identity of a message entry. Prefers the response-reported model
	 * when it resolves in the catalog (router providers resolve to a concrete
	 * catalog entry); falls back to the requested model otherwise, so gateways
	 * that report unstable snapshot aliases for one model (e.g.
	 * `glm-5-3-260814` for `glm-5.3`) don't split the ledger. Without a catalog
	 * (not passed or not yet loaded), the reported id is trusted.
	 */
	function billingModelId(
		e: Pick<MessageEntry, "provider" | "model" | "responseModel">,
		models?: readonly ModelInfo[],
	): string | undefined {
		const reported = e.responseModel;
		if (reported && reported !== e.model) {
			if (!models || models.length === 0) return reported;
			if (models.some((m) => m.provider === e.provider && m.id === reported)) return reported;
		}
		return e.model;
	}

	const promptTokens = input + cacheRead;
	const hitRate = promptTokens > 0 ? (cacheRead / promptTokens) * 100 : 0;
	const byModelSorted = Array.from(byModel.values()).sort((a, b) => b.cost - a.cost);

	return { cost, input, output, cacheRead, cacheWrite, requests, hitRate, byModel: byModelSorted };
}

// ============================================================================
// modelNames — model + provider display names from the daemon's model
// catalog (ModelInfo), with fallback heuristics for ids/providers not in
// the catalog. Shared by the system-status switch line (SystemTurnView)
// and the cost popover breakdown.
// ============================================================================

import type { ModelInfo } from "../../../src/core/index.ts";

/** Display name for the model, from the daemon's curated list; fallback
 * heuristic ("deepseek-v4-flash" → "DeepSeek V4 Flash") for ids not listed. */
export function displayModelName(provider: string, modelId: string, models: readonly ModelInfo[]): string {
	const found = models.find((m) => m.provider === provider && m.id === modelId);
	if (found?.name) return found.name;
	return modelId
		.split("-")
		.map((seg) => (seg ? seg[0].toUpperCase() + seg.slice(1) : seg))
		.join(" ");
}

/** Provider display name from pi's Provider registry (via ModelInfo.providerName);
 * fallback heuristic ("my-provider" → "My Provider") for unknown providers. */
export function displayProviderName(provider: string, models: readonly ModelInfo[]): string {
	const found = models.find((m) => m.provider === provider);
	if (found?.providerName) return found.providerName;
	return provider
		.split(/[-_]/)
		.map((seg) => (seg ? seg[0].toUpperCase() + seg.slice(1) : seg))
		.join(" ");
}

/** Combined role label "Name (Provider)"; omits the provider part when the
 * provider is unknown (empty string). The single composition used by all
 * turn headers and the cost-popover breakdown. */
export function displayModelLabel(provider: string, modelId: string, models: readonly ModelInfo[]): string {
	const name = displayModelName(provider, modelId, models);
	return provider ? `${name} (${displayProviderName(provider, models)})` : name;
}

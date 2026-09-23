// ============================================================================
// modelGroups — the picker's three tiers (ADR 15). A curated Pinned group at
// the top, then one group per provider holding the whole catalogue. Within a
// provider group the "normal" tier (models matching a `visibleModels` pattern,
// plus every pinned model — pinning is a promotion) is shown and the folded
// tail is hidden behind that group's own `More…` row, revealed in place. Pure:
// the portal owns the per-group reveal state and rendering only.
//
// With no `visibleModels` configured, nothing folds and this reproduces the
// pre-filter grouping exactly.
// ============================================================================

import type { ModelInfo, PinnedModelInfo } from "../../../../src/core/index.ts";
import { displayProviderName } from "../../render/modelNames.ts";

type CatModel = ModelInfo | PinnedModelInfo;

export interface ModelGroup {
	/** Stable React key: the provider id, or `Pinned`. */
	key: string;
	label: string;
	/** Models always shown in the group (the normal tier). */
	items: CatModel[];
	/** The group's hidden tail, revealed in place by the group's `More…` row. */
	folded: CatModel[];
}

function keyOf(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function matchesQuery(model: { provider: string; id: string; name: string }, query: string): boolean {
	return (
		model.name.toLowerCase().includes(query) ||
		model.provider.toLowerCase().includes(query) ||
		model.id.toLowerCase().includes(query)
	);
}

/** Group a normal tier and a folded tier by provider, carrying each provider's
 * hidden tail on its own group. A provider with only folded models still emits
 * a group (its `More…` row is the whole group). Ordered ascending by total size
 * (shown + folded) so niche providers are not buried under large catalogues;
 * stable, so ties keep catalogue order. */
function providerGroups(normal: CatModel[], folded: CatModel[], models: ModelInfo[]): ModelGroup[] {
	const byProvider = new Map<string, ModelGroup>();
	const ensure = (provider: string): ModelGroup => {
		let group = byProvider.get(provider);
		if (!group) {
			group = { key: provider, label: displayProviderName(provider, models), items: [], folded: [] };
			byProvider.set(provider, group);
		}
		return group;
	};
	for (const m of normal) ensure(m.provider).items.push(m);
	for (const m of folded) ensure(m.provider).folded.push(m);
	return [...byProvider.values()].sort(
		(a, b) => a.items.length + a.folded.length - (b.items.length + b.folded.length),
	);
}

export interface ModelGroupsInput {
	models: ModelInfo[];
	/** The daemon-global pinned list (ADR 15). */
	pinnedModels: PinnedModelInfo[];
	/** Resolved `provider/modelId` keys of the normal tier. Empty = no filter. */
	visibleModels: string[];
	search: string;
}

export function buildModelGroups(input: ModelGroupsInput): ModelGroup[] {
	const { models, pinnedModels, visibleModels, search } = input;
	const query = search.trim().toLowerCase();

	// Searching bypasses the tiers: the curated group hides and every match
	// stays findable in its provider group, folded models included.
	if (query) {
		return providerGroups(
			models.filter((m) => matchesQuery(m, query)),
			[],
			models,
		);
	}

	// Only "Pinned" — no Suggested fallback; an empty pinned list emits no
	// curated group. The provider groups below always hold the whole catalogue,
	// so a pinned model is never missing from its list. Pinning is a promotion:
	// a pinned model stays in the normal tier even when `visibleModels`
	// excludes it (that config folds the long tail, not the user's picks).
	const pinnedKeys = new Set(pinnedModels.map(keyOf));
	const visible = new Set(visibleModels);
	const folding = visibleModels.length > 0;
	const isNormal = (m: ModelInfo | PinnedModelInfo) => !folding || visible.has(keyOf(m)) || pinnedKeys.has(keyOf(m));
	const normal = models.filter(isNormal);
	const folded = folding ? models.filter((m) => !isNormal(m)) : [];

	const curated: ModelGroup[] =
		pinnedModels.length > 0 ? [{ key: "Pinned", label: "Pinned", items: pinnedModels, folded: [] }] : [];

	return [...curated, ...providerGroups(normal, folded, models)];
}

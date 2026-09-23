// Unit tests for the picker's three-tier grouping (ADR 15): Pinned, normal,
// folded. Pure, so the portal stays a render shell. There is no Suggested
// fallback — an empty pinned list emits no curated group.
//
// `pinnedModels` / `visibleModels` here are the wire shapes: resolved lists,
// not the raw minimatch patterns in the settings files.

import { describe, expect, it } from "vitest";
import type { ModelInfo, PinnedModelInfo } from "../../../../src/core/index.ts";
import { buildModelGroups } from "./modelGroups.ts";

function model(provider: string, id: string): ModelInfo {
	return { provider, id, name: id, reasoning: false };
}

const MODELS: ModelInfo[] = [model("faux", "faux-1"), model("faux", "faux-2"), model("anthropic", "claude-sonnet-4-5")];

function keys(items: { provider: string; id: string }[]): string[] {
	return items.map((m) => `${m.provider}/${m.id}`);
}

describe("buildModelGroups", () => {
	it("with no pinned models, emits no curated group and lists every provider", () => {
		const groups = buildModelGroups({ models: MODELS, pinnedModels: [], visibleModels: [], search: "" });
		// Providers sort ascending by count (Anthropic's 1 before Faux's 2).
		expect(groups.map((g) => g.label)).toEqual(["Anthropic", "Faux"]);
		expect(groups.every((g) => g.folded.length === 0)).toBe(true);
	});

	it("keeps a pinned model in the Pinned group and its provider group", () => {
		const pinned: PinnedModelInfo[] = [{ provider: "faux", id: "faux-1", name: "faux-1" }];
		const groups = buildModelGroups({ models: MODELS, pinnedModels: pinned, visibleModels: [], search: "" });
		expect(groups[0]).toMatchObject({ label: "Pinned" });
		expect(keys(groups[0].items)).toEqual(["faux/faux-1"]);
		// The provider group holds the whole catalogue, pinned included: it is not
		// removed just because it is also in the Pinned group.
		const fauxGroup = groups.find((g) => g.label === "Faux");
		expect(keys(fauxGroup?.items ?? [])).toEqual(["faux/faux-1", "faux/faux-2"]);
	});

	it("hides a provider's excluded models on that provider's own group", () => {
		const groups = buildModelGroups({
			models: MODELS,
			pinnedModels: [],
			visibleModels: ["anthropic/claude-sonnet-4-5"],
			search: "",
		});
		// Anthropic keeps its visible model; Faux has nothing visible, so its
		// whole group is the folded tail behind the group's More row.
		const anthropic = groups.find((g) => g.label === "Anthropic");
		expect(keys(anthropic?.items ?? [])).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(anthropic?.folded).toEqual([]);
		const faux = groups.find((g) => g.label === "Faux");
		expect(faux?.items).toEqual([]);
		expect(keys(faux?.folded ?? [])).toEqual(["faux/faux-1", "faux/faux-2"]);
	});

	it("carries a provider's shown and hidden models on the same group", () => {
		const groups = buildModelGroups({
			models: MODELS,
			pinnedModels: [],
			visibleModels: ["faux/faux-1"],
			search: "",
		});
		const faux = groups.find((g) => g.label === "Faux");
		expect(keys(faux?.items ?? [])).toEqual(["faux/faux-1"]);
		expect(keys(faux?.folded ?? [])).toEqual(["faux/faux-2"]);
		const anthropic = groups.find((g) => g.label === "Anthropic");
		expect(anthropic?.items).toEqual([]);
		expect(keys(anthropic?.folded ?? [])).toEqual(["anthropic/claude-sonnet-4-5"]);
	});

	it("keeps a pinned model in the normal tier even when visibleModels excludes it", () => {
		const pinned: PinnedModelInfo[] = [{ provider: "faux", id: "faux-1", name: "faux-1" }];
		const groups = buildModelGroups({
			models: MODELS,
			pinnedModels: pinned,
			visibleModels: ["anthropic/claude-sonnet-4-5"],
			search: "",
		});
		// Pinning is a promotion: faux-1 shows, faux-2 (excluded, unpinned) folds.
		const faux = groups.find((g) => g.label === "Faux");
		expect(keys(faux?.items ?? [])).toEqual(["faux/faux-1"]);
		expect(keys(faux?.folded ?? [])).toEqual(["faux/faux-2"]);
		const anthropic = groups.find((g) => g.label === "Anthropic");
		expect(keys(anthropic?.items ?? [])).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(anthropic?.folded).toEqual([]);
	});

	it("bypasses the tiers while searching so folded models stay findable", () => {
		const groups = buildModelGroups({
			models: MODELS,
			pinnedModels: [],
			visibleModels: ["anthropic/claude-sonnet-4-5"],
			search: "faux-2",
		});
		expect(groups).toHaveLength(1);
		expect(keys(groups[0].items)).toEqual(["faux/faux-2"]);
		expect(groups[0].folded).toEqual([]);
	});
});

// ============================================================================
// Regression: same model id, different providers.
//
// Before the fix, Status.model was a bare id string — the provider was dropped
// at deriveModel / reconcile / manager boundaries. That broke three things
// when two providers offered the same model id (e.g. "claude-sonnet-4-5"
// under both Anthropic and an OpenRouter-compatible provider):
//   1. Ctrl+P cycle started from the wrong provider's slot (findIndex matched
//      the first same-id model across providers).
//   2. The ghost button showed whichever provider sorted first in models.find.
//   3. The picker highlighted *both* same-id rows as selected.
//
// Root cause: Status.model now carries { provider, modelId } (ModelRef),
// mirroring ModelChangeEntry. These tests pin the pair at every boundary it
// crosses: deriveModel, reconcile (patch + no-op equality), findNextModel
// (cycle), and isModelSelected (picker highlight).
// ============================================================================

import { describe, expect, it } from "vitest";
import {
	applyPatch,
	type Document,
	initFromEntries,
	type JsonValue,
	type ModelRef,
	reconcile,
	setAtPath,
} from "../../src/core/index.ts";
import { findNextModel, isModelSelected, type ModelRefLike } from "../../src/viewmodel/index.ts";

// Minimal catalog entry shape (ModelInfo / ScopedModelInfo both satisfy this).
interface Cat {
	provider: string;
	id: string;
	name: string;
}

const A_SHARED: Cat = { provider: "faux-a", id: "shared", name: "A Shared" };
const A_OTHER: Cat = { provider: "faux-a", id: "other", name: "A Other" };
const B_SHARED: Cat = { provider: "faux-b", id: "shared", name: "B Shared" };

// Two providers, same id "shared", plus an unrelated faux-a model.
const COLLIDING_CATALOG: Cat[] = [A_SHARED, A_OTHER, B_SHARED];

describe("model ref disambiguation — document layer", () => {
	it("deriveModel keeps the provider of the latest model_change (not the first id match)", () => {
		// A faux-b model_change seals AFTER a faux-a one with the same id.
		// Latest-wins must yield faux-b's provider, not faux-a's, and not "".
		const entries = [
			{
				type: "model_change" as const,
				id: "mc1",
				parentId: null,
				timestamp: "t1",
				provider: "faux-a",
				modelId: "shared",
			},
			{
				type: "model_change" as const,
				id: "mc2",
				parentId: null,
				timestamp: "t2",
				provider: "faux-b",
				modelId: "shared",
			},
		];
		const doc = initFromEntries(entries as unknown as Parameters<typeof initFromEntries>[0]);
		expect(doc.status.model).toEqual({ provider: "faux-b", modelId: "shared" });
	});

	it("reconcile emits a replace /status/model patch when only the provider differs", () => {
		// Same id, different provider — must still patch (the pre-fix id-only
		// comparison would have seen "shared" === "shared" and skipped).
		let doc: Document = initFromEntries([]);
		doc = setAtPath(doc, "/status/model", {
			provider: "faux-a",
			modelId: "shared",
		} as unknown as JsonValue);

		const patch = reconcile(doc, [], { model: { provider: "faux-b", modelId: "shared" } });
		expect(patch).not.toBeNull();
		const modelOps = patch!.ops.filter((o) => o.path === "/status/model");
		expect(modelOps).toHaveLength(1);
		expect(modelOps[0]).toEqual({
			op: "replace",
			path: "/status/model",
			value: { provider: "faux-b", modelId: "shared" } as unknown as JsonValue,
		});
	});

	it("reconcile does NOT emit a model patch when the full pair is unchanged", () => {
		// Guards against a reference-inequality regression: a fresh {provider,
		// modelId} literal must compare equal to the stored pair field-wise,
		// else every reconcile would emit a spurious replace.
		const doc: Document = initFromEntries([]);
		const ref: ModelRef = { provider: "faux-a", modelId: "shared" };
		const withModel = setAtPath(doc, "/status/model", ref as unknown as JsonValue);
		const patch = reconcile(withModel, [], { model: { provider: "faux-a", modelId: "shared" } });
		const modelOps = patch?.ops.filter((o) => o.path === "/status/model") ?? [];
		expect(modelOps).toHaveLength(0);
	});

	it("the pair survives a patch round-trip through applyPatch", () => {
		let doc: Document = initFromEntries([]);
		doc = applyPatch(doc, [
			{
				op: "replace",
				path: "/status/model",
				value: { provider: "faux-a", modelId: "shared" } as unknown as JsonValue,
			},
		]);
		expect(doc.status.model).toEqual({ provider: "faux-a", modelId: "shared" });
	});
});

describe("model ref disambiguation — cycle (Ctrl+P)", () => {
	it("cycles forward from the correct provider's slot, not the first id match", () => {
		// Active = faux-a/shared. Forward must land on faux-a/other (index 1),
		// NOT faux-b/shared (index 2) — which is where a bare-id findIndex
		// starting at the first "shared" would still misbehave, but the key
		// point is the next-after position is faux-a's, computed from the
		// provider-qualified location.
		const next = findNextModel(COLLIDING_CATALOG, { provider: "faux-a", modelId: "shared" }, "forward");
		expect(next).toBe(A_OTHER);
	});

	it("cycles backward from faux-a/shared to faux-b/shared (wrap)", () => {
		const next = findNextModel(COLLIDING_CATALOG, { provider: "faux-a", modelId: "shared" }, "backward");
		expect(next).toBe(B_SHARED);
	});

	it("faux-b/shared cycles independently of faux-a/shared", () => {
		// Same id, different provider — forward from faux-b wraps to index 0
		// (faux-a/shared), proving the two same-id providers are distinct slots.
		const next = findNextModel(COLLIDING_CATALOG, { provider: "faux-b", modelId: "shared" }, "forward");
		expect(next).toBe(A_SHARED);
	});

	it("returns undefined for an empty catalog", () => {
		expect(findNextModel([], { provider: "faux-a", modelId: "shared" }, "forward")).toBeUndefined();
	});
});

describe("model ref disambiguation — picker highlight", () => {
	it("selects only the matching provider's row, not every same-id row", () => {
		const ref: ModelRef = { provider: "faux-a", modelId: "shared" };
		// faux-a/shared matches; faux-b/shared (same id, different provider) must NOT.
		expect(isModelSelected(A_SHARED as ModelRefLike, ref)).toBe(true);
		expect(isModelSelected(B_SHARED as ModelRefLike, ref)).toBe(false);
		expect(isModelSelected(A_OTHER as ModelRefLike, ref)).toBe(false);
	});

	it("selects the faux-b row only when faux-b is active", () => {
		const ref: ModelRef = { provider: "faux-b", modelId: "shared" };
		expect(isModelSelected(B_SHARED as ModelRefLike, ref)).toBe(true);
		expect(isModelSelected(A_SHARED as ModelRefLike, ref)).toBe(false);
	});
});

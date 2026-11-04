// ============================================================================
// Regression: same model id, different providers.
//
// Before the fix, Status.model was a bare id string — the provider was dropped
// at deriveModel / manager boundaries. That broke three things
// when two providers offered the same model id (e.g. "claude-sonnet-4-5"
// under both Anthropic and an OpenRouter-compatible provider):
//   1. Ctrl+P cycle started from the wrong provider's slot (findIndex matched
//      the first same-id model across providers).
//   2. The ghost button showed whichever provider sorted first in models.find.
//   3. The picker highlighted *both* same-id rows as selected.
//
// Root cause: Status.model now carries { provider, modelId } (ModelRef),
// mirroring ModelChangeEntry. These tests pin the pair at every boundary it
// crosses: deriveModel, applyPatch (status round-trip), findNextModel
// (cycle), and isModelSelected (picker highlight). The Manager's refresh
// boundary — which repairs status.model drift — is pinned by the manager
// verbs suite.
// ============================================================================

import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/core/index.ts";
import { applyPatch, type Document, initFromEntries, type JsonValue, type ModelRef } from "../../src/core/index.ts";
import {
	findNextModel,
	inheritModelForPath,
	inheritThinkingLevelForPath,
	isModelSelected,
	type ModelRefLike,
} from "../../src/viewmodel/index.ts";

// Minimal catalog entry shape (ModelInfo / PinnedModelInfo both satisfy this).
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

// ---------------------------------------------------------------------------
// Path inheritance — the stateless client API's send-time heuristic.
// ---------------------------------------------------------------------------

describe("model ref disambiguation — path inheritance", () => {
	/** A path root → mc(faux-a/shared) → assistant → user, plus an abandoned
	 * sibling branch carrying a LATER model_change to faux-b/shared. Inheritance
	 * walks the parent chain, so the off-branch entry must never win (unlike
	 * deriveStatus, which is a whole-map paint hint). */
	function branchedEntries(): Record<string, Entry> {
		return {
			mc: {
				kind: "model_change",
				id: "mc",
				parentId: null,
				timestamp: "t1",
				provider: "faux-a",
				modelId: "shared",
				ord: 0,
			},
			assistant: {
				kind: "message",
				id: "assistant",
				parentId: "mc",
				timestamp: "t2",
				role: "assistant",
				content: [],
				provider: "faux-a",
				model: "shared",
				ord: 1,
			},
			user: {
				kind: "message",
				id: "user",
				parentId: "assistant",
				timestamp: "t3",
				role: "user",
				content: [],
				ord: 2,
			},
			// Abandoned branch: higher ord, different path.
			branchy: {
				kind: "model_change",
				id: "branchy",
				parentId: "assistant",
				timestamp: "t4",
				provider: "faux-b",
				modelId: "shared",
				ord: 3,
			},
		};
	}

	it("inherits the path's last model_change, ignoring later entries on other branches", () => {
		const entries = branchedEntries();
		expect(inheritModelForPath(entries, "user")).toEqual({ provider: "faux-a", modelId: "shared" });
		expect(inheritModelForPath(entries, "branchy")).toEqual({ provider: "faux-b", modelId: "shared" });
	});

	it("falls back to the producer of the path's last assistant message", () => {
		const entries: Record<string, Entry> = {
			assistant: {
				kind: "message",
				id: "assistant",
				parentId: null,
				timestamp: "t1",
				role: "assistant",
				content: [],
				provider: "faux-b",
				model: "shared",
				ord: 0,
			},
			user: {
				kind: "message",
				id: "user",
				parentId: "assistant",
				timestamp: "t2",
				role: "user",
				content: [],
				ord: 1,
			},
		};
		expect(inheritModelForPath(entries, "user")).toEqual({ provider: "faux-b", modelId: "shared" });
	});

	it("returns null when the path records nothing", () => {
		expect(inheritModelForPath({}, null)).toBeNull();
		const entries: Record<string, Entry> = {
			user: { kind: "message", id: "user", parentId: null, timestamp: "t1", role: "user", content: [], ord: 0 },
		};
		expect(inheritModelForPath(entries, "user")).toBeNull();
	});

	it("inherits the path's last thinking_level_change, null when the path records none", () => {
		const entries = branchedEntries();
		expect(inheritThinkingLevelForPath(entries, "user")).toBeNull();
		entries.tlc = {
			kind: "thinking_level_change",
			id: "tlc",
			parentId: "assistant",
			timestamp: "t5",
			thinkingLevel: "high",
			ord: 4,
		};
		// tlc hangs off the assistant like the abandoned branch: the user path
		// still records none, the tlc path records "high".
		expect(inheritThinkingLevelForPath(entries, "user")).toBeNull();
		expect(inheritThinkingLevelForPath(entries, "tlc")).toBe("high");
	});
});

// ============================================================================
// pinnedEdit tests — the picker's list edits (ADR 20): append-on-pin,
// remove-on-unpin, a move by index, and the wire shape that round-trips a
// level.
// ============================================================================

import { describe, expect, it } from "vitest";
import type { PinnedModelInfo, PinnedModelSelection } from "../../../../src/core/index.ts";
import { movePinnedEntry, pinnedSelectionOf, pinnedSelectionsOf, withPinned } from "./pinnedEdit.ts";

const A: PinnedModelSelection = { provider: "faux", id: "a" };
const B: PinnedModelSelection = { provider: "faux", id: "b" };
const C: PinnedModelSelection = { provider: "faux", id: "c" };

describe("pinnedEdit — membership", () => {
	it("pins to the tail, so a new pin is never the default", () => {
		expect(withPinned([A, B], C, true)).toEqual([A, B, C]);
	});

	it("unpins by identity and leaves the order alone", () => {
		expect(withPinned([A, B, C], B, false)).toEqual([A, C]);
	});

	it("is idempotent for an absent unpin and an existing pin", () => {
		expect(withPinned([A, C], B, false)).toEqual([A, C]);
		expect(withPinned([A, B], B, true)).toEqual([A, B]);
	});

	it("keys on provider, so same-id models from different providers stay distinct", () => {
		const other: PinnedModelSelection = { provider: "other", id: "a" };
		expect(withPinned([A], other, true)).toEqual([A, other]);
		expect(withPinned([A, other], other, false)).toEqual([A]);
	});
});

describe("pinnedEdit — order", () => {
	it("moves an entry to an index in the result", () => {
		expect(movePinnedEntry([A, B, C], 2, 0)).toEqual([C, A, B]);
		expect(movePinnedEntry([A, B, C], 0, 2)).toEqual([B, C, A]);
	});

	it("is a no-op for a move to its own slot or an out-of-range source", () => {
		const list = [A, B, C];
		expect(movePinnedEntry(list, 1, 1)).toBe(list);
		expect(movePinnedEntry(list, 9, 0)).toBe(list);
	});

	it("clamps a target past the end", () => {
		expect(movePinnedEntry([A, B, C], 0, 42)).toEqual([B, C, A]);
	});
});

describe("pinnedEdit — wire shape", () => {
	it("round-trips a level verbatim and omits an absent one", () => {
		const withLevel: PinnedModelInfo = { provider: "faux", id: "a", name: "A", thinkingLevel: "high" };
		const withoutLevel: PinnedModelInfo = { provider: "faux", id: "b", name: "B" };
		expect(pinnedSelectionOf(withLevel)).toEqual({ provider: "faux", id: "a", thinkingLevel: "high" });
		expect(pinnedSelectionOf(withoutLevel)).toEqual({ provider: "faux", id: "b" });
		expect(pinnedSelectionsOf([withLevel, withoutLevel])).toEqual([
			{ provider: "faux", id: "a", thinkingLevel: "high" },
			{ provider: "faux", id: "b" },
		]);
	});
});

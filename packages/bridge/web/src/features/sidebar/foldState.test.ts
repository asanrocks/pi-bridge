// ============================================================================
// foldState — the reveal ladder's four rules (floor, clamp, advance, retreat),
// the binary heading toggle, the fold-all target, and the migration of both
// earlier persisted records.
// ============================================================================

import { describe, expect, it } from "vitest";
import {
	advanceReveal,
	effectiveReveal,
	type FolderState,
	floorReveal,
	foldAllTarget,
	migrateFoldRecord,
	retreatReveal,
	toggleFolded,
} from "./foldState.ts";

describe("floorReveal", () => {
	it("starts at Inbox, at Later without Inbox rows, and at the history with neither", () => {
		expect(floorReveal(true, true)).toBe("inbox");
		expect(floorReveal(true, false)).toBe("inbox");
		expect(floorReveal(false, true)).toBe("later");
		expect(floorReveal(false, false)).toBe("all");
	});
});

describe("effectiveReveal", () => {
	it("raises a remembered step below the floor", () => {
		expect(effectiveReveal("inbox", false, true)).toBe("later");
		expect(effectiveReveal("later", false, false)).toBe("all");
	});

	it("leaves a reachable step alone", () => {
		expect(effectiveReveal("later", true, true)).toBe("later");
		expect(effectiveReveal("all", false, false)).toBe("all");
	});
});

describe("advanceReveal", () => {
	it("adds Later when there is Later work", () => {
		expect(advanceReveal("inbox", true)).toBe("later");
	});

	it("skips to the history when nothing would be added", () => {
		expect(advanceReveal("inbox", false)).toBe("all");
	});

	it("caps at the history, where the press becomes a server page", () => {
		expect(advanceReveal("later", true)).toBe("all");
		expect(advanceReveal("all", true)).toBe("all");
	});
});

describe("retreatReveal", () => {
	it("removes the history first, then Later", () => {
		expect(retreatReveal("all", true, true)).toBe("later");
		expect(retreatReveal("later", true, true)).toBe("inbox");
	});

	it("never goes below the floor", () => {
		expect(retreatReveal("later", false, true)).toBe("later");
		expect(retreatReveal("all", false, false)).toBe("all");
	});
});

describe("toggleFolded", () => {
	it("keeps the reveal across a fold", () => {
		const folded = toggleFolded({ folded: false, reveal: "later" });
		expect(folded).toEqual({ folded: true, reveal: "later" });
		expect(toggleFolded(folded)).toEqual({ folded: false, reveal: "later" });
	});
});

describe("foldAllTarget", () => {
	const states = (...folded: boolean[]): FolderState[] => folded.map((f) => ({ folded: f, reveal: "inbox" }));

	it("folds everything when any folder is unfolded", () => {
		expect(foldAllTarget(states(false, false))).toBe(true);
		expect(foldAllTarget(states(true, false))).toBe(true);
	});

	it("unfolds everything when all are folded", () => {
		expect(foldAllTarget(states(true, true))).toBe(false);
	});
});

describe("migrateFoldRecord", () => {
	it("reads the tri-state cycle and the pre-location names", () => {
		expect(
			migrateFoldRecord({ a: "folded", b: "active", c: "open", d: "working", e: "all", f: "collapsed" }),
		).toEqual({
			a: { folded: true, reveal: "inbox" },
			b: { folded: false, reveal: "inbox" },
			c: { folded: false, reveal: "all" },
			d: { folded: false, reveal: "inbox" },
			e: { folded: false, reveal: "all" },
			f: { folded: true, reveal: "inbox" },
		});
	});

	it("reads the v1 array form as expanded folders", () => {
		expect(migrateFoldRecord(["a", 7, "b"])).toEqual({
			a: { folded: false, reveal: "all" },
			b: { folded: false, reveal: "all" },
		});
	});

	it("round-trips the current shape", () => {
		const stored = { a: { folded: true, reveal: "later" } };
		expect(migrateFoldRecord(stored)).toEqual(stored);
	});

	it("drops unknown or malformed states rather than trusting them", () => {
		expect(
			migrateFoldRecord({
				a: "sideways",
				b: { folded: true, reveal: "later" },
				c: { folded: "yes", reveal: "later" },
				d: { folded: true, reveal: "top" },
				e: { reveal: "all" },
			}),
		).toEqual({ b: { folded: true, reveal: "later" } });
		expect(migrateFoldRecord(null)).toEqual({});
		expect(migrateFoldRecord("nonsense")).toEqual({});
	});
});

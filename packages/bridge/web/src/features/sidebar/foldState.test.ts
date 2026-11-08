// ============================================================================
// foldState — the sidebar's fold cycle, its no-working-rows rule, and the
// migration of the pre-ADR-23 persisted record.
// ============================================================================

import { describe, expect, it } from "vitest";
import { effectiveFold, foldAllTarget, migrateFoldRecord, nextFoldState } from "./foldState.ts";

describe("nextFoldState", () => {
	it("cycles collapsed → working → all → collapsed when the folder has working rows", () => {
		expect(nextFoldState("collapsed", true)).toBe("working");
		expect(nextFoldState("working", true)).toBe("all");
		expect(nextFoldState("all", true)).toBe("collapsed");
	});

	it("skips the working step when the folder has none", () => {
		expect(nextFoldState("collapsed", false)).toBe("all");
		expect(nextFoldState("all", false)).toBe("collapsed");
	});
});

describe("effectiveFold", () => {
	it("renders a working step with no working rows as collapsed", () => {
		expect(effectiveFold("working", false)).toBe("collapsed");
		expect(effectiveFold("working", true)).toBe("working");
		expect(effectiveFold("all", false)).toBe("all");
	});
});

describe("foldAllTarget", () => {
	const ids = ["a", "b"];

	it("moves every folder one step above the highest, wrapping at the top", () => {
		expect(foldAllTarget({ a: "collapsed", b: "collapsed" }, ids, { a: true })).toBe("working");
		expect(foldAllTarget({ a: "working", b: "collapsed" }, ids, { a: true })).toBe("all");
		expect(foldAllTarget({ a: "all", b: "working" }, ids, { a: true, b: true })).toBe("collapsed");
	});

	it("skips working for a set with no working rows", () => {
		expect(foldAllTarget({ a: "collapsed", b: "collapsed" }, ids, {})).toBe("all");
	});

	it("treats a stale working fold without working rows as collapsed", () => {
		// Effective state is collapsed on both, so the one click goes to `all`.
		expect(foldAllTarget({ a: "working", b: "collapsed" }, ids, {})).toBe("all");
	});
});

describe("migrateFoldRecord", () => {
	it("translates the pre-ADR-23 names", () => {
		expect(migrateFoldRecord({ a: "folded", b: "active", c: "open" })).toEqual({
			a: "collapsed",
			b: "working",
			c: "all",
		});
	});

	it("reads the v1 array form as expanded folders", () => {
		expect(migrateFoldRecord(["a", 7, "b"])).toEqual({ a: "all", b: "all" });
	});

	it("drops unknown states rather than trusting them", () => {
		expect(migrateFoldRecord({ a: "sideways", b: "all" })).toEqual({ b: "all" });
		expect(migrateFoldRecord(null)).toEqual({});
		expect(migrateFoldRecord("nonsense")).toEqual({});
	});
});

// ============================================================================
// foldState — the sidebar's fold cycle, its no-Inbox-rows rule, and the
// migration of both earlier persisted records.
// ============================================================================

import { describe, expect, it } from "vitest";
import { effectiveFold, foldAllTarget, migrateFoldRecord, nextFoldState } from "./foldState.ts";

describe("nextFoldState", () => {
	it("cycles collapsed → inbox → all → collapsed when the folder has Inbox rows", () => {
		expect(nextFoldState("collapsed", true)).toBe("inbox");
		expect(nextFoldState("inbox", true)).toBe("all");
		expect(nextFoldState("all", true)).toBe("collapsed");
	});

	it("skips the inbox step when the folder has none", () => {
		expect(nextFoldState("collapsed", false)).toBe("all");
		expect(nextFoldState("all", false)).toBe("collapsed");
	});
});

describe("effectiveFold", () => {
	it("renders an inbox step with no Inbox rows as collapsed", () => {
		expect(effectiveFold("inbox", false)).toBe("collapsed");
		expect(effectiveFold("inbox", true)).toBe("inbox");
		expect(effectiveFold("all", false)).toBe("all");
	});
});

describe("foldAllTarget", () => {
	const ids = ["a", "b"];

	it("moves every folder one step above the highest, wrapping at the top", () => {
		expect(foldAllTarget({ a: "collapsed", b: "collapsed" }, ids, { a: true })).toBe("inbox");
		expect(foldAllTarget({ a: "inbox", b: "collapsed" }, ids, { a: true })).toBe("all");
		expect(foldAllTarget({ a: "all", b: "inbox" }, ids, { a: true, b: true })).toBe("collapsed");
	});

	it("skips inbox for a set with no Inbox rows", () => {
		expect(foldAllTarget({ a: "collapsed", b: "collapsed" }, ids, {})).toBe("all");
	});

	it("treats a stale inbox fold without Inbox rows as collapsed", () => {
		// Effective state is collapsed on both, so the one click goes to `all`.
		expect(foldAllTarget({ a: "inbox", b: "collapsed" }, ids, {})).toBe("all");
	});
});

describe("migrateFoldRecord", () => {
	it("translates the earlier names, including the pre-location working step", () => {
		expect(migrateFoldRecord({ a: "folded", b: "active", c: "open", d: "working" })).toEqual({
			a: "collapsed",
			b: "inbox",
			c: "all",
			d: "inbox",
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

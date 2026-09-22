// browserSections — the review presentation's section keys and the tree-follow
// rule (ADR 14). Pure functions, hand-built inputs. Regression guard for the
// absolute-vs-relative key mismatch that made a changed-tree click neither open
// nor scroll to its section.

import { describe, expect, it } from "vitest";
import { sectionKey, visibleSectionKey } from "./browserSections.ts";

describe("sectionKey", () => {
	it("joins the browser root with a directive-relative path", () => {
		expect(sectionKey("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
	});

	it("collapses a non-normalized root and accepts both separators", () => {
		expect(sectionKey("/repo/", "src/a.ts")).toBe("/repo/src/a.ts");
		expect(sectionKey("/repo", "src\\deep\\a.ts")).toBe("/repo/src/deep/a.ts");
	});

	it("is idempotent for an already-absolute path", () => {
		expect(sectionKey("/repo", "/repo/src/a.ts")).toBe("/repo/src/a.ts");
	});

	it("matches the absolute path a changed-tree node carries", () => {
		// buildChangedTree(files) builds node.path the same way; a click and its
		// section must share this key.
		const root = "/repo";
		const nodePath = `${root}/src/a.ts`;
		expect(sectionKey(root, "src/a.ts")).toBe(nodePath);
	});
});

describe("visibleSectionKey", () => {
	const sections = [
		{ key: "a", top: -400 },
		{ key: "b", top: 40 },
		{ key: "c", top: 300 },
	];

	it("returns the last section whose top has reached the container top", () => {
		expect(visibleSectionKey(sections, 0)).toBe("a");
		expect(visibleSectionKey(sections, 100)).toBe("b");
	});

	it("returns the first section before any has reached the top", () => {
		expect(visibleSectionKey(sections, -500)).toBe("a");
	});

	it("follows the scroll position", () => {
		expect(visibleSectionKey(sections, 400)).toBe("c");
		expect(visibleSectionKey(sections, 1000)).toBe("c");
	});

	it("returns null for an empty list", () => {
		expect(visibleSectionKey([], 0)).toBeNull();
	});
});

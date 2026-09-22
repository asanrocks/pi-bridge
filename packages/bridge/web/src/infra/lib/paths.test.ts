// paths — the browser's absolute-addressing arithmetic (ADR 14). Pure
// functions, hand-built inputs.

import { describe, expect, it } from "vitest";
import { isAbsolutePath, isHomePath, isUnder, parentDirectory, resolveAgainst } from "./paths.ts";

describe("isAbsolutePath", () => {
	it("recognizes POSIX and Windows absolutes", () => {
		expect(isAbsolutePath("/repo/a.ts")).toBe(true);
		expect(isAbsolutePath("C:\\repo\\a.ts")).toBe(true);
		expect(isAbsolutePath("C:/repo/a.ts")).toBe(true);
		expect(isAbsolutePath("\\\\server\\share")).toBe(true);
	});

	it("rejects relative and home paths", () => {
		expect(isAbsolutePath("src/a.ts")).toBe(false);
		expect(isAbsolutePath("./a.ts")).toBe(false);
		expect(isAbsolutePath("~/a.ts")).toBe(false);
	});
});

describe("isHomePath", () => {
	it("matches ~ and ~-rooted paths only", () => {
		expect(isHomePath("~")).toBe(true);
		expect(isHomePath("~/a.ts")).toBe(true);
		expect(isHomePath("~\\a.ts")).toBe(true);
		expect(isHomePath("/a.ts")).toBe(false);
		expect(isHomePath("a~b.ts")).toBe(false);
	});
});

describe("parentDirectory", () => {
	it("walks up one segment and keeps the root", () => {
		expect(parentDirectory("/repo/src/a.ts")).toBe("/repo/src");
		expect(parentDirectory("/repo")).toBe("/");
		expect(parentDirectory("/repo/")).toBe("/");
		expect(parentDirectory("/")).toBe("/");
		expect(parentDirectory("C:\\repo\\a.ts")).toBe("C:\\repo");
		expect(parentDirectory("C:\\")).toBe("C:\\");
	});
});

describe("resolveAgainst", () => {
	it("joins a relative path against the base", () => {
		expect(resolveAgainst("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
		expect(resolveAgainst("/repo/", "src/a.ts")).toBe("/repo/src/a.ts");
		expect(resolveAgainst("/repo", "./src/a.ts")).toBe("/repo/src/a.ts");
		expect(resolveAgainst("/repo", "src/../a.ts")).toBe("/repo/a.ts");
	});

	it("clamps `..` at the root", () => {
		expect(resolveAgainst("/repo", "../x.ts")).toBe("/x.ts");
		expect(resolveAgainst("/repo/sub", "../../x.ts")).toBe("/x.ts");
	});

	it("returns an absolute path unchanged (normalized)", () => {
		expect(resolveAgainst("/repo", "/other/a.ts")).toBe("/other/a.ts");
		expect(resolveAgainst("/repo", "/other/../a.ts")).toBe("/a.ts");
	});

	it("keeps the Windows drive root", () => {
		expect(resolveAgainst("C:\\repo", "src\\a.ts")).toBe("C:\\repo\\src\\a.ts");
		expect(resolveAgainst("C:\\repo", "..\\a.ts")).toBe("C:\\a.ts");
	});
});

describe("isUnder", () => {
	it("compares whole segments", () => {
		expect(isUnder("/a/b", "/a/b/c.ts")).toBe(true);
		expect(isUnder("/a/b", "/a/b")).toBe(true);
		expect(isUnder("/a/b/", "/a/b/c.ts")).toBe(true);
		expect(isUnder("/a/b", "/a/bc.ts")).toBe(false);
		expect(isUnder("/a/b", "/a")).toBe(false);
	});
});

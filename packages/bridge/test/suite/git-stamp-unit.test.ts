import { describe, expect, it } from "vitest";
import {
	GIT_STAMP_CUSTOM_TYPE,
	isValidBranchName,
	isValidCommitId,
	parseGitIdentity,
	parseGitStampData,
	parseGitStampEntry,
	sameGitIdentity,
} from "../../src/core/git-stamp.ts";

const SHA1 = "0123456789abcdef0123456789abcdef01234567";
const SHA1_B = "fedcba9876543210fedcba9876543210fedcba98";
const SHA256 = "a".repeat(64);

function stamp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { v: 1, anchor: "prompt", commit: SHA1, branch: "main", ...overrides };
}

describe("isValidCommitId", () => {
	it("accepts 40-char and 64-char lowercase hex", () => {
		expect(isValidCommitId(SHA1)).toBe(true);
		expect(isValidCommitId(SHA256)).toBe(true);
	});

	it("rejects uppercase, wrong length, and non-hex", () => {
		expect(isValidCommitId(SHA1.toUpperCase())).toBe(false);
		expect(isValidCommitId(SHA1.slice(1))).toBe(false);
		expect(isValidCommitId(`g${SHA1.slice(1)}`)).toBe(false);
		expect(isValidCommitId("")).toBe(false);
		expect(isValidCommitId(`${SHA1}\n`)).toBe(false);
	});
});

describe("isValidBranchName", () => {
	it("accepts ordinary names", () => {
		expect(isValidBranchName("main")).toBe(true);
		expect(isValidBranchName("feature/x-2_fix")).toBe(true);
		expect(isValidBranchName("a/b/c/d")).toBe(true);
	});

	it("rejects empty, embedded newlines, and control characters", () => {
		expect(isValidBranchName("")).toBe(false);
		expect(isValidBranchName("main\nmain")).toBe(false);
		expect(isValidBranchName("main\tmain")).toBe(false);
		expect(isValidBranchName("main\u0007")).toBe(false);
		expect(isValidBranchName("main\u007f")).toBe(false);
	});
});

describe("parseGitIdentity", () => {
	it("parses full identity", () => {
		expect(parseGitIdentity(SHA1, "main")).toEqual({ commit: SHA1, branch: "main" });
	});

	it("allows null commit (unborn HEAD) and null branch (detached)", () => {
		expect(parseGitIdentity(null, "main")).toEqual({ commit: null, branch: "main" });
		expect(parseGitIdentity(SHA1, null)).toEqual({ commit: SHA1, branch: null });
		expect(parseGitIdentity(null, null)).toEqual({ commit: null, branch: null });
	});

	it("rejects invalid raw output", () => {
		expect(parseGitIdentity("not-a-hash", "main")).toBeNull();
		expect(parseGitIdentity(SHA1, "a\nb")).toBeNull();
		expect(parseGitIdentity(SHA1, "")).toBeNull();
	});
});

describe("parseGitStampData", () => {
	it("accepts a well-formed v1 stamp", () => {
		expect(parseGitStampData(stamp())).toEqual({
			v: 1,
			anchor: "prompt",
			commit: SHA1,
			branch: "main",
		});
		expect(parseGitStampData(stamp({ anchor: "turn_end" }))).toMatchObject({ anchor: "turn_end" });
	});

	it("accepts null commit and null branch combinations", () => {
		expect(parseGitStampData(stamp({ commit: null }))).toMatchObject({ commit: null });
		expect(parseGitStampData(stamp({ branch: null }))).toMatchObject({ branch: null });
		expect(parseGitStampData(stamp({ commit: null, branch: null }))).toMatchObject({
			commit: null,
			branch: null,
		});
	});

	it("rejects non-objects and arrays", () => {
		expect(parseGitStampData(null)).toBeNull();
		expect(parseGitStampData(undefined)).toBeNull();
		expect(parseGitStampData("nope")).toBeNull();
		expect(parseGitStampData(42)).toBeNull();
		expect(parseGitStampData([stamp()])).toBeNull();
	});

	it("rejects unknown versions and anchors", () => {
		expect(parseGitStampData(stamp({ v: 2 }))).toBeNull();
		expect(parseGitStampData(stamp({ v: "1" }))).toBeNull();
		expect(parseGitStampData(stamp({ anchor: "session_start" }))).toBeNull();
		expect(parseGitStampData({ ...stamp(), extra: "field" })).toEqual({
			v: 1,
			anchor: "prompt",
			commit: SHA1,
			branch: "main",
		});
	});

	it("rejects mistyped and invalid commit/branch values", () => {
		expect(parseGitStampData(stamp({ commit: 123 }))).toBeNull();
		expect(parseGitStampData(stamp({ branch: true }))).toBeNull();
		expect(parseGitStampData(stamp({ commit: "abc" }))).toBeNull();
		expect(parseGitStampData(stamp({ branch: "a\nb" }))).toBeNull();
	});
});

describe("parseGitStampEntry", () => {
	it("extracts a stamp from a pi custom entry (type discriminator)", () => {
		expect(parseGitStampEntry({ type: "custom", customType: GIT_STAMP_CUSTOM_TYPE, data: stamp() })).toMatchObject({
			v: 1,
			commit: SHA1,
			branch: "main",
		});
	});

	it("extracts a stamp from a bridge custom entry (kind discriminator)", () => {
		expect(parseGitStampEntry({ kind: "custom", customType: GIT_STAMP_CUSTOM_TYPE, data: stamp() })).toMatchObject({
			v: 1,
		});
	});

	it("returns null for other kinds, custom types, and malformed data", () => {
		expect(parseGitStampEntry({ type: "message" })).toBeNull();
		expect(parseGitStampEntry({ kind: "message" })).toBeNull();
		expect(parseGitStampEntry({ type: "custom", customType: "other.ext", data: stamp() })).toBeNull();
		expect(parseGitStampEntry({ type: "custom", customType: GIT_STAMP_CUSTOM_TYPE, data: 3 })).toBeNull();
		expect(parseGitStampEntry({ type: "custom", customType: GIT_STAMP_CUSTOM_TYPE })).toBeNull();
	});
});

describe("sameGitIdentity", () => {
	it("compares the identity key", () => {
		expect(sameGitIdentity({ commit: SHA1, branch: "main" }, { commit: SHA1, branch: "main" })).toBe(true);
		expect(sameGitIdentity({ commit: SHA1, branch: "main" }, { commit: SHA1_B, branch: "main" })).toBe(false);
		expect(sameGitIdentity({ commit: SHA1, branch: "main" }, { commit: SHA1, branch: "dev" })).toBe(false);
		expect(sameGitIdentity({ commit: null, branch: null }, { commit: null, branch: null })).toBe(true);
	});
});

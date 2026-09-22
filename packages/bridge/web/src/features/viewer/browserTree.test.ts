// browserTree — the browser's two normalized tree shapes (ADR 14). Pure
// functions, hand-built inputs.

import { describe, expect, it } from "vitest";
import type { DirectoryEntry, GitDiffFileStat } from "../../../../src/core/index.ts";
import { buildChangedTree, buildDirectoryTree } from "./browserTree.ts";

function file(path: string, status: GitDiffFileStat["status"] = "modified"): GitDiffFileStat {
	return { path, status, additions: 1, deletions: 0, binary: false };
}

describe("buildChangedTree", () => {
	it("nests changed paths and synthesizes intermediate directories", () => {
		const nodes = buildChangedTree("/repo", [
			file("src/a.ts"),
			file("src/deep/b.ts", "added"),
			file("README.md", "deleted"),
		]);
		// Directories first, then name.
		expect(nodes.map((n) => n.name)).toEqual(["src", "README.md"]);
		const src = nodes[0]!;
		expect(src.isDirectory).toBe(true);
		expect(src.children?.map((n) => n.name)).toEqual(["deep", "a.ts"]);
		expect(nodes[1]!.status).toBe("deleted");
		const deep = src.children![0]!;
		expect(deep.isDirectory).toBe(true);
		expect(deep.children).toEqual([
			{ name: "b.ts", path: "/repo/src/deep/b.ts", isDirectory: false, status: "added" },
		]);
	});

	it("omits children for a collapsed directory", () => {
		const nodes = buildChangedTree("/repo", [file("src/deep/b.ts")], new Set(["/repo/src"]));
		expect(nodes[0]!.children).toBeUndefined();
	});

	it("keeps the file's status only on the file node", () => {
		const nodes = buildChangedTree("/repo", [file("src/a.ts", "renamed")]);
		expect(nodes[0]!.status).toBeUndefined();
		expect(nodes[0]!.children![0]!.status).toBe("renamed");
	});

	it("carries a rename's source path on the file node", () => {
		const nodes = buildChangedTree("/repo", [
			{
				path: "src/renamed.ts",
				oldPath: "big.ts",
				status: "renamed",
				additions: 0,
				deletions: 0,
				binary: false,
			},
		]);
		const renamed = nodes[0]!.children![0]!;
		expect(renamed).toMatchObject({ path: "/repo/src/renamed.ts", oldPath: "/repo/big.ts" });
		// The synthesized directory carries no rename source of its own.
		expect(nodes[0]!.oldPath).toBeUndefined();
	});
});

describe("buildDirectoryTree", () => {
	const entries: DirectoryEntry[] = [
		{ name: "src", path: "/repo/src", isDirectory: true },
		{ name: "a.ts", path: "/repo/a.ts", isDirectory: false },
	];

	it("sorts directories first and only expands fetched directories", () => {
		const collapsed = buildDirectoryTree("/repo", new Map([["/repo", entries]]), new Set(), new Map());
		expect(collapsed.map((n) => n.name)).toEqual(["src", "a.ts"]);
		expect(collapsed[0]!.children).toBeUndefined();

		const expanded = buildDirectoryTree(
			"/repo",
			new Map([
				["/repo", entries],
				["/repo/src", [{ name: "b.ts", path: "/repo/src/b.ts", isDirectory: false }]],
			]),
			new Set(["/repo/src"]),
			new Map(),
		);
		expect(expanded[0]!.children?.map((n) => n.name)).toEqual(["b.ts"]);
	});

	it("overlays change status on listed paths", () => {
		const nodes = buildDirectoryTree(
			"/repo",
			new Map([["/repo", entries]]),
			new Set(),
			new Map([["/repo/a.ts", "added"]]),
		);
		expect(nodes.find((n) => n.name === "a.ts")?.status).toBe("added");
		expect(nodes.find((n) => n.name === "src")?.status).toBeUndefined();
	});

	it("marks a directory whose listing failed, without children, even when expanded", () => {
		const nodes = buildDirectoryTree(
			"/repo",
			new Map([["/repo", entries]]),
			new Set(["/repo/src"]),
			new Map(),
			new Set(["/repo/src"]),
		);
		const src = nodes.find((n) => n.name === "src")!;
		expect(src.error).toBe(true);
		// No children: a failed listing must not read as an empty directory, and the
		// node stays collapsed so the next toggle retries the listing.
		expect(src.children).toBeUndefined();
	});
});

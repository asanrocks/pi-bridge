// ============================================================================
// projects — the storage half of the agent tree.
//
// A spawned Session is stored at `<spawner stem>/<task name>`, so the spawner's
// relation to its child is a directory and trashing a parent is a subtree
// operation. The selection and the address claim are pure filesystem functions
// here, so their order, boundary, and exclusivity are testable without a Worker.
// ============================================================================

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reserveSessionFile, subtreeStemsUnder } from "../../src/host/projects.ts";

describe("subtreeStemsUnder", () => {
	it("returns the stem and everything beneath it, deepest first", () => {
		const stems = ["root", "root/a", "root/a/b", "rootish", "other"];
		expect(subtreeStemsUnder(stems, "root")).toEqual(["root/a/b", "root/a", "root"]);
	});

	it("matches on a segment boundary, so a sibling prefix is not a child", () => {
		expect(subtreeStemsUnder(["root", "rootish", "root-2"], "root")).toEqual(["root"]);
	});

	it("deduplicates a stem the live registry and the file scan both name", () => {
		expect(subtreeStemsUnder(["root", "root", "root/a"], "root")).toEqual(["root/a", "root"]);
	});
});

describe("reserveSessionFile", () => {
	const withDir = (run: (dir: string) => void): void => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bridge-reserve-"));
		try {
			run(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	it("creates the spawner's directory and holds the name with an empty file", () => {
		withDir((dir) => {
			const path = reserveSessionFile(dir, "root/worker");
			expect(path).toBe(join(dir, "root", "worker.jsonl"));
			expect(readFileSync(path, "utf8")).toBe("");
		});
	});

	it("refuses a name already on disk, so one address stays one Session", () => {
		withDir((dir) => {
			writeFileSync(join(dir, "taken.jsonl"), "");
			expect(() => reserveSessionFile(dir, "taken")).toThrow(/EEXIST/);
		});
	});
});

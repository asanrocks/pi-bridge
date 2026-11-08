// ============================================================================
// sessionRows — a Project folder's state order (notified → busy → parked →
// inactive), the queue/history split, and the collapsed folder's hidden count.
// ============================================================================

import { describe, expect, it } from "vitest";
import type { SessionInfo, SessionState } from "../../../../src/core/index.ts";
import { hiddenRowCount, splitProjectRows } from "./sessionRows.ts";

function row(stem: string, state: SessionState): SessionInfo {
	return { projectId: "p", sessionId: `id-${stem}`, stem, state, timestamp: "2026-01-01T00:00:00.000Z" };
}

describe("splitProjectRows", () => {
	it("keeps the queue's order and puts inactive rows last", () => {
		const queue = [row("n1", "notified"), row("b1", "busy"), row("d1", "deferred")];
		const page = [row("old1", "inactive"), row("old2", "inactive")];
		const rows = splitProjectRows(queue, page);
		expect(rows.working.map((r) => r.stem)).toEqual(["n1", "b1"]);
		expect(rows.parked.map((r) => r.stem)).toEqual(["d1"]);
		expect(rows.inactive.map((r) => r.stem)).toEqual(["old1", "old2"]);
	});

	it("filters history rows the queue already holds (by durable id)", () => {
		// The file scan and the queue name the same session; it renders once.
		const queue = [row("same", "notified")];
		const same = { ...row("same", "inactive"), sessionId: "id-same" };
		expect(splitProjectRows(queue, [same]).inactive).toEqual([]);
	});

	it("drops queue rows whose state is inactive (the store prunes them)", () => {
		expect(splitProjectRows([row("x", "inactive")], []).working).toEqual([]);
	});
});

describe("hiddenRowCount", () => {
	const rows = {
		working: [row("n1", "notified"), row("b1", "busy")],
		parked: [row("d1", "deferred")],
		inactive: [row("old", "inactive")],
	};

	it("counts everything a collapsed folder hides", () => {
		expect(hiddenRowCount("collapsed", rows)).toBe(4);
	});

	it("counts only parked and inactive rows in the working step", () => {
		expect(hiddenRowCount("working", rows)).toBe(2);
	});

	it("states nothing when the folder is fully open", () => {
		expect(hiddenRowCount("all", rows)).toBe(0);
	});
});

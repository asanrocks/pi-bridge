// ============================================================================
// sessionRows — a Project folder's queue order (Inbox → Later) and the
// queue/history split.
// ============================================================================

import { describe, expect, it } from "vitest";
import type { SessionInfo, SessionLocation } from "../../../../src/core/index.ts";
import { splitProjectRows } from "./sessionRows.ts";

function row(stem: string, location: SessionLocation, running = false): SessionInfo {
	return {
		projectId: "p",
		sessionId: `id-${stem}`,
		stem,
		location,
		timestamp: "2026-01-01T00:00:00.000Z",
		...(running ? { activity: { kind: "responding" as const } } : {}),
	};
}

describe("splitProjectRows", () => {
	it("keeps the queue's order and puts archived rows last", () => {
		const queue = [row("n1", "inbox", true), row("n2", "inbox"), row("d1", "later")];
		const page = [row("old1", "archive"), row("old2", "archive")];
		const rows = splitProjectRows(queue, page);
		expect(rows.inbox.map((r) => r.stem)).toEqual(["n1", "n2"]);
		expect(rows.later.map((r) => r.stem)).toEqual(["d1"]);
		expect(rows.archived.map((r) => r.stem)).toEqual(["old1", "old2"]);
	});

	it("filters history rows the queue already holds (by durable id)", () => {
		// The file scan and the queue name the same session; it renders once.
		const queue = [row("same", "inbox")];
		const same = { ...row("same", "archive"), sessionId: "id-same" };
		expect(splitProjectRows(queue, [same]).archived).toEqual([]);
	});

	it("a running row stays in the group its location names", () => {
		const rows = splitProjectRows([row("parked", "later", true)], []);
		expect(rows.later.map((r) => r.stem)).toEqual(["parked"]);
		expect(rows.inbox).toEqual([]);
	});
});

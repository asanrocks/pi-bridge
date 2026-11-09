// ============================================================================
// Queue order: the shared comparator's total order — Inbox before Later, the
// most recent placement first, the address as the tie-break. The point of the
// key is what it ignores: activity is a temporal fact, so a row that ran must
// not move.
// ============================================================================

import { describe, expect, it } from "vitest";
import { compareQueueRows } from "../../src/core/queue-order.ts";
import type { SessionInfo } from "../../src/core/types.ts";

function row(stem: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		projectId: "proj",
		sessionId: `sess-${stem}`,
		stem,
		location: "inbox",
		timestamp: "2024-01-01T00:00:00.000Z",
		...overrides,
	};
}

const stems = (rows: SessionInfo[]): string[] => [...rows].sort(compareQueueRows).map((r) => r.stem);

describe("compareQueueRows", () => {
	it("orders Inbox before Later regardless of placement", () => {
		const rows = [
			row("parked", { location: "later", placedAt: "2024-06-01T00:00:00.000Z" }),
			row("waiting", { location: "inbox", placedAt: "2024-01-01T00:00:00.000Z" }),
		];
		expect(stems(rows)).toEqual(["waiting", "parked"]);
	});

	it("orders each group by placement stamp, newest first", () => {
		const rows = [
			row("older", { placedAt: "2024-01-01T00:00:00.000Z" }),
			row("newer", { placedAt: "2024-02-01T00:00:00.000Z" }),
		];
		expect(stems(rows)).toEqual(["newer", "older"]);
	});

	it("activity cannot reorder a placed row", () => {
		// `older` streamed a turn after `newer` was placed: busy is temporal, not a
		// decision, so the queue keeps the order the user's placements created.
		const rows = [
			row("older", { placedAt: "2024-01-01T00:00:00.000Z", lastActivityAt: "2024-09-01T00:00:00.000Z" }),
			row("newer", { placedAt: "2024-02-01T00:00:00.000Z", lastActivityAt: "2024-02-01T00:00:00.000Z" }),
		];
		expect(stems(rows)).toEqual(["newer", "older"]);
	});

	it("a record written before stamps sorts after every stamped placement", () => {
		const rows = [
			row("migrated", { placedAt: "" }),
			row("stamped", { placedAt: "2024-01-01T00:00:00.000Z" }),
			row("absent"),
		];
		expect(stems(rows)).toEqual(["stamped", "absent", "migrated"]);
	});

	it("equal stamps fall back to the address, so the order is total and stable", () => {
		const rows = [
			row("b", { placedAt: "2024-01-01T00:00:00.000Z" }),
			row("a", { placedAt: "2024-01-01T00:00:00.000Z" }),
			row("a", { projectId: "aaa", placedAt: "2024-01-01T00:00:00.000Z" }),
		];
		expect(stems(rows)).toEqual(["a", "a", "b"]);
		// A different input order yields the same order: the comparator is total.
		expect(stems([...rows].reverse())).toEqual(["a", "a", "b"]);
		expect(compareQueueRows(rows[0], rows[1])).toBeGreaterThan(0);
	});
});

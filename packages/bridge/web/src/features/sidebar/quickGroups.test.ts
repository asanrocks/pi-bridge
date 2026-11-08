// ============================================================================
// quickGroups — the compact switcher's membership and grouping: Inbox rows
// only, in queue order, Project groups in order of first appearance.
// ============================================================================

import { describe, expect, it } from "vitest";
import type { SessionInfo, SessionLocation } from "../../../../src/core/index.ts";
import { quickSwitcherGroups } from "./quickGroups.ts";

function row(projectId: string, stem: string, location: SessionLocation): SessionInfo {
	return { projectId, sessionId: `${projectId}-${stem}`, stem, location, timestamp: "2026-01-01T00:00:00.000Z" };
}

describe("quickSwitcherGroups", () => {
	it("keeps only Inbox rows", () => {
		const groups = quickSwitcherGroups([
			row("p", "n", "inbox"),
			row("p", "d", "later"),
			row("p", "b", "inbox"),
			row("p", "i", "archive"),
		]);
		expect(groups).toEqual([["p", [expect.objectContaining({ stem: "n" }), expect.objectContaining({ stem: "b" })]]]);
	});

	it("preserves the queue's order inside and between Projects", () => {
		const groups = quickSwitcherGroups([row("a", "a1", "inbox"), row("b", "b1", "inbox"), row("a", "a2", "inbox")]);
		expect(groups.map(([id]) => id)).toEqual(["a", "b"]);
		expect(groups[0][1].map((r) => r.stem)).toEqual(["a1", "a2"]);
	});

	it("is empty when nothing is in the Inbox", () => {
		expect(quickSwitcherGroups([row("p", "d", "later")])).toEqual([]);
		expect(quickSwitcherGroups([])).toEqual([]);
	});
});

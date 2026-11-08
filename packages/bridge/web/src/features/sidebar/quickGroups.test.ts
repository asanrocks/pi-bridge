// ============================================================================
// quickGroups — the compact switcher's membership and grouping: working rows
// only, in queue order, Project groups in order of first appearance.
// ============================================================================

import { describe, expect, it } from "vitest";
import type { SessionInfo, SessionState } from "../../../../src/core/index.ts";
import { quickSwitcherGroups } from "./quickGroups.ts";

function row(projectId: string, stem: string, state: SessionState): SessionInfo {
	return { projectId, sessionId: `${projectId}-${stem}`, stem, state, timestamp: "2026-01-01T00:00:00.000Z" };
}

describe("quickSwitcherGroups", () => {
	it("keeps only notified and busy rows", () => {
		const groups = quickSwitcherGroups([
			row("p", "n", "notified"),
			row("p", "d", "deferred"),
			row("p", "b", "busy"),
			row("p", "i", "inactive"),
		]);
		expect(groups).toEqual([["p", [expect.objectContaining({ stem: "n" }), expect.objectContaining({ stem: "b" })]]]);
	});

	it("preserves the queue's order inside and between Projects", () => {
		const groups = quickSwitcherGroups([row("a", "a1", "notified"), row("b", "b1", "busy"), row("a", "a2", "busy")]);
		expect(groups.map(([id]) => id)).toEqual(["a", "b"]);
		expect(groups[0][1].map((r) => r.stem)).toEqual(["a1", "a2"]);
	});

	it("is empty when nothing is working", () => {
		expect(quickSwitcherGroups([row("p", "d", "deferred")])).toEqual([]);
		expect(quickSwitcherGroups([])).toEqual([]);
	});
});

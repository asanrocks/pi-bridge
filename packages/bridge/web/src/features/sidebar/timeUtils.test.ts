// Unit tests for the sidebar's active-state overlay (ADR 11). Project session
// rows are produced by a directory scan, which cannot observe runtime state;
// the global active snapshot is the authority for `active`/`isStreaming`.

import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../../../src/core/index.ts";
import { mergeActiveState } from "./timeUtils.ts";

function row(stem: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		projectId: "proj",
		sessionId: `sess-${stem}`,
		stem,
		active: false,
		isStreaming: false,
		timestamp: new Date(0).toISOString(),
		...overrides,
	};
}

describe("mergeActiveState", () => {
	it("marks a scanned row active+streaming from the snapshot", () => {
		const merged = mergeActiveState([row("a")], [row("a", { active: true, isStreaming: true })]);
		expect(merged[0].active).toBe(true);
		expect(merged[0].isStreaming).toBe(true);
	});

	it("clears stale active/streaming on rows absent from the snapshot", () => {
		const merged = mergeActiveState([row("a", { active: true, isStreaming: true })], []);
		expect(merged[0].active).toBe(false);
		expect(merged[0].isStreaming).toBe(false);
	});

	it("keeps a streaming turn visible while active but collects the flag", () => {
		const merged = mergeActiveState(
			[row("a", { active: true, isStreaming: true }), row("b")],
			[row("a", { active: true, isStreaming: false })],
		);
		expect(merged.map((r) => [r.stem, r.active, r.isStreaming])).toEqual([
			["a", true, false],
			["b", false, false],
		]);
	});

	it("preserves row identity when nothing changes (no re-render churn)", () => {
		const sessions = [row("a"), row("b")];
		const merged = mergeActiveState(sessions, [row("a", { active: true, isStreaming: true })]);
		expect(merged[1]).toBe(sessions[1]);
	});
});

// ============================================================================
// queueAttention — completion detection over queue snapshots: only
// running → not running, never the first snapshot, never the Session being
// read, never a location move.
// ============================================================================

import { describe, expect, it } from "vitest";
import type { SessionInfo, SessionLocation } from "../../../../src/core/index.ts";
import { QueueAttention, sessionKey } from "./queueAttention.ts";

function row(projectId: string, stem: string, running: boolean, location: SessionLocation = "inbox"): SessionInfo {
	return {
		projectId,
		sessionId: `${projectId}-${stem}`,
		stem,
		location,
		timestamp: "2026-01-01T00:00:00.000Z",
		...(running ? { activity: { kind: "responding" as const } } : {}),
	};
}

describe("QueueAttention", () => {
	it("reports a running row that finished", () => {
		const tracker = new QueueAttention();
		tracker.seed([row("p", "a", true)]);
		const completed = tracker.observe([row("p", "a", false)], true);
		expect(completed.map((r) => r.stem)).toEqual(["a"]);
	});

	it("never reports the first snapshot, even when it is already idle", () => {
		const tracker = new QueueAttention();
		expect(tracker.observe([row("p", "a", false)], true)).toEqual([]);
	});

	it("seeds a snapshot that arrives before the connection is confirmed", () => {
		// The connect path publishes `listQueue` while the store still says
		// `reconnecting`, so a Session that finished while the tab was away shows
		// up as running → idle in that snapshot. It is a baseline, not news.
		const tracker = new QueueAttention();
		tracker.seed([row("p", "a", true)]);
		expect(tracker.observe([row("p", "a", false)], false)).toEqual([]);
		// The baseline is recorded: the confirmed snapshot that follows does not
		// re-announce it either.
		expect(tracker.observe([row("p", "a", false)], true)).toEqual([]);
	});

	it("does not report a promotion, a move, or a repeated snapshot", () => {
		const tracker = new QueueAttention();
		tracker.observe([], true);
		// A message promotes the row into the queue: it is new, not finished.
		expect(tracker.observe([row("p", "a", true)], true)).toEqual([]);
		// A move to Later keeps the row and its running fact: no edge either way.
		expect(tracker.observe([row("p", "a", true, "later")], true)).toEqual([]);
		expect(tracker.observe([row("p", "a", false, "later")], true)).toHaveLength(1);
	});

	it("stays silent for the Session the tab is reading", () => {
		const tracker = new QueueAttention();
		tracker.seed([row("p", "a", true), row("p", "b", true)]);
		tracker.setAttached(sessionKey(row("p", "a", true)));
		const completed = tracker.observe([row("p", "a", false), row("p", "b", false)], true);
		expect(completed.map((r) => r.stem)).toEqual(["b"]);
	});

	it("reports every completion when several sessions finish together", () => {
		const tracker = new QueueAttention();
		tracker.seed([row("p", "a", true), row("q", "b", true)]);
		const completed = tracker.observe([row("p", "a", false), row("q", "b", false)], true);
		expect(completed.map((r) => sessionKey(r))).toEqual(["p/a", "q/b"]);
	});

	it("ignores a row that left the queue and does not re-report on return", () => {
		const tracker = new QueueAttention();
		tracker.seed([row("p", "a", true)]);
		expect(tracker.observe([], true)).toEqual([]);
		// It comes back idle (e.g. archived and moved to Inbox again): the
		// recorded fact is gone, so this is a new row, not a completion.
		expect(tracker.observe([row("p", "a", false)], true)).toEqual([]);
	});
});

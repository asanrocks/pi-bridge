// ============================================================================
// queueAttention — completion detection over queue snapshots: only
// busy → notified, never the first snapshot, never the Session being read.
// ============================================================================

import { describe, expect, it } from "vitest";
import type { SessionInfo, SessionState } from "../../../../src/core/index.ts";
import { QueueAttention, sessionKey } from "./queueAttention.ts";

function row(projectId: string, stem: string, state: SessionState): SessionInfo {
	return { projectId, sessionId: `${projectId}-${stem}`, stem, state, timestamp: "2026-01-01T00:00:00.000Z" };
}

describe("QueueAttention", () => {
	it("reports a busy row that became notified", () => {
		const tracker = new QueueAttention();
		tracker.seed([row("p", "a", "busy")]);
		const completed = tracker.observe([row("p", "a", "notified")], true);
		expect(completed.map((r) => r.stem)).toEqual(["a"]);
	});

	it("never reports the first snapshot, even when it is already notified", () => {
		const tracker = new QueueAttention();
		expect(tracker.observe([row("p", "a", "notified")], true)).toEqual([]);
	});

	it("seeds a snapshot that arrives before the connection is confirmed", () => {
		// The connect path publishes `listQueue` while the store still says
		// `reconnecting`, so a Session that finished while the tab was away shows
		// up as busy → notified in that snapshot. It is a baseline, not news.
		const tracker = new QueueAttention();
		tracker.seed([row("p", "a", "busy")]);
		expect(tracker.observe([row("p", "a", "notified")], false)).toEqual([]);
		// The baseline is recorded: the confirmed snapshot that follows does not
		// re-announce it either.
		expect(tracker.observe([row("p", "a", "notified")], true)).toEqual([]);
	});

	it("does not report a promotion, a restore, or a repeated notification", () => {
		const tracker = new QueueAttention();
		tracker.seed([row("p", "a", "inactive"), row("p", "b", "deferred")]);
		// Inactive rows are not in the queue, so promotion arrives as a new row.
		expect(tracker.observe([row("p", "a", "notified"), row("p", "b", "notified")], true)).toEqual([]);
		expect(tracker.observe([row("p", "a", "notified"), row("p", "b", "notified")], true)).toEqual([]);
	});

	it("stays silent for the Session the tab is reading", () => {
		const tracker = new QueueAttention();
		tracker.seed([row("p", "a", "busy"), row("p", "b", "busy")]);
		tracker.setAttached(sessionKey(row("p", "a", "busy")));
		const completed = tracker.observe([row("p", "a", "notified"), row("p", "b", "notified")], true);
		expect(completed.map((r) => r.stem)).toEqual(["b"]);
	});

	it("reports every completion when several sessions finish together", () => {
		const tracker = new QueueAttention();
		tracker.seed([row("p", "a", "busy"), row("q", "b", "busy")]);
		const completed = tracker.observe([row("p", "a", "notified"), row("q", "b", "notified")], true);
		expect(completed.map((r) => sessionKey(r))).toEqual(["p/a", "q/b"]);
	});

	it("ignores a row that left the queue and does not re-report on return", () => {
		const tracker = new QueueAttention();
		tracker.seed([row("p", "a", "busy")]);
		expect(tracker.observe([], true)).toEqual([]);
		// It comes back notified (e.g. re-admitted and settled off-screen): the
		// recorded state is gone, so this is a new row, not a completion.
		expect(tracker.observe([row("p", "a", "notified")], true)).toEqual([]);
	});
});

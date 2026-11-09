// ============================================================================
// waitingBadge — the attached-Session subtraction is the whole subtlety, so
// each case pins one of its edges: waiting, running, parked, and absent.
// ============================================================================

import { describe, expect, it } from "vitest";
import type { SessionInfo, SessionLocation } from "../../../../src/core/index.ts";
import { addressKeyOf } from "../../infra/state/protocol.ts";
import { waitingBadgeCount, waitingNewCount } from "./waitingBadge.ts";

function row(stem: string, location: SessionLocation, running = false, projectId = "p"): SessionInfo {
	return {
		projectId,
		sessionId: `${projectId}-${stem}`,
		stem,
		location,
		timestamp: "2026-01-01T00:00:00.000Z",
		...(running ? { activity: { kind: "responding" as const } } : {}),
	};
}

describe("waitingBadgeCount", () => {
	it("counts waiting Inbox rows and skips running, parked, and archived ones", () => {
		const queue = [row("a", "inbox"), row("b", "inbox", true), row("c", "later"), row("d", "archive")];
		expect(waitingBadgeCount(queue, null)).toBe(1);
	});

	it("subtracts the attached Session when it is the one waiting", () => {
		const queue = [row("a", "inbox"), row("b", "inbox"), row("c", "inbox", true)];
		expect(waitingBadgeCount(queue, { projectId: "p", stem: "a" })).toBe(1);
	});

	it("does not subtract an attached Session that is running or parked", () => {
		const queue = [row("a", "inbox"), row("b", "inbox", true), row("c", "later")];
		expect(waitingBadgeCount(queue, { projectId: "p", stem: "b" })).toBe(1);
		expect(waitingBadgeCount(queue, { projectId: "p", stem: "c" })).toBe(1);
	});

	it("matches the address, not the stem alone", () => {
		const queue = [row("a", "inbox"), row("a", "inbox", false, "other")];
		expect(waitingBadgeCount(queue, { projectId: "p", stem: "a" })).toBe(1);
	});

	it("is zero when the only waiting Session is the one being read", () => {
		expect(waitingBadgeCount([row("a", "inbox")], { projectId: "p", stem: "a" })).toBe(0);
	});
});

describe("waitingNewCount", () => {
	const unreadOf = (...rows: SessionInfo[]): string[] => rows.map((r) => addressKeyOf(r));

	it("counts only waiting rows this page has not read", () => {
		const queue = [row("a", "inbox"), row("b", "inbox"), row("c", "inbox", true)];
		// b's completion was read elsewhere (not in the set); c is running, so it
		// is not part of the waiting count at all.
		expect(waitingNewCount(queue, unreadOf(queue[0], queue[2]), null)).toBe(1);
	});

	it("ignores an unread address whose row left the waiting set", () => {
		const queue = [row("a", "inbox"), row("b", "inbox", true), row("c", "later")];
		// b started a new turn and c was parked: their unread entries survive in
		// the list, but the derived ring stops claiming them.
		expect(waitingNewCount(queue, unreadOf(queue[0], queue[1], queue[2]), null)).toBe(1);
	});

	it("subtracts the attached Session exactly like the count does", () => {
		const queue = [row("a", "inbox"), row("b", "inbox")];
		expect(waitingNewCount(queue, unreadOf(...queue), { projectId: "p", stem: "a" })).toBe(1);
	});

	it("is zero with nothing unread", () => {
		expect(waitingNewCount([row("a", "inbox")], [], null)).toBe(0);
	});
});

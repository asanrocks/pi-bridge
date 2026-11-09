// ============================================================================
// waitingBadge — the TopBar menu button's count: how many Sessions other than
// the one being read are waiting for a reply. Inbox is the user's attention
// list, and a row with no `activity` has nothing executing, so its turn is
// over and the ball is theirs; a running Inbox row is counted by its own
// "running" mark in the sidebar, not here.
//
// The attached Session is subtracted only when it is itself waiting: it is
// already in front of the user, so the badge answers "how many more need me",
// never "how many exist".
//
// `waitingNewCount` is the badge's second channel: of those rows, how many
// finished since this page last read them. The count is state, the novelty is
// an occurrence this page witnessed, so they are derived separately and one can
// change without the other.
// ============================================================================

import type { SessionAddress, SessionInfo } from "../../../../src/core/index.ts";
import { addressKeyOf } from "../../infra/state/protocol.ts";

export function waitingBadgeCount(queue: readonly SessionInfo[], current: SessionAddress | null): number {
	let count = 0;
	for (const row of queue) {
		if (row.location !== "inbox" || row.activity !== undefined) continue;
		// A parked or running attached row is never subtracted: it was never
		// counted. Only the waiting one the user is already looking at.
		if (current !== null && row.projectId === current.projectId && row.stem === current.stem) continue;
		count += 1;
	}
	return count;
}

/** How many of the counted Sessions are new to this page: the same filter as
 * `waitingBadgeCount`, narrowed to the addresses whose completion this page has
 * not read yet. Derived, never stored: an unread address whose row left the
 * waiting set simply stops counting, so a stale entry cannot keep the dot on the
 * badge. */
export function waitingNewCount(
	queue: readonly SessionInfo[],
	unread: readonly string[],
	current: SessionAddress | null,
): number {
	if (unread.length === 0) return 0;
	const keys = new Set(unread);
	let count = 0;
	for (const row of queue) {
		if (row.location !== "inbox" || row.activity !== undefined) continue;
		if (current !== null && row.projectId === current.projectId && row.stem === current.stem) continue;
		if (keys.has(addressKeyOf(row))) count += 1;
	}
	return count;
}

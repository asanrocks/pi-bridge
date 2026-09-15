// ============================================================================
// UnreadMessageCounter — pure counting model for the tab-title unread count.
// Counts sealed assistant messages (entries with a text block and a seal
// timestamp) that appear since the baseline. Pure/store-free so it is unit-
// testable without React (mirrors the store.ts/store.tsx split).
//
// Counting rules (agreed UX):
// - Unit = agent MESSAGE, not turn: an entry qualifies iff it has a text
//   block. Thinking-only and tool-only entries don't count. Aborted entries
//   with text do (they said something).
// - Sealed only: the provisional streaming entry (no timestamp, pending:
//   id) is excluded; at seal the durable entry appears once → +1. The
//   pending→durable re-key therefore cannot double-count.
// - All branches: entries live in the document across branches, so content
//   arriving on any branch (e.g. another client steering) counts.
// - The counter is focus-agnostic: callers decide whether a sync's new
//   messages increment the unread count (window unfocused) or are absorbed
//   silently (focused — the user is watching).
// ============================================================================

import type { Entry } from "../../../src/core/types.ts";

function isSealedMessage(e: Entry | undefined): boolean {
	return (
		!!e && e.kind === "message" && e.role === "assistant" && !!e.timestamp && e.content.some((b) => b.type === "text")
	);
}

export class UnreadMessageCounter {
	private seen = new Set<string>();
	private sessionKey: string | null = null;

	/** Session-identity check: true when the open session changed since the
	 *  last call (caller resets the count and rebases the baseline). The key is
	 *  the `sessionId` (ADR 09/11) — stable across the address form. */
	switchedSession(id: string | null): boolean {
		if (this.sessionKey === id) return false;
		this.sessionKey = id;
		this.seen.clear();
		return true;
	}

	/** Mark all current sealed messages as seen — the baseline. Used on
	 *  attach/session switch so pre-existing history never counts. */
	rebase(entries: Record<string, Entry>): void {
		for (const id in entries) {
			if (isSealedMessage(entries[id])) this.seen.add(id);
		}
	}

	/** Absorb new sealed messages; returns how many appeared since the last
	 *  sync/rebase. Newly seen entries are absorbed either way (the seen set
	 *  grows monotonically), so a focused caller discards the return value
	 *  and the next sync stays consistent. */
	sync(entries: Record<string, Entry>): number {
		let fresh = 0;
		for (const id in entries) {
			if (this.seen.has(id)) continue;
			if (isSealedMessage(entries[id])) {
				this.seen.add(id);
				fresh++;
			}
		}
		return fresh;
	}
}

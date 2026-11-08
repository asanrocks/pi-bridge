// ============================================================================
// queueAttention — completion detection over the work queue (ADR 23).
//
// The queue is the only global view of every Session's durable state, so a
// busy → notified transition seen there is a turn that finished somewhere —
// possibly in a Session this tab is not attached to, which is exactly what a
// notification must cover. The tracker therefore compares consecutive
// snapshots instead of watching the attached Document.
//
// Three transitions must not be announced, and each has one rule rather than a
// heuristic:
//   - the first snapshot of a connection (a reconnect re-fetches the queue;
//     every row it reports is news the client has not seen, not a completion),
//   - a Session that was already notified (a state the client saw, or one it
//     set itself — promotion and restore are not completions by construction),
//   - the Session this tab is reading, whose completion the tab title and unread
//     count already carry (`useStatusNotifications`).
// ============================================================================

import type { SessionInfo } from "../../../../src/core/index.ts";

/** One address, as the tracker keys its rows. */
export function sessionKey(row: Pick<SessionInfo, "projectId" | "stem">): string {
	return `${row.projectId}/${row.stem}`;
}

export class QueueAttention {
	private readonly states = new Map<string, SessionInfo["state"]>();
	/** The addressed Session this tab is reading, if any: its completions take
	 * the attached-view path instead of a notification. */
	private attached: string | null = null;
	private primed = false;

	/** The first snapshot of a connection: nothing in it is a completion. */
	seed(queue: readonly SessionInfo[]): void {
		this.states.clear();
		for (const row of queue) this.states.set(sessionKey(row), row.state);
		this.primed = true;
	}

	/** The Session the tab is reading; its own completions are silent here. */
	setAttached(key: string | null): void {
		this.attached = key;
	}

	/** Compare a published snapshot with the last one and return the rows that
	 * finished a turn since. A snapshot that arrives while the connection is
	 * not confirmed is the connect path's re-fetched baseline — the connect
	 * publishes `listQueue` before it flips the store to `connected`, so an
	 * unconfirmed snapshot is seeded, never compared: a Session that finished
	 * while the tab was away is news the client has not seen, not a completion
	 * it may announce. Always updates the recorded states. */
	observe(queue: readonly SessionInfo[], connectionConfirmed: boolean): SessionInfo[] {
		if (!connectionConfirmed) {
			this.seed(queue);
			return [];
		}
		if (!this.primed) {
			this.seed(queue);
			return [];
		}
		const completed: SessionInfo[] = [];
		const next = new Map<string, SessionInfo["state"]>();
		for (const row of queue) {
			const key = sessionKey(row);
			next.set(key, row.state);
			// Busy → notified is the one completion edge. A row that vanished
			// (closed, archived) has no state to compare; it is dropped below.
			if (row.state === "notified" && this.states.get(key) === "busy" && key !== this.attached) {
				completed.push(row);
			}
		}
		this.states.clear();
		for (const [key, state] of next) this.states.set(key, state);
		return completed;
	}
}

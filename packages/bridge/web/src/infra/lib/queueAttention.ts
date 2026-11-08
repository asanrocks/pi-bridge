// ============================================================================
// queueAttention — completion detection over the queue (ADR 23).
//
// The queue is the only global view of every Inbox and Later Session, so a
// running → not-running transition seen there is a turn that finished
// somewhere — possibly in a Session this tab is not attached to, which is
// exactly what a notification must cover. The tracker therefore compares
// consecutive snapshots instead of watching the attached Document. Running is
// the row's live activity (`SessionInfo.activity`); location is not involved,
// because finishing a turn never moves a Session.
//
// Three transitions must not be announced, and each has one rule rather than a
// heuristic:
//   - the first snapshot of a connection (a reconnect re-fetches the queue;
//     every row it reports is news the client has not seen, not a completion),
//   - a Session that was already idle (a row the client saw, or one it moved
//     itself — a move is not a completion by construction),
//   - the Session this tab is reading, whose completion the tab title and unread
//     count already carry (`useStatusNotifications`).
// ============================================================================

import type { SessionInfo } from "../../../../src/core/index.ts";

/** One address, as the tracker keys its rows. */
export function sessionKey(row: Pick<SessionInfo, "projectId" | "stem">): string {
	return `${row.projectId}/${row.stem}`;
}

export class QueueAttention {
	/** Whether each queued row was running, as of the last snapshot. */
	private readonly running = new Map<string, boolean>();
	/** The addressed Session this tab is reading, if any: its completions take
	 * the attached-view path instead of a notification. */
	private attached: string | null = null;
	private primed = false;

	/** The first snapshot of a connection: nothing in it is a completion. */
	seed(queue: readonly SessionInfo[]): void {
		this.running.clear();
		for (const row of queue) this.running.set(sessionKey(row), row.activity !== undefined);
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
		const next = new Map<string, boolean>();
		for (const row of queue) {
			const key = sessionKey(row);
			const running = row.activity !== undefined;
			next.set(key, running);
			// Running → idle is the one completion edge. A row that vanished
			// (moved to Archive, trashed) has nothing to compare; the map drops it
			// below, so its return is a new row rather than a completion.
			if (!running && this.running.get(key) === true && key !== this.attached) completed.push(row);
		}
		this.running.clear();
		for (const [key, running] of next) this.running.set(key, running);
		return completed;
	}
}

// ============================================================================
// sessionTime — the time slot every Session row renders (the sidebar rail, the
// compact switcher, the Launcher's queue): a running row says how long it has
// been running, every other row says how fresh it is.
//
// The run clock counts from the human's last message, not from the row's
// freshest entry: a streaming turn writes one per second, so an activity-based
// clock is pinned at "just now" for the whole run — the reason this module
// exists. Both instants are durable fields the host derives from the stored
// entries, so a reload, a reconnect, or a second tab reads the same number;
// the row's clock only re-renders it. The run reads as a bare duration (the
// mark and the status line already say what is running), formatted by the same
// helper as the status line's phase clock, and it ticks in seconds — the row
// subscribes to the fast clock while `activity` is present (useNow.ts).
// ============================================================================

import type { SessionInfo } from "../../../../src/core/index.ts";
import { formatSpan, formatWhen } from "../../infra/lib/time.ts";

/** The slot's text and the instant it is measured from — the `<time>`
 * element's `dateTime` and its hover title, which must name the same thing the
 * text does. */
export interface SessionTime {
	when: string;
	text: string;
}

/** The time slot for one row at `now` (the shared clock). A running row with
 * no user entry behind it (a recovery run) has no start to count from, so it
 * falls back to recency rather than inventing one. */
export function sessionTime(
	session: Pick<SessionInfo, "activity" | "timestamp" | "lastUserActivity" | "lastAgentActivity">,
	now: number,
): SessionTime {
	const since = session.lastUserActivity;
	if (session.activity !== undefined && since !== undefined) {
		const run = formatSpan(now - Date.parse(since));
		if (run !== "") return { when: since, text: run };
	}
	const when = session.lastAgentActivity ?? since ?? session.timestamp;
	return { when, text: formatWhen(when, now) };
}

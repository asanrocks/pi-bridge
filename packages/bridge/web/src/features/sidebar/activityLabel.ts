// ============================================================================
// activityLabel — the second line of a running Session row (ADR 23).
//
// An Inbox row that is not running previews its latest reply; a running row
// says what the execution is doing, and the tool line carries how long the
// current phase has run. The
// elapsed time is rebased onto the reader's clock: the host sends the phase's
// start instant, so a browser whose clock differs from the daemon's still
// shows the right duration (the rule `status.inFlightTools` follows).
// ============================================================================

import type { SessionActivityInfo } from "../../../../src/core/index.ts";
import { formatSpan } from "../../infra/lib/time.ts";

/** The running row's line: `Bash · 15m`, `Responding…`, `Compacting…`. Empty
 * for a row with no activity, so the caller renders no second line at all. */
export function activityLabel(activity: SessionActivityInfo | undefined, now: number): string {
	if (activity === undefined) return "";
	switch (activity.kind) {
		case "tool": {
			const startedAt = Date.parse(activity.startedAt);
			const elapsed = Number.isNaN(startedAt) ? "" : formatSpan(now - startedAt);
			return elapsed === "" ? activity.name : `${activity.name} · ${elapsed}`;
		}
		case "responding":
			return "Responding…";
		case "compacting":
			return "Compacting…";
	}
}

// formatGroupSpan — the elapsed time shown right-aligned in an action group's
// header ("took 20s"). An estimate assembled from two clocks: entry seals for
// settled calls (wall clock, so parallel calls count once — from the earliest
// call to the latest result) and the host-anchored elapsed for a call that is
// still running (rebased onto the client clock, so a reconnect or a second
// browser recovers it).
//
// Not a sum of pi's per-tool durations: those measure each call's own run, so
// adding them would double-count parallel work.

import { formatSpan } from "../../infra/lib/time.ts";

export interface GroupSpanAction {
	status: "pending" | "running" | "done" | "error";
	/** Seal of the assistant entry that issued the call; "" while the turn
	 *  streams (the issuing entry is provisional, so it has no seal yet). */
	callSealedAt: string;
	/** Seal of the tool-result entry; "" when there is no sealed result yet. */
	resultSealedAt: string;
	/** pi's recorded execution time, used only to place a settled call whose
	 *  issuing seal is unavailable. */
	durationMs: number | null;
	/** Host-anchored elapsed of a running call, ms (host clock, not rebased). */
	runningElapsedMs: number | undefined;
}

/** "took 20s" once the group's calls have settled, "running 4s" while one still
 *  executes, "" when nothing in the group can be placed in time (only thinking
 *  blocks, or calls whose arguments are still arriving). */
export function formatGroupSpan(actions: GroupSpanAction[], now: number): string {
	let start = Number.POSITIVE_INFINITY;
	let end = Number.NEGATIVE_INFINITY;
	let running = false;
	for (const a of actions) {
		if (a.status === "running") {
			// A dispatched call with no anchor yet cannot say when it started;
			// it joins the span on the next status refresh rather than guessing.
			if (a.runningElapsedMs === undefined) continue;
			running = true;
			start = Math.min(start, now - a.runningElapsedMs);
			end = Math.max(end, now);
			continue;
		}
		// "pending" means the call's arguments are still streaming — it has not
		// started, so it contributes nothing.
		if (a.status !== "done" && a.status !== "error") continue;
		const ended = Date.parse(a.resultSealedAt);
		if (Number.isNaN(ended)) continue;
		const issued = Date.parse(a.callSealedAt);
		const began = Number.isNaN(issued)
			? a.durationMs !== null && a.durationMs >= 0
				? ended - a.durationMs
				: ended
			: issued;
		start = Math.min(start, began);
		end = Math.max(end, ended);
	}
	if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
	const span = end - start;
	if (span < 0) return "";
	const text = formatSpan(span);
	return text ? `${running ? "running" : "took"} ${text}` : "";
}

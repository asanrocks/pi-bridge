// format — the conversation's header strings that are more than one call to a
// shared formatter: the spans a turn's details ledger reports, and the live
// status line of a streaming turn.

import { formatSpan } from "../../infra/lib/time.ts";

/** A wall-clock estimate's value text: `~1m 19s`. The tilde carries
 *  "approximate" in the value, so the details ledger needs no footnote sentence
 *  explaining that a duration is derived from turn seals rather than recorded.
 *  A bound is already approximate (`<1s`), so it takes no tilde. */
export function formatEstimate(span: string): string {
	if (!span || span.startsWith("<")) return span;
	return `~${span}`;
}

/** An estimated span worth a ledger row, or "" when it is not. Below a second it
 *  is noise rather than information: a sub-second tool share sits inside the
 *  turn total, and a sub-second reply gap is the reader's own fast turnaround.
 *  The same rule covers the two zeros those readings can produce — a tool-free
 *  turn resolves its share to 0, and `formatSpan` would render both as a
 *  confident `<1s`, a measurement the turn did not make. Absent is the honest
 *  form of "none", so the caller omits the row. */
export function formatReportedSpan(ms: number | undefined): string {
	if (ms === undefined || ms < 1000) return "";
	return formatEstimate(formatSpan(ms));
}

/** A streaming turn's status line: the live span plus the running-tool count —
 *  the only progress signal that does not wait for a content delta (ADR 21 moved
 *  it out of the header and below it, so moving statistics behind the date
 *  cannot hide the fact that work is in flight). Completed spans are statistics
 *  and live in the turn's details instead. "" when nothing is known. */
export function formatLiveStatus({
	turnStartedAt,
	runningTools,
	now,
}: {
	/** The turn's estimated start anchor (see AssistantTurn.turnStartedAt). */
	turnStartedAt: string | undefined;
	/** Tool blocks in the pending/running state. */
	runningTools: number;
	/** Wall clock for the live span (the caller ticks it every second). */
	now: number;
}): string {
	if (!turnStartedAt) return "";
	const startedMs = new Date(turnStartedAt).getTime();
	const span = formatSpan(Number.isNaN(startedMs) ? undefined : now - startedMs);
	if (!span) return "";
	return runningTools > 0 ? `working for ${span} · ${runningTools} running` : `working for ${span}`;
}

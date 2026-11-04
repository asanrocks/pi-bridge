// turnDetails — what a turn's date disclosure reports, as data.
//
// Extracted from the two turn views so the rules are testable without a store,
// a viewmodel, or a DOM, because the rules are the whole design: one subject per
// row (a branch and a commit are different facts, and a subject belongs to the
// commit), a label on every value, `~` for estimates, and absent data rendered
// as absent rather than as a zero or a placeholder.
//
// Presentation belongs elsewhere: TurnDetailsPanel renders these sections and
// their dividers, and the turn views supply the display names they resolve from
// the model catalog.

import type { AssistantTurn, UserTurn } from "../../../../src/viewmodel/index.ts";
import { formatSpan, formatWhenFull } from "../../infra/lib/time.ts";
import { formatEstimate, formatReportedSpan } from "./format.ts";
import type { DetailRow, DetailSection } from "./TurnDetailsPanel.tsx";

/** Drop empty sections, so a turn that recorded nothing in a group shows no
 *  divider for it. */
function sections(...groups: DetailRow[][]): DetailSection[] {
	return groups.filter((rows) => rows.length > 0).map((rows) => ({ rows }));
}

export function userTurnDetails({
	timestamp,
	thoughtForMs,
	gitIdentity,
	gitCommitSubject,
}: Pick<UserTurn, "timestamp" | "thoughtForMs" | "gitIdentity" | "gitCommitSubject">): DetailSection[] {
	const timing: DetailRow[] = [];
	const instant = formatWhenFull(timestamp);
	if (instant) timing.push({ label: "Time", value: instant });
	// The gap names a measurement, not a moment: the wall-clock interval from the
	// previous assistant completion (across branches) to this send. It says nothing
	// about attention — the reader may have been reading.
	const gap = formatReportedSpan(thoughtForMs);
	if (gap) timing.push({ label: "Since last reply", value: gap });

	// Each row disappears on its own: detached HEAD has no branch, an unborn
	// branch has no commit, and a v1 stamp has no subject.
	const repository: DetailRow[] = [];
	if (gitIdentity?.branch) repository.push({ label: "Branch", value: gitIdentity.branch });
	if (gitIdentity?.commit) repository.push({ label: "Commit", value: gitIdentity.commit.slice(0, 8) });
	if (gitCommitSubject) repository.push({ label: "Subject", value: gitCommitSubject });

	return sections(timing, repository);
}

export function assistantTurnDetails({
	timestamp,
	turnStartedAt,
	modelName,
	providerName,
	totalMs,
	toolMs,
	contextPercent,
	contextDeltaPercent,
}: Pick<
	AssistantTurn,
	"timestamp" | "turnStartedAt" | "totalMs" | "toolMs" | "contextPercent" | "contextDeltaPercent"
> & {
	/** Resolved from the model catalog by the view (it owns the store). */
	modelName?: string;
	providerName?: string;
}): DetailSection[] {
	// The header names the start anchor while the turn is unsealed (it has no
	// instant of its own yet); the ledger must name the same moment.
	const producer: DetailRow[] = [];
	if (modelName) producer.push({ label: "Model", value: modelName });
	if (providerName) producer.push({ label: "Provider", value: providerName });

	const context: DetailRow[] = [];
	if (contextPercent !== undefined) {
		const pct = Math.round(contextPercent);
		const delta = contextDeltaPercent === undefined ? undefined : Math.round(contextDeltaPercent);
		const change = delta === undefined ? "" : ` (${delta >= 0 ? "+" : ""}${delta}%)`;
		context.push({ label: "Context", value: `${pct}%${change}` });
	}

	const timing: DetailRow[] = [];
	const instant = formatWhenFull(timestamp || turnStartedAt || "");
	if (instant) timing.push({ label: "Time", value: instant });
	const work = formatSpan(totalMs);
	if (work) timing.push({ label: "Duration", value: formatEstimate(work) });
	// Below a second, or the zero of a tool-free turn, the share is not a reading
	// worth a row — see formatReportedSpan.
	const tools = formatReportedSpan(toolMs);
	if (tools) timing.push({ label: "Tools", value: tools });

	return sections(producer, context, timing);
}

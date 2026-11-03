// format — the conversation's header strings that are more than one call to a
// shared formatter: the git identity chip and the turn span fragment.

import { formatSpan } from "../../infra/lib/time.ts";

// formatGitIdentity — ADR 10 stamp chip text for a user-turn header.
// "main @ a1b2c3d" normally; "a1b2c3d" for detached HEAD; "main" for an unborn
// branch. Returns "" when nothing is known (both null). The git mark itself is a
// glyph (`BranchIcon`), not a character: `⎇` is a font glyph that renders at the
// text baseline and varies by font, which is exactly what the icon contract
// bans, and it cannot take the control's ink.
export function formatGitIdentity(identity: { commit: string | null; branch: string | null }): string {
	const branch = identity.branch;
	const commit = identity.commit ? identity.commit.slice(0, 8) : null;
	if (branch && commit) return `${branch} @ ${commit}`;
	if (branch) return branch;
	if (commit) return commit;
	return "";
}

/** The assistant turn's header span: an estimate, never a pi-recorded value
 *  (see AssistantTurn.totalMs). Sealed turns name the span and, once the tool
 *  split passes a second, the tool share; a streaming turn shows a live span
 *  plus the running-tool count, which is the only progress signal that does not
 *  wait for content to arrive. "" when nothing is known — no anchor yet, or a
 *  turn that has not sealed. */
export function formatTurnSpan({
	isStreaming,
	turnStartedAt,
	totalMs,
	toolMs,
	runningTools,
	now,
}: {
	isStreaming: boolean;
	turnStartedAt: string | undefined;
	/** Sealed span; undefined while the turn streams. */
	totalMs: number | undefined;
	/** Sealed tool share; undefined when the split could not resolve. */
	toolMs: number | undefined;
	/** Tool blocks in the pending/running state (streaming turn only). */
	runningTools: number;
	/** Wall clock for the live span (the caller ticks it every second). */
	now: number;
}): string {
	if (isStreaming) {
		if (!turnStartedAt) return "";
		const startedMs = new Date(turnStartedAt).getTime();
		const span = formatSpan(Number.isNaN(startedMs) ? undefined : now - startedMs);
		if (!span) return "";
		return runningTools > 0 ? `working for ${span} · ${runningTools} running` : `working for ${span}`;
	}
	if (totalMs === undefined) return "";
	const total = formatSpan(totalMs);
	if (!total) return "";
	// A sub-second tool share is noise next to the total.
	const tools = toolMs !== undefined && toolMs >= 1000 ? formatSpan(toolMs) : "";
	return tools ? `worked for ${total} · tools ${tools}` : `worked for ${total}`;
}

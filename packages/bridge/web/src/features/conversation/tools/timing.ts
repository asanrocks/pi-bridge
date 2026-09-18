// Timing for tool executions, keyed by toolCallId.
//
// Session-scoped cache: toolCallId is stable across the provisional→durable
// entry move (tool_execution_start adds pending:<toolCallId>,
// tool_execution_end seals to a durable id), but the assistant MESSAGE entry
// id is NOT — it moves pending:message→durable on turn seal, and
// ConversationArea keys AssistantTurnView by that entry id, remounting the
// whole turn subtree (including every card). Component-local refs would reset
// on that remount; this cache, keyed by the stable toolCallId, survives it.
// Mirrors the TUI (bash.ts stamps state.startedAt in render): stamps are
// wall-clock-at-render, so timing shows only for runs witnessed live.
// Resumed/past runs have no start stamp — and exec-start isn't on the wire
// either — so the status light renders without a duration on reload (status
// is derivable from isError; timing is not).

import { useEffect, useState } from "react";
import type { ToolActionVM } from "../../../../../src/viewmodel/index.ts";

const toolTiming = new Map<string, { startedAt: number | null; endedAt: number | null }>();

/**
 * Stamp + read timing for one tool execution. Returns null when no start
 * stamp exists (pending, or a reloaded/resumed run whose start was never
 * observed and isn't on the wire). Stamping is idempotent (lazy-init
 * pattern, safe under React strict-mode double render) and done in render —
 * not an effect — so the first paint carries the value; an effect would
 * miss the post-seal remount case (status done, no running tick to trigger
 * a re-render after stamping).
 */
export function useToolTiming(toolCallId: string, status: ToolActionVM["status"]) {
	const [, setTick] = useState(0);

	// 1s re-render while running so the live elapsed updates.
	useEffect(() => {
		if (status !== "running") return;
		const id = setInterval(() => setTick((t) => t + 1), 1000);
		return () => clearInterval(id);
	}, [status]);

	if (!toolCallId || status === "pending") return null;

	let t = toolTiming.get(toolCallId);
	// Only create/stamp on running — done/error without a prior running
	// stamp is a reloaded run; no start exists, so don't pollute the cache.
	if (status === "running") {
		if (!t) {
			t = { startedAt: null, endedAt: null };
			toolTiming.set(toolCallId, t);
		}
		if (t.startedAt === null) t.startedAt = Date.now();
	}
	// Stamp end only for runs we witnessed start (live settle).
	if ((status === "done" || status === "error") && t && t.startedAt !== null && t.endedAt === null) {
		t.endedAt = Date.now();
	}

	if (!t || t.startedAt === null) return null;
	return { startedAt: t.startedAt, endedAt: t.endedAt };
}

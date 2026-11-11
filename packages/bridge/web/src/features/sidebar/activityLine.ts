// ============================================================================
// activityLine — the second line of a running Session row: which tool is
// executing with its phase clock, and what the agent is saying right now.
//
// The words come from the row's `lastAgentText` (the agent's own latest text,
// or its thinking when that is all it has written), never from the human's
// prompt: "Responding…" as the whole line answered nothing. The elapsed time
// is rebased onto the reader's clock — the host sends the phase's start
// instant, so a browser whose clock differs from the daemon's still shows the
// right duration, and the row re-renders every second while it is running (see
// useNow.ts).
// ============================================================================

import type { SessionInfo } from "../../../../src/core/index.ts";
import { formatSpan } from "../../infra/lib/time.ts";

/** The executing tool and its phase clock. `elapsed` is absent when the start
 * instant is unusable, so the chip never invents a duration. */
export interface RunningTool {
	name: string;
	elapsed?: string;
}

/** A row's second line: what the agent is saying, and the tool it is saying it
 * through. `tool` absent means no tool is running; `text` empty means the agent
 * has not written anything yet. */
export interface ActivityLine {
	tool?: RunningTool;
	text: string;
}

/** The running row's line, or null when nothing is executing (the row then
 * renders no second line at all). */
export function activityLine(
	session: Pick<SessionInfo, "activity" | "lastAgentText">,
	now: number,
): ActivityLine | null {
	const activity = session.activity;
	if (activity === undefined) return null;
	const text = session.lastAgentText ?? "";
	switch (activity.kind) {
		case "tool": {
			const startedAt = Date.parse(activity.startedAt);
			const elapsed = Number.isNaN(startedAt) ? "" : formatSpan(now - startedAt);
			return { tool: elapsed === "" ? { name: activity.name } : { name: activity.name, elapsed }, text };
		}
		case "responding":
			return { text: text === "" ? "Responding…" : text };
		case "compacting":
			// A compaction is not the agent speaking, so the last words would be
			// stale text sitting under a different operation.
			return { text: "Compacting…" };
	}
}

/** The line as one flat string: the hover title, where a narrow row clips the
 * words but the reader still wants the whole line. */
export function activityLineTitle(line: ActivityLine): string {
	if (line.tool === undefined) return line.text;
	const tool = line.tool.elapsed === undefined ? line.tool.name : `${line.tool.name} · ${line.tool.elapsed}`;
	return line.text === "" ? tool : `${tool} — ${line.text}`;
}

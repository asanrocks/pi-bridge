// RowPreview — the collapsed tinted row's result preview (TUI parity). While
// the details are collapsed, the search tools (grep/find/ls) show a head of
// the matches/listing, and any failed call shows the first line of its
// error text. Bash does NOT preview in the tinted row: a collapsed bash action is a
// one-line command (the tail lives inside the expanded card — see
// BashCardBody's three-state progression).
//
// Pull economics: only previewing tools and failed calls register result
// pulls here, and actions render solely inside expanded groups — so result
// pulls stay bounded by what the user actually opened.

import { memo } from "react";
import { resultPullPaths, type ToolActionVM } from "../../../../../src/viewmodel/index.ts";
import { enqueuePulls } from "../../../infra/net/pullQueue.ts";
import { useStore } from "../../../infra/state/store.tsx";
import styles from "../actions.module.css";
import { useResultText } from "./args.ts";
import { errorPreviewLine, headPreview } from "./resultText.ts";

const HEAD_PREVIEW_LINES = 5;

/** Search tools whose matches/listings preview from the head. */
const HEAD_PREVIEW_TOOLS = new Set(["grep", "find", "ls"]);

export const RowPreview = memo(function RowPreview({ action }: { action: ToolActionVM }) {
	const isHead = HEAD_PREVIEW_TOOLS.has(action.toolName);
	const resultNeedsPull = action.result !== null && (isHead || action.result.isError);

	// ADR 09: pullTick re-registers pulls after pull failures and refreshes
	// the preview after ingests.
	useStore((s) => s.pullTick);
	enqueuePulls(resultNeedsPull && action.result ? resultPullPaths(action.result.entryId) : []);

	const resultText = useResultText(action);

	if (resultText === null) return null;

	if (isHead) {
		const { lines, skipped } = headPreview(resultText, HEAD_PREVIEW_LINES);
		return (
			<div className={styles.rowPreview} aria-hidden="true">
				{lines.map((line, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: preview lines have no stable id
					<div key={i} className={styles.rowPreviewLine}>
						{line || "\u00A0"}
					</div>
				))}
				{skipped > 0 && (
					<div className={styles.rowPreviewHint}>{`… ${skipped} more line${skipped === 1 ? "" : "s"}`}</div>
				)}
			</div>
		);
	}

	if (action.result?.isError) {
		return (
			<div className={styles.rowPreviewError} aria-hidden="true">
				{errorPreviewLine(resultText)}
			</div>
		);
	}
	return null;
});

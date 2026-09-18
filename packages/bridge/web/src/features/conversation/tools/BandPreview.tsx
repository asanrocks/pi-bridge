// BandPreview — the collapsed band's result preview (TUI parity). While
// the details are folded, the search tools (grep/find/ls) show a head of
// the matches/listing, and any failed call shows the first line of its
// error text. Bash does NOT preview in the band: a folded bash step is a
// one-line command (the tail lives inside the expanded card — see
// BashCardBody's three-state progression).
//
// Pull economics: only previewing tools and failed calls register result
// wants here, and steps render solely inside expanded groups — so result
// pulls stay bounded by what the user actually opened.

import { memo } from "react";
import { resultPullPaths, type ToolActionStepVM } from "../../../../../src/viewmodel/index.ts";
import { useStore } from "../../../infra/store.tsx";
import { wantPull } from "../../../infra/wants.ts";
import styles from "../actionSteps.module.css";
import { useResultText } from "./args.ts";
import { errorPreviewLine, headPreview } from "./resultText.ts";

const HEAD_PREVIEW_LINES = 5;

/** Search tools whose matches/listings preview from the head. */
const HEAD_PREVIEW_TOOLS = new Set(["grep", "find", "ls"]);

export const BandPreview = memo(function BandPreview({ step }: { step: ToolActionStepVM }) {
	const isHead = HEAD_PREVIEW_TOOLS.has(step.toolName);
	const wantsPullResult = step.result !== null && (isHead || step.result.isError);

	// ADR 09: pullTick re-registers wants after pull failures and refreshes
	// the preview after ingests.
	useStore((s) => s.pullTick);
	wantPull(wantsPullResult && step.result ? resultPullPaths(step.result.entryId) : []);

	const resultText = useResultText(step);

	if (resultText === null) return null;

	if (isHead) {
		const { lines, skipped } = headPreview(resultText, HEAD_PREVIEW_LINES);
		return (
			<div className={styles.bandPreview} aria-hidden="true">
				{lines.map((line, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: preview lines have no stable id
					<div key={i} className={styles.bandPreviewLine}>
						{line || "\u00A0"}
					</div>
				))}
				{skipped > 0 && (
					<div className={styles.bandPreviewHint}>{`… ${skipped} more line${skipped === 1 ? "" : "s"}`}</div>
				)}
			</div>
		);
	}

	if (step.result?.isError) {
		return (
			<div className={styles.bandPreviewError} aria-hidden="true">
				{errorPreviewLine(resultText)}
			</div>
		);
	}
	return null;
});

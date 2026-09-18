// BashCardBody — the bash card's three-state content: folded band shows a
// one-line command; expanded shows the status line, the command as
// identity, and "... N earlier lines" + the output tail; "show all" (the
// top-bar cap toggle) shows the command plus the whole output. No inner
// scroll window — the cap is line-count-based (BASH_TAIL_LINES), unlike
// the byte/panel-cap the other card kinds use.
//
// The status light/duration/timeout and exit/timeout/abort chips render in
// the skeleton's status line; the command in its identity line.

import { memo, useCallback, useMemo } from "react";
import { useStore } from "../../../infra/state/store.tsx";
import styles from "../actionSteps.module.css";
import type { ActionDetailsProps } from "./args.ts";
import { TruncationNotice } from "./CardSkeleton.tsx";
import { BASH_TAIL_LINES, bashTailPreview, parseBashResult } from "./resultText.ts";

export const BashCardBody = memo(function BashCardBody({ step, resultText }: ActionDetailsProps) {
	const wrap = useStore((s) => s.cardWrap);
	// Tail-vs-full follows the skeleton's cap toggle (same store key the
	// top-bar "show all" control flips).
	const actionKey = `${step.entryId}:b${step.blockIndex}`;
	const isUncapped = useStore(useCallback((s) => s.uncappedDetails.has(actionKey), [actionKey]));

	const parsed = useMemo(() => parseBashResult(resultText ?? ""), [resultText]);
	// Hooks must run before the early return below (React hook order).
	const tail = useMemo(
		() =>
			isUncapped || resultText === null || resultText === undefined
				? null
				: bashTailPreview(parsed.output, BASH_TAIL_LINES),
		[isUncapped, parsed.output, resultText],
	);

	if (resultText === null || resultText === undefined) return null;

	const lines = tail ? tail.lines : parsed.output.split("\n");
	return (
		<div className={styles.cardBody}>
			{tail && tail.skipped > 0 && (
				<div className={styles.outputHint}>{`… ${tail.skipped} earlier line${tail.skipped === 1 ? "" : "s"}`}</div>
			)}
			{parsed.output && (
				<div className={styles.cardOutput} data-wrap={wrap || undefined}>
					{lines.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: result lines have no stable id
						<div key={i} className={styles.outputLine}>
							{line}
						</div>
					))}
				</div>
			)}
			{parsed.notice && <TruncationNotice notice={parsed.notice} fullPath={parsed.fullPath} />}
		</div>
	);
});

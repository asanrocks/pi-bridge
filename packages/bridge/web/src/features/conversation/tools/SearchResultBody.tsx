// SearchResultBody — the result renderer for the read-like search tools
// (grep/find/ls). The identity line carries the call (`/pattern/ in path`,
// glob, limit); the body is the match/listing output on the white inset
// panel, plus a warning strip when the tool truncated (limits live in the
// tool_result `details` object — lazy-pulled, same as content).

import { memo, useCallback } from "react";
import { useStore } from "../../../infra/store.tsx";
import styles from "../conversation.module.css";
import type { ActionDetailsProps } from "./args.ts";
import { truncationWarnings } from "./resultText.ts";

export const SearchResultBody = memo(function SearchResultBody({ step, resultText }: ActionDetailsProps) {
	const wrap = useStore((s) => s.cardWrap);
	const warnings = useStore(
		useCallback(
			(s) => {
				if (!step.result) return [];
				const entry = s.document.entries[step.result.entryId];
				if (!entry || entry.kind !== "tool_result") return [];
				return truncationWarnings(entry.details);
			},
			[step.result],
		),
	);

	if (resultText === null || resultText === undefined) return null;
	return (
		<div className={styles.cardBody}>
			<div className={styles.cardOutput} data-wrap={wrap || undefined}>
				{resultText.split("\n").map((line, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: result lines have no stable id
					<div key={i} className={styles.outputLine}>
						{line}
					</div>
				))}
			</div>
			{warnings.length > 0 && <div className={styles.cardNotice}>{`truncated — ${warnings.join(", ")}`}</div>}
		</div>
	);
});

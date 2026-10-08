// SearchResultBody — the result renderer for the read-like search tools
// (grep/find/ls). The header line carries the call (`/pattern/ in path`,
// glob, limit); the body is the match/listing output on the white inset
// panel, plus a warning strip when the tool truncated (limits live in the
// tool_result `details` object — lazy-pulled, same as content).

import { memo, useMemo } from "react";
import type { JsonValue } from "../../../../../src/core/types.ts";
import type { ToolActionVM } from "../../../../../src/viewmodel/index.ts";
import type { ClientStore } from "../../../infra/state/store.ts";
import { useStore } from "../../../infra/state/store.tsx";
import styles from "../actions.module.css";
import type { ActionDetailsProps } from "./args.ts";
import { truncationWarnings } from "./resultText.ts";

/**
 * Selects the result entry's `details` — a stable document reference the
 * lazy pull replaces wholesale. Selecting the reference (and deriving the
 * warning array outside the store) is the contract React's
 * useSyncExternalStore enforces: the selector is the getSnapshot, and a
 * getSnapshot that returns a fresh array on every call loops on mount and
 * unmounts the whole tree. That is exactly what this selector used to do
 * (fresh `[]` / `truncationWarnings(...)` per call): expanding any
 * grep/find/ls card threw "The result of getSnapshot should be cached" and
 * blanked the page.
 */
export function selectResultDetails(action: ToolActionVM): (s: ClientStore) => JsonValue | null {
	return (s) => {
		if (!action.result) return null;
		const entry = s.document.entries[action.result.entryId];
		return entry?.kind === "tool_result" ? entry.details : null;
	};
}

export const SearchResultBody = memo(function SearchResultBody({ action, resultText }: ActionDetailsProps) {
	const wrap = useStore((s) => s.cardWrap);
	const details = useStore(useMemo(() => selectResultDetails(action), [action]));
	const warnings = useMemo(() => truncationWarnings(details), [details]);

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

// SystemTurnView — compaction/branch_summary render markdown summary below a
// divider; model_switch renders the merged switch line as a single markdown
// line (normal case, no all-caps label).

import { memo, useCallback } from "react";
import type { SystemTurn } from "../../../../src/viewmodel/index.ts";
import { useStore } from "../../infra/store.tsx";
import { Markdown } from "../../render/markdown.tsx";
import { displayModelLabel } from "../../render/modelNames.ts";
import styles from "./conversation.module.css";

const SYSTEM_LABEL: Record<SystemTurn["type"], string> = {
	compaction: "Compaction",
	branch_summary: "Branch",
	model_switch: "Model Change",
};

export const SystemTurnView = memo(function SystemTurnView({ turn }: { turn: SystemTurn }) {
	const isDimmed = useStore(useCallback((s) => s.draft.kind === "edit" && turn.index >= s.draft.index, [turn.index]));
	const models = useStore(useCallback((s) => s.models, []));

	if (turn.type === "model_switch" && turn.switchTo) {
		const { provider, modelId, thinkingLevel } = turn.switchTo;
		const text =
			modelId !== ""
				? `Model: **${displayModelLabel(provider, modelId, models)}**${
						thinkingLevel !== undefined ? `, thinking ${thinkingLevel}` : ""
					}`
				: `Thinking: ${thinkingLevel}`;
		// The merged switch line keeps the original line-separated divider
		// presentation (rules on both sides) instead of a bare paragraph.
		return (
			<div
				className={`${styles.systemDivider} ${styles.systemSwitch} ${styles.markdownContent} ${isDimmed ? styles.msgDimmed : ""}`}
			>
				<Markdown text={text} mode="static" />
			</div>
		);
	}

	if (turn.summary !== undefined) {
		return (
			<div className={isDimmed ? styles.msgDimmed : undefined}>
				<div className={styles.systemDivider}>
					<span className={styles.systemDividerLabel}>{SYSTEM_LABEL[turn.type]}</span>
				</div>
				<div className={`${styles.systemSummary} ${styles.markdownContent}`}>
					<Markdown text={turn.summary} mode="static" />
				</div>
			</div>
		);
	}

	return (
		<div className={`${styles.systemDivider} ${isDimmed ? styles.msgDimmed : ""}`}>
			<span className={styles.systemDividerLabel}>{SYSTEM_LABEL[turn.type]}</span>
		</div>
	);
});

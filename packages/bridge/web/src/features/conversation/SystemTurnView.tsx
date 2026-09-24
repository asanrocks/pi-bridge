// SystemTurnView — compaction/branch_summary render markdown summary below a
// divider; model_switch renders the merged switch line as a single markdown
// line (normal case, no all-caps label); system_prompt renders as a message —
// header over the prompt text, folded by default and shown highlighted on
// click; unknown dumps the raw source entry for an unclassifiable one.

import { memo, useCallback, useState } from "react";
import type { SystemTurn } from "../../../../src/viewmodel/index.ts";
import { formatTimestamp } from "../../infra/lib/time.ts";
import { useStore } from "../../infra/state/store.tsx";
import { CodeSnippet } from "../../render/CodeSnippet.tsx";
import { Markdown } from "../../render/markdown.tsx";
import { displayModelLabel } from "../../render/modelNames.ts";
import actionStyles from "./actions.module.css";
import styles from "./turns.module.css";

const SYSTEM_LABEL: Record<SystemTurn["type"], string> = {
	compaction: "Compaction",
	branch_summary: "Branch",
	model_switch: "Model Change",
	system_prompt: "System prompt update",
	unknown: "Unrecognized",
};

/** The prompt diff's text: the changed sections' contents in payload order,
 * joined into the prompt as rendered. A string is the section's new text; a
 * `null` section was removed and contributes nothing. */
function promptText(detail: SystemTurn["detail"]): string | null {
	if (detail?.kind !== "message") return null;
	const raw = detail.sections;
	if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return null;
	const parts: string[] = [];
	for (const value of Object.values(raw)) {
		if (typeof value === "string") parts.push(value);
	}
	return parts.length > 0 ? parts.join("\n\n") : null;
}

/** The system-prompt turn as a read-style card: a tinted row named `System
 * prompt update`, expanding to a details card with the changed sections and
 * the prompt text highlighted as markdown. Mirrors ToolActionView's read card —
 * same skeleton, no tool status line. */
const SystemPromptCard = memo(function SystemPromptCard({ turn, isDimmed }: { turn: SystemTurn; isDimmed: boolean }) {
	const [expanded, setExpanded] = useState(false);
	const text = promptText(turn.detail);
	const ts = formatTimestamp(turn.detail?.timestamp ?? "");
	const name = SYSTEM_LABEL[turn.type];
	// The row is named (like a tool card's summary), not a list of sections; the
	// changed sections are the header detail inside the card.
	const headerLine = [turn.summary, ts].filter(Boolean).join(" · ");
	return (
		<div className={`${actionStyles.action} ${isDimmed ? styles.msgDimmed : ""}`} data-kind="read">
			<div className={actionStyles.actionHead}>
				<button
					type="button"
					className={actionStyles.actionCollapsed}
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
					aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`}
				>
					<span className={actionStyles.collapseTri}>{expanded ? "\u25BE" : "\u25B8"}</span>
					<span className={actionStyles.actionSummary}>{name}</span>
				</button>
			</div>
			{expanded && (
				<div className={actionStyles.detailsCard}>
					<div className={actionStyles.cardHeader}>{headerLine}</div>
					{text !== null && (
						<div className={actionStyles.actionDetailsWrap}>
							<div className={actionStyles.actionDetails}>
								<div className={actionStyles.cardBody}>
									<CodeSnippet code={text} language="markdown" wrap />
								</div>
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
});

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

	if (turn.type === "system_prompt") {
		return <SystemPromptCard turn={turn} isDimmed={isDimmed} />;
	}

	if (turn.type === "unknown") {
		return (
			<div className={isDimmed ? styles.msgDimmed : undefined}>
				<div className={styles.systemDivider}>
					<span className={styles.systemDividerLabel}>{SYSTEM_LABEL[turn.type]}</span>
					{turn.summary !== undefined && <span>{turn.summary}</span>}
				</div>
				{turn.detail !== undefined && (
					<details className={styles.systemRawWrap}>
						<summary className={styles.systemRawSummary}>Details</summary>
						<pre className={styles.systemRaw}>{JSON.stringify(turn.detail, null, 2)}</pre>
					</details>
				)}
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

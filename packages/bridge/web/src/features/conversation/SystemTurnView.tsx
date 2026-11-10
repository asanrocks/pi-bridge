// SystemTurnView — compaction/branch_summary render markdown summary below a
// divider; model_switch renders the merged switch line as a single markdown
// line (normal case, no all-caps label); system_prompt renders as a message —
// header over the prompt text, folded by default and shown highlighted on
// click; unknown dumps the raw source entry for an unclassifiable one.

import { memo, useCallback, useState } from "react";
import type { SystemTurn } from "../../../../src/viewmodel/index.ts";
import { formatWhen, formatWhenFull } from "../../infra/lib/time.ts";
import { useNow } from "../../infra/lib/useNow.ts";
import { enqueuePulls } from "../../infra/net/pullQueue.ts";
import { useStore } from "../../infra/state/store.tsx";
import { CodeSnippet } from "../../render/CodeSnippet.tsx";
import { CaretIcon } from "../../render/icons.tsx";
import { Markdown } from "../../render/markdown.tsx";
import { displayModelLabel } from "../../render/modelNames.ts";
import { formatCost, formatTokens } from "../composer/formatters.ts";
import actionStyles from "./actions.module.css";
import styles from "./turns.module.css";

const SYSTEM_LABEL: Record<SystemTurn["type"], string> = {
	compaction: "Compaction",
	branch_summary: "Branch",
	model_switch: "Model Change",
	system_prompt: "System prompt update",
	extension: "Extension",
	extension_message: "Extension message",
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
	// The section text is lazy (LAZY_FIELD_PATTERNS): declare the pull while
	// expanded; the VM re-projects once it lands.
	if (expanded) {
		enqueuePulls([{ entryId: turn.entryId, fieldPath: `/entries/${turn.entryId}/sections` }]);
	}
	const text = promptText(turn.detail);
	const now = useNow();
	const timestamp = turn.detail?.timestamp ?? "";
	const ts = formatWhen(timestamp, now);
	const fullTs = formatWhenFull(timestamp);
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
					<span className={actionStyles.collapseTri}>
						<CaretIcon size={12} direction={expanded ? "down" : "right"} />
					</span>
					<span className={actionStyles.actionSummary}>{name}</span>
				</button>
			</div>
			{expanded && (
				<div className={actionStyles.detailsCard}>
					<div className={actionStyles.cardHeader} title={fullTs || undefined}>
						{headerLine}
					</div>
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

/** A compaction boundary as a folded card, mirroring the system-prompt card:
 * the collapsed row is the boundary's size, and expanding reveals the summary
 * pi wrote. Folded by default because the summary is model prose, not the
 * conversation: a long one must not push the tail turn off screen. */
const CompactionCard = memo(function CompactionCard({ turn, isDimmed }: { turn: SystemTurn; isDimmed: boolean }) {
	const [expanded, setExpanded] = useState(false);
	const now = useNow();
	const tokens = turn.tokensBefore !== undefined ? formatTokens(turn.tokensBefore) : null;
	const summaryLine = tokens !== null ? `Context compacted · ${tokens} tokens` : "Context compacted";
	const ts = turn.timestamp !== undefined ? formatWhen(turn.timestamp, now) : "";
	const fullTs = turn.timestamp !== undefined ? formatWhenFull(turn.timestamp) : "";
	const cost = turn.usage !== undefined && turn.usage !== null ? formatCost(turn.usage.cost.total) : null;
	const headerLine = [tokens !== null ? `${tokens} tokens summarized` : null, cost, ts].filter(Boolean).join(" · ");
	return (
		<div className={`${actionStyles.action} ${isDimmed ? styles.msgDimmed : ""}`} data-kind="read">
			<div className={actionStyles.actionHead}>
				<button
					type="button"
					className={actionStyles.actionCollapsed}
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
					aria-label={`${expanded ? "Collapse" : "Expand"} compaction summary`}
				>
					<span className={actionStyles.collapseTri}>
						<CaretIcon size={12} direction={expanded ? "down" : "right"} />
					</span>
					<span className={actionStyles.actionSummary}>{summaryLine}</span>
				</button>
			</div>
			{expanded && (
				<div className={actionStyles.detailsCard}>
					<div className={actionStyles.cardHeader} title={fullTs || undefined}>
						{headerLine}
					</div>
					{turn.summary !== undefined && (
						<div className={actionStyles.actionDetailsWrap}>
							<div className={actionStyles.actionDetails}>
								<div className={`${actionStyles.cardBody} ${styles.markdownContent}`}>
									<Markdown text={turn.summary} mode="static" />
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

	if (turn.type === "compaction") {
		return <CompactionCard turn={turn} isDimmed={isDimmed} />;
	}

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

	if (turn.type === "unknown" || turn.type === "extension") {
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

// AgentMessageCard — one inter-agent message as a folded read-style row.
// Inter-agent traffic arrives as content the reader did not write: the header
// names the sender and the envelope kind, and the body — the envelope the
// recipient's model read, or the answer a spawn card folded — stays closed until
// asked for. A `FINAL_ANSWER` carries the sender's whole turn, so an unfolded
// body would be a wall of another agent's work in the middle of the transcript.
// The same row serves a standalone message and a reply folded into its spawn
// card; only the label differs.

import { memo, useState } from "react";
import type { AgentMessageKind } from "../../../../src/core/agent-contract.ts";
import { CaretIcon } from "../../render/icons.tsx";
import { Markdown } from "../../render/markdown.tsx";
import actionStyles from "./actions.module.css";
import styles from "./turns.module.css";

const KIND_LABEL: Record<AgentMessageKind, string> = {
	message: "Message",
	new_task: "New task",
	final_answer: "Final answer",
};

/** The folded row's label: the envelope kind, or the settlement a final answer
 * reported. One function so a message row in the action list and a standalone
 * row name the same envelope alike. */
export function agentKindLabel(kind: AgentMessageKind | undefined, outcome?: "completed" | "errored"): string {
	if (kind === undefined) return "Agent message";
	if (kind === "final_answer" && outcome === "errored") return "Errored";
	return KIND_LABEL[kind];
}

/** The sender's canonical path and a label naming what arrived: an envelope kind
 * (`Message`, `New task`, `Final answer`) or a settlement (`Errored`). */
export const AgentMessageCard = memo(function AgentMessageCard({
	sender,
	label,
	text,
	isDimmed = false,
}: {
	sender: string;
	label: string;
	text: string;
	isDimmed?: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const headerLine = [sender, label].filter((part) => part !== "").join(" · ");
	return (
		<div className={`${actionStyles.action} ${isDimmed ? styles.msgDimmed : ""}`} data-kind="agent">
			<div className={actionStyles.actionHead}>
				<button
					type="button"
					className={actionStyles.actionCollapsed}
					onClick={() => setExpanded((value) => !value)}
					aria-expanded={expanded}
					aria-label={`${expanded ? "Collapse" : "Expand"} agent message`}
				>
					<span className={actionStyles.collapseTri}>
						<CaretIcon size={12} direction={expanded ? "down" : "right"} />
					</span>
					<span className={actionStyles.actionSummary}>{headerLine}</span>
				</button>
			</div>
			{expanded && text !== "" && (
				<div className={actionStyles.detailsCard}>
					<div className={actionStyles.actionDetailsWrap}>
						<div className={actionStyles.actionDetails}>
							<div className={`${actionStyles.cardBody} ${styles.markdownContent}`}>
								<Markdown text={text} mode="static" />
							</div>
						</div>
					</div>
				</div>
			)}
		</div>
	);
});

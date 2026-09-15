// GitChangeView — ADR 10 v2 git stamp card. A slim divider-style band at the
// stamp's path position: identity chip, optional HEAD subject, and the
// observation boundary. Neutral wording ("Git state observed") — with
// parallel tools the boundary is positional, not causal, so the card never
// claims a particular tool made the change.

import { memo } from "react";
import type { GitChangeTurn } from "../../../../src/viewmodel/index.ts";
import styles from "./conversation.module.css";
import { formatGitIdentity, formatTimestamp } from "./format.ts";

const ANCHOR_LABEL: Record<GitChangeTurn["anchor"], string> = {
	prompt: "at prompt",
	tool_end: "after tool",
	turn_end: "after turn",
	user_bash_end: "after command",
};

export const GitChangeView = memo(function GitChangeView({ turn }: { turn: GitChangeTurn }) {
	const ts = formatTimestamp(turn.timestamp);
	const identity = formatGitIdentity(turn.identity);
	return (
		<div className={styles.gitChange} data-turn-key={turn.entryId} data-entry-id={turn.entryId}>
			<span className={styles.gitChangeLabel}>{turn.isInitial ? "Git state" : "Git state observed"}</span>
			{identity && <span className={styles.gitChangeIdentity}>{identity}</span>}
			{turn.commitSubject && <span className={styles.gitChangeSubject}>{turn.commitSubject}</span>}
			<span className={styles.gitChangeAnchor}>{ANCHOR_LABEL[turn.anchor]}</span>
			{ts && <span className={styles.msgTime}>{ts}</span>}
		</div>
	);
});

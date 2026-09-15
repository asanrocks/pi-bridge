// GitChangeCard — ADR 10 v2 mid-run git change, rendered as its own slim
// card inside the action group's spine, after the step it follows (e.g.
// after the committing tool's band). Muted band styling like an action step
// (left strip + faint tint) but no family hue — git is meta, not a tool
// action. Collapsed groups surface the same change in the header's
// "git: <hash>" summary segment.

import { memo } from "react";
import type { GitChangeMark } from "../../../../src/viewmodel/index.ts";
import styles from "./conversation.module.css";
import { formatGitIdentity } from "./format.ts";

export const GitChangeCard = memo(function GitChangeCard({ change }: { change: GitChangeMark }) {
	const identity = formatGitIdentity(change.identity);
	return (
		<div className={styles.gitChangeCard} data-turn-key={change.entryId} data-entry-id={change.entryId}>
			<span className={styles.gitChangeCardLabel}>{change.isInitial ? "git state" : "git"}</span>
			{identity && <span className={styles.gitChangeCardIdentity}>{identity}</span>}
			{change.commitSubject && (
				<span className={styles.gitChangeCardSubject} title={change.commitSubject}>
					{change.commitSubject}
				</span>
			)}
		</div>
	);
});

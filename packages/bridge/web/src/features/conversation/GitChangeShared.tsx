// GitChangeShared — the git change card shared by both ADR 10 v2 placements:
// the inline git stamp (inside the action group's vertical line, after the action it
// follows) and the standalone boundary card. Same skeleton as the tool cards
// (read tool / user bash): a tinted .action tinted row in the git hue,
// a .actionCollapsed row whose summary is the commit subject with the branch +
// short hash docked right, and an expanded .detailsCard whose .cardHeader
// restores the full truth (full hash, anchor, timestamp) above the
// on-demand `git show --stat` content region.

import { memo } from "react";
import type { GitIdentity, GitStampAnchor } from "../../../../src/core/index.ts";
import { gitBaseRpc } from "../../infra/net/useRpc.ts";
import { useStore } from "../../infra/state/store.tsx";
import { projectCwdOf } from "../../infra/state/ui.ts";
import styles from "./actions.module.css";
import turnStyles from "./turns.module.css";
import type { GitShowState } from "./useGitShow.ts";
import { useGitShow } from "./useGitShow.ts";

/** The fields both stamp renderings (GitChangeTurn, InlineGitStamp) share. */
export interface GitChangeFields {
	entryId: string;
	timestamp: string;
	identity: GitIdentity;
	commitSubject: string | null;
	anchor: GitStampAnchor;
	isInitial: boolean;
}

const ANCHOR_LABEL: Record<GitStampAnchor, string> = {
	prompt: "at prompt",
	tool_end: "after tool",
	turn_end: "after turn",
	user_bash_end: "after command",
};

/** Right-docked meta: "main @ a1b2c3d", "a1b2c3d" (detached), "main"
 * (unborn), "" (nothing known). */
export function formatGitMeta(identity: GitIdentity): string {
	const hash = identity.commit ? identity.commit.slice(0, 8) : null;
	if (identity.branch && hash) return `${identity.branch} @ ${hash}`;
	if (identity.branch) return identity.branch;
	return hash ?? "";
}

/** The tinted row. A collapsible .action when the change has a resolvable
 * commit (expansion fetches `git show --stat`), a static head otherwise
 * (unborn/unknown identities carry nothing to fetch). */
export const GitChangeRow = memo(function GitChangeRow({ change }: { change: GitChangeFields }) {
	const openBrowser = useStore((s) => s.openBrowser);
	// The commit review is scoped to the Project's repository; without a cwd
	// there is no absolute directory to resolve the commit against.
	const cwd = useStore(projectCwdOf);
	const { commit, branch } = change.identity;
	const expandable = commit !== null;
	const { expanded, toggle, state } = useGitShow(expandable ? commit : null);
	// Review this commit against its first parent (ADR 14, the ADR 10 commit
	// card's entry point). The base is resolved host-side — a root commit
	// resolves to the repository's empty tree — and the result opens the
	// browser with the commit as the content state.
	const reviewCommit = () => {
		if (commit === null || cwd === null) return;
		void gitBaseRpc(cwd, commit).then((baseline) => {
			if (baseline === null) return;
			openBrowser({ root: cwd, state: commit, baseline, tree: "changed", presentation: "review", origin: "commit" });
		});
	};
	// Collapsed primary text: the subject; fall back for subject-less stamps
	// (v1) to the branch, or "git state" for a bare initial recording.
	const summary = change.commitSubject ?? branch ?? "git state";
	const meta = formatGitMeta(change.identity);
	// Header line — the full truth the tinted row abbreviates (full hash, anchor,
	// timestamp), the same role the read tool's header line plays.
	const headerLine = [
		change.isInitial ? "initial git state" : "git state observed",
		ANCHOR_LABEL[change.anchor],
		commit ?? "no commit",
		change.timestamp,
	]
		.filter(Boolean)
		.join(" · ");

	const metaSpan = meta ? <span className={turnStyles.gitActionMeta}>{meta}</span> : null;

	return (
		<div className={styles.action} data-kind="git" data-turn-key={change.entryId} data-entry-id={change.entryId}>
			<div className={expandable ? styles.actionHead : `${styles.actionHead} ${styles.actionHeadStatic}`}>
				{expandable ? (
					<button
						type="button"
						className={styles.actionCollapsed}
						onClick={toggle}
						aria-expanded={expanded}
						aria-label={`${expanded ? "Collapse" : "Expand"} git change: ${summary}`}
						title={headerLine}
					>
						<span className={styles.collapseTri}>{expanded ? "\u25BE" : "\u25B8"}</span>
						<span className={styles.actionSummary}>{summary}</span>
						{metaSpan}
					</button>
				) : (
					<span className={styles.actionCollapsed} title={headerLine}>
						<span className={styles.collapseTri} />
						<span className={styles.actionSummary}>{summary}</span>
						{metaSpan}
					</span>
				)}
				{/* Sibling of the expand button, not a child: a nested button is
				    invalid markup and one click would both open a view and toggle the
				    card. The card's one meaning is the commit itself (vs its first
				    parent); the turn's transition windows live on the turn chip's
				    menu, so there is no second `diff` affordance here. */}
				{commit !== null && cwd !== null && (
					<button
						type="button"
						className={turnStyles.gitDiffAction}
						onClick={reviewCommit}
						aria-label="Review this commit"
						title="Review this commit against its first parent"
					>
						review
					</button>
				)}
			</div>
			{expanded && (
				<div className={styles.detailsCard}>
					<div className={styles.cardHeader}>{headerLine}</div>
					<GitShowBody state={state} />
				</div>
			)}
		</div>
	);
});

/** The expanded content region: `git show --stat` output in the shared mono
 * block, or a graceful failure line (unreachable commit / no server). */
export const GitShowBody = memo(function GitShowBody({ state }: { state: GitShowState }) {
	if (state.status === "loading") {
		return (
			<div className={styles.actionDetailsWrap}>
				<div className={`${styles.actionDetails} ${turnStyles.gitShowNote}`}>Loading…</div>
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<div className={styles.actionDetailsWrap}>
				<div className={`${styles.actionDetails} ${turnStyles.gitShowNote}`}>
					Commit not available — it may no longer be reachable from the current repository.
				</div>
			</div>
		);
	}
	if (state.status === "ok") {
		return (
			<div className={styles.actionDetailsWrap}>
				<div className={styles.actionDetails}>
					<pre className={styles.cardOutput}>{state.output}</pre>
					{state.truncated && <div className={turnStyles.gitShowNote}>Output truncated.</div>}
				</div>
			</div>
		);
	}
	return null;
});

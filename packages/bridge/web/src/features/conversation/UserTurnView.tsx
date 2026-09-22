// UserTurnView — full-width tinted row (a distinct part of the document,
// not a bubble). The first line is the turn header (timestamp then You,
// left) with the hover-revealed toolbar (Copy / variant pager / Edit)
// right-aligned on the same line. Top-anchoring keeps the toolbar stable
// when branch content height differs. Glyph-only buttons carry aria-label
// + title for a11y and discoverability.

import { type MutableRefObject, memo, useCallback, useRef, useState } from "react";
import type { Entry } from "../../../../src/core/index.ts";
import { newestLeafInSubtree, type UserTurn } from "../../../../src/viewmodel/index.ts";
import { formatTimestamp } from "../../infra/lib/time.ts";
import { useStore } from "../../infra/state/store.tsx";
import { AnchoredMenu, type MenuItem } from "../../render/AnchoredMenu.tsx";
import { CheckIcon, CopyIcon } from "../../render/icons.tsx";
import { ResultImages } from "../../render/ResultImages.tsx";
import { AppMarkdown } from "../viewer/AppMarkdown.tsx";
import { copyToClipboard } from "./clipboard.ts";
import { formatDuration, formatGitIdentity } from "./format.ts";
import styles from "./turns.module.css";

/** Abbreviated commit id for a menu detail line. */
function shortOid(oid: string): string {
	return oid.slice(0, 8);
}

export const UserTurnView = memo(function UserTurnView({
	turn,
	entriesRef,
	onNavigate,
	onEdit,
	isLiveTail,
}: {
	turn: UserTurn;
	entriesRef: MutableRefObject<Record<string, Entry>>;
	onNavigate: (entryId: string) => void;
	onEdit: (entryId: string, index: number, text: string) => void;
	/** The last user turn on the live path — the only turn whose send state
	 * can be honestly compared against the current worktree. False on a peeked
	 * path or for any earlier turn. */
	isLiveTail: boolean;
}) {
	const isDimmed = useStore(useCallback((s) => s.draft.kind === "edit" && turn.index >= s.draft.index, [turn.index]));
	const isEditing = useStore(
		useCallback((s) => s.draft.kind === "edit" && s.draft.entryId === turn.entryId, [turn.entryId]),
	);
	const isFocused = useStore(useCallback((s) => s.focusedTurnId === turn.entryId, [turn.entryId]));
	const openDiffView = useStore((s) => s.openDiffView);
	const [copied, setCopied] = useState(false);

	const hasSiblings = turn.siblings && turn.siblings.length > 1;
	const ts = formatTimestamp(turn.timestamp);
	const thoughtFor = formatDuration(turn.thoughtForMs);
	const gitStamp = turn.gitIdentity ? formatGitIdentity(turn.gitIdentity) : "";
	const baseline = turn.gitIdentity?.commit ?? null;
	const transitions = turn.gitTransitions;
	const gitButtonRef = useRef<HTMLButtonElement>(null);
	const [gitMenu, setGitMenu] = useState<DOMRect | null>(null);

	// The chip's menu names every reviewable pair explicitly: the turn's
	// observed commits (or one union window), plus the live tail's comparison
	// against the current worktree. No open-ended "next commit" window is
	// inferred, so the menu never claims turn-scoped changes git cannot know.
	const gitMenuItems = useCallback((): MenuItem[] => {
		const items: MenuItem[] = [];
		const first = transitions[0];
		const last = transitions[transitions.length - 1];
		if (first && last && transitions.length > 1) {
			items.push({
				key: "all",
				label: `Review all ${transitions.length} commits`,
				detail: `${shortOid(first.old)} → ${shortOid(last.new)}`,
				onSelect: () => openDiffView({ old: first.old, new: last.new }, turn.text),
			});
		}
		for (const t of transitions) {
			items.push({
				key: t.entryId,
				label: t.subject ?? `Review ${shortOid(t.new)}`,
				detail: `${shortOid(t.old)} → ${shortOid(t.new)}`,
				onSelect: () => openDiffView({ old: t.old, new: t.new }, t.subject ?? turn.text),
			});
		}
		if (isLiveTail && baseline !== null) {
			items.push({
				key: "worktree",
				label: "Compare with the current worktree",
				detail: `${shortOid(baseline)} → working tree`,
				onSelect: () => openDiffView({ old: baseline, new: "worktree" }, turn.text),
			});
		}
		return items;
	}, [transitions, isLiveTail, turn.text, baseline, openDiffView]);

	const canReviewGit = transitions.length > 0 || (isLiveTail && baseline !== null);

	const handleCopy = useCallback(async () => {
		if (await copyToClipboard(turn.text)) {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		}
	}, [turn.text]);

	return (
		<div
			className={`${styles.userMsg} ${isDimmed ? styles.msgDimmed : ""} ${isFocused ? styles.focused : ""} ${isEditing ? styles.userMsgEditing : ""}`}
			data-turn-key={turn.entryId}
			data-entry-id={turn.entryId}
		>
			<div className={styles.msgHeader}>
				<span className={styles.msgHeaderLeft}>
					{ts && <span className={styles.msgTime}>{ts}</span>}
					<span className={styles.msgRole}>You</span>
					{thoughtFor && <span className={styles.msgTiming}>{thoughtFor}</span>}
					{gitStamp &&
						(canReviewGit ? (
							<>
								<button
									ref={gitButtonRef}
									type="button"
									className={`${styles.gitStamp} ${styles.gitStampBtn}`}
									title={`Review changes — ${turn.gitCommitSubject ?? "state at send"}`}
									aria-label="Review repository changes for this turn"
									aria-haspopup="menu"
									aria-expanded={gitMenu !== null}
									onClick={() => setGitMenu(gitButtonRef.current?.getBoundingClientRect() ?? null)}
								>
									{gitStamp}
								</button>
								{gitMenu && (
									<AnchoredMenu
										anchor={gitMenu}
										items={gitMenuItems()}
										onClose={() => setGitMenu(null)}
										label="Review changes"
									/>
								)}
							</>
						) : (
							<span className={styles.gitStamp} title={turn.gitCommitSubject ?? undefined}>
								{gitStamp}
							</span>
						))}
					{isEditing && <span className={styles.editingBadge}>Editing</span>}
				</span>
				<div className={styles.turnToolbar}>
					<button
						type="button"
						className={styles.toolbarBtn}
						onClick={handleCopy}
						aria-label={copied ? "Copied" : "Copy message"}
						title="Copy message"
					>
						{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
					</button>
					{hasSiblings && (
						<div className={styles.userMsgPager}>
							<button
								type="button"
								aria-label="Previous branch"
								disabled={turn.currentSiblingIndex === 0}
								onClick={() => {
									const prev = turn.siblings![turn.currentSiblingIndex! - 1];
									if (prev) onNavigate(newestLeafInSubtree(prev, entriesRef.current));
								}}
							>
								◀
							</button>
							<span>
								{turn.currentSiblingIndex! + 1} / {turn.siblings!.length}
							</span>
							<button
								type="button"
								aria-label="Next branch"
								disabled={turn.currentSiblingIndex === turn.siblings!.length - 1}
								onClick={() => {
									const next = turn.siblings![turn.currentSiblingIndex! + 1];
									if (next) onNavigate(newestLeafInSubtree(next, entriesRef.current));
								}}
							>
								▶
							</button>
						</div>
					)}
					<button
						type="button"
						className={styles.toolbarBtn}
						onClick={() => onEdit(turn.entryId, turn.index, turn.text)}
						aria-label="Edit message"
						title="Edit message"
					>
						✎
					</button>
				</div>
			</div>
			<div className={`${styles.userMsgText} ${styles.markdownContent}`}>
				<AppMarkdown text={turn.text} mode="static" />
			</div>
			{turn.images.length > 0 && <ResultImages images={turn.images} />}
		</div>
	);
});

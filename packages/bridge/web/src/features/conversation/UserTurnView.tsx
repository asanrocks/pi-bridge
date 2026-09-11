// UserTurnView — full-width tinted band (a distinct part of the document,
// not a bubble). The first line is the turn header (timestamp then You,
// left) with the hover-revealed toolbar (Copy / variant pager / Edit)
// right-aligned on the same line. Top-anchoring keeps the toolbar stable
// when branch content height differs. Glyph-only buttons carry aria-label
// + title for a11y and discoverability.

import { type MutableRefObject, memo, useCallback, useState } from "react";
import type { Entry } from "../../../../src/core/index.ts";
import { newestLeafInSubtree, type UserTurn } from "../../../../src/viewmodel/index.ts";
import { useStore } from "../../infra/store.tsx";
import { CheckIcon, CopyIcon } from "../../render/icons.tsx";
import { Markdown } from "../../render/markdown.tsx";
import { ResultImages } from "../../render/ResultImages.tsx";
import { copyToClipboard } from "./clipboard.ts";
import styles from "./conversation.module.css";
import { formatDuration, formatTimestamp } from "./format.ts";

export const UserTurnView = memo(function UserTurnView({
	turn,
	entriesRef,
	onNavigate,
	onEdit,
}: {
	turn: UserTurn;
	entriesRef: MutableRefObject<Record<string, Entry>>;
	onNavigate: (entryId: string) => void;
	onEdit: (entryId: string, index: number, text: string) => void;
}) {
	const isDimmed = useStore(useCallback((s) => s.draft.kind === "edit" && turn.index >= s.draft.index, [turn.index]));
	const isEditing = useStore(
		useCallback((s) => s.draft.kind === "edit" && s.draft.entryId === turn.entryId, [turn.entryId]),
	);
	const isFocused = useStore(useCallback((s) => s.focusedTurnId === turn.entryId, [turn.entryId]));
	const [copied, setCopied] = useState(false);

	const hasSiblings = turn.siblings && turn.siblings.length > 1;
	const ts = formatTimestamp(turn.timestamp);
	const thoughtFor = formatDuration(turn.thoughtForMs);

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
				<Markdown text={turn.text} mode="static" />
			</div>
			{turn.images.length > 0 && <ResultImages images={turn.images} />}
		</div>
	);
});

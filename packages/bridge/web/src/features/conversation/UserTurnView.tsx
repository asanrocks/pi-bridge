// UserTurnView — full-width tinted row (a distinct part of the document,
// not a bubble). The header is the shared compact layout (ADR 21): date
// disclosure, an existing label, the controls the column affords, and the
// overflow menu. The tinted row carries the role, so no "You" verb is needed;
// the git identity and the deliberation interval are details now, and the
// repository review items are menu commands.

import { type MutableRefObject, memo, useCallback, useMemo, useState } from "react";
import type { Entry } from "../../../../src/core/index.ts";
import { newestLeafInSubtree, type UserTurn } from "../../../../src/viewmodel/index.ts";
import { copyToClipboard } from "../../infra/lib/clipboard.ts";
import { useStore } from "../../infra/state/store.tsx";
import type { MenuItem } from "../../render/AnchoredMenu.tsx";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon, PencilIcon } from "../../render/icons.tsx";
import { ResultImages } from "../../render/ResultImages.tsx";
import { AppMarkdown } from "../viewer/AppMarkdown.tsx";
import { type HeaderDensity, inlineControls } from "./headerDensity.ts";
import { TurnHeader } from "./TurnHeader.tsx";
import { userTurnDetails } from "./turnDetails.ts";
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
	density,
}: {
	turn: UserTurn;
	entriesRef: MutableRefObject<Record<string, Entry>>;
	onNavigate: (entryId: string) => void;
	onEdit: (entryId: string, index: number, text: string) => void;
	/** The last user turn on the live path — the only turn whose send state
	 * can be honestly compared against the current worktree. False on a peeked
	 * path or for any earlier turn. */
	isLiveTail: boolean;
	/** The measured conversation column's header tier (ADR 21). */
	density: HeaderDensity;
}) {
	const isDimmed = useStore(useCallback((s) => s.draft.kind === "edit" && turn.index >= s.draft.index, [turn.index]));
	const isEditing = useStore(
		useCallback((s) => s.draft.kind === "edit" && s.draft.entryId === turn.entryId, [turn.entryId]),
	);
	const isFocused = useStore(useCallback((s) => s.focusedTurnId === turn.entryId, [turn.entryId]));
	const openDiffView = useStore((s) => s.openDiffView);
	const [copied, setCopied] = useState(false);

	const hasSiblings = turn.siblings && turn.siblings.length > 1;
	const inline = useMemo(() => inlineControls(density), [density]);
	const baseline = turn.gitIdentity?.commit ?? null;
	const transitions = turn.gitTransitions;

	// The date's disclosure: when the turn was sent, how long the conversation
	// had been idle before it, and the repository state the send was recorded
	// against. Two sections, because a user message records no model to open with.
	const details = useMemo(
		() =>
			userTurnDetails({
				timestamp: turn.timestamp,
				thoughtForMs: turn.thoughtForMs,
				gitIdentity: turn.gitIdentity,
				gitCommitSubject: turn.gitCommitSubject,
			}),
		[turn.timestamp, turn.thoughtForMs, turn.gitIdentity, turn.gitCommitSubject],
	);

	// The reviewable pairs stay explicit: the turn's observed commits (or one
	// union window), plus the live tail's comparison against the current
	// worktree. No open-ended "next commit" window is inferred, so the menu
	// never claims turn-scoped changes git cannot know.
	const gitItems = useMemo<MenuItem[]>(() => {
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

	const handleCopy = useCallback(async () => {
		if (await copyToClipboard(turn.text)) {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		}
	}, [turn.text]);

	// Every command, minus the ones the header is currently showing: the two
	// surfaces are derived from the same tier, so a command has exactly one
	// owner. The menu orders by likely use, not by the row's spatial order — a
	// list reads top-down, so the header's arrangement (where the optional pager
	// must take the leading slot to leave the fixed controls alone) would bury
	// Copy under `Previous branch`. Pager entries appear only in the direction
	// that can be taken.
	const menuItems = useMemo<MenuItem[]>(() => {
		const items: MenuItem[] = [];
		if (!inline.copy) items.push({ key: "copy", label: "Copy message", onSelect: () => void handleCopy() });
		if (!inline.edit) {
			items.push({
				key: "edit",
				label: "Edit message",
				onSelect: () => onEdit(turn.entryId, turn.index, turn.text),
			});
		}
		const siblings = turn.siblings;
		const position = turn.currentSiblingIndex ?? 0;
		if (!inline.pager && siblings && siblings.length > 1) {
			const readout = `${position + 1} / ${siblings.length}`;
			const previous = siblings[position - 1];
			if (previous) {
				items.push({
					key: "previous",
					label: "Previous branch",
					detail: readout,
					onSelect: () => onNavigate(newestLeafInSubtree(previous, entriesRef.current)),
				});
			}
			const next = siblings[position + 1];
			if (next) {
				items.push({
					key: "next",
					label: "Next branch",
					detail: readout,
					onSelect: () => onNavigate(newestLeafInSubtree(next, entriesRef.current)),
				});
			}
		}
		return [...items, ...gitItems];
	}, [
		inline,
		turn.siblings,
		turn.currentSiblingIndex,
		turn.entryId,
		turn.index,
		turn.text,
		handleCopy,
		onNavigate,
		onEdit,
		entriesRef,
		gitItems,
	]);

	// Row order is a consequence of right alignment: an item's distance from the
	// right edge depends only on the items to its right, so the optional pager
	// takes the leading slot and Copy/Edit/More keep their positions when a turn
	// gains a branch. Within the fixed run, the order is descending frequency
	// (Copy, then Edit) with the overflow last.
	const showControls = inline.copy || inline.edit || (inline.pager && hasSiblings);
	const controls = showControls ? (
		<>
			{inline.pager && hasSiblings && (
				<div className={styles.userMsgPager}>
					<button
						type="button"
						className={styles.pagerBtn}
						aria-label="Previous branch"
						disabled={turn.currentSiblingIndex === 0}
						onClick={() => {
							const prev = turn.siblings![turn.currentSiblingIndex! - 1];
							if (prev) onNavigate(newestLeafInSubtree(prev, entriesRef.current));
						}}
					>
						<ChevronLeftIcon size={14} />
					</button>
					<span>
						{turn.currentSiblingIndex! + 1} / {turn.siblings!.length}
					</span>
					<button
						type="button"
						className={styles.pagerBtn}
						aria-label="Next branch"
						disabled={turn.currentSiblingIndex === turn.siblings!.length - 1}
						onClick={() => {
							const next = turn.siblings![turn.currentSiblingIndex! + 1];
							if (next) onNavigate(newestLeafInSubtree(next, entriesRef.current));
						}}
					>
						<ChevronRightIcon size={14} />
					</button>
				</div>
			)}
			{inline.copy && (
				<button
					type="button"
					className={styles.toolbarBtn}
					onClick={handleCopy}
					aria-label={copied ? "Copied" : "Copy message"}
					title="Copy message"
				>
					{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
				</button>
			)}
			{inline.edit && (
				<button
					type="button"
					className={styles.toolbarBtn}
					onClick={() => onEdit(turn.entryId, turn.index, turn.text)}
					aria-label="Edit message"
					title="Edit message"
				>
					<PencilIcon size={14} />
				</button>
			)}
		</>
	) : undefined;

	return (
		<article
			className={`${styles.userMsg} ${isDimmed ? styles.msgDimmed : ""} ${isFocused ? styles.focused : ""} ${isEditing ? styles.userMsgEditing : ""}`}
			data-turn-key={turn.entryId}
			data-entry-id={turn.entryId}
			// A message is a self-contained composition, and the visible "You"
			// verb is gone: the name is what keeps the role distinction available
			// to assistive tech.
			aria-label="User message"
		>
			<TurnHeader
				timestamp={turn.timestamp}
				density={density}
				details={details}
				label={{ entryId: turn.entryId, label: turn.label }}
				// A state indicator, not a command: the commands fade in on hover, the
				// editing mark must not.
				badge={isEditing ? <span className={styles.editingBadge}>Editing</span> : undefined}
				controls={controls}
				menuItems={menuItems}
				menuLabel="Turn actions"
			/>
			<div className={`${styles.userMsgText} ${styles.markdownContent}`}>
				<AppMarkdown text={turn.text} mode="static" />
			</div>
			{turn.images.length > 0 && <ResultImages images={turn.images} />}
		</article>
	);
});

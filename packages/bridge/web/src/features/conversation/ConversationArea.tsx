// ============================================================================
// ConversationArea — renders the turn list via ViewModel projection.
// Turn-based dispatch: UserTurn, AssistantTurn (flat blocks), SystemTurn.
// Consecutive actions share a vertical line; grouping is renderer-owned
// (segmentBlocks) — the ViewModel has no group entity. All scroll behavior
// (at-bottom detection, auto-scroll, anchors, keyboard focus) lives in
// useViewportTracking.
// ============================================================================

import { memo, useEffect, useRef } from "react";
import type { ViewModel } from "../../../../src/viewmodel/index.ts";
import { getStore, useStore } from "../../infra/state/store.tsx";
import { selectRenderDiverged } from "../../infra/state/ui.ts";
import { ChevronDownIcon } from "../../render/icons.tsx";
import { AssistantTurnView } from "./AssistantTurnView.tsx";
import styles from "./conversation.module.css";
import { GitChangeView } from "./GitChangeView.tsx";
import { SystemTurnView } from "./SystemTurnView.tsx";
import { UserBashView } from "./UserBashView.tsx";
import { UserTurnView } from "./UserTurnView.tsx";
import { useViewportTracking } from "./useViewportTracking.ts";

interface ConversationAreaProps {
	vm: ViewModel;
	isStreaming: boolean;
	/** Branch-target selection (useBranchSelect matrix): navigate when idle
	 * and live, read-only rendering-leaf re-target while busy or peeking. */
	onSelectBranch: (entryId: string) => void;
	onEdit: (entryId: string, index: number, text: string) => void;
}

export const ConversationArea = memo(function ConversationArea({
	vm,
	isStreaming,
	onSelectBranch,
	onEdit,
}: ConversationAreaProps) {
	// Expand/collapse toggles are pure store actions — read here instead of
	// threaded from the shell.
	const onToggleGroup = useStore((s) => s.toggleActionGroup);
	const onToggleAction = useStore((s) => s.toggleAction);
	// Peek state: when the rendering leaf is pinned away from the live leaf,
	// the viewport tracking pauses follow and the jump button becomes the
	// return-to-live gesture.
	const isDiverged = useStore(selectRenderDiverged);
	// Column element observed by the geometry anchor (§1 in the hook): its
	// width is the rewrap driver — a width change is what needs a restore.
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const { awayFromBottom, newContentBelow, jumpToBottom, goLive } = useViewportTracking(
		vm,
		isStreaming,
		isDiverged,
		scrollContainerRef,
	);

	// entriesRef for the sibling pager — updated via Zustand subscribe
	// (not useStore) to avoid re-rendering ConversationArea on every
	// streaming patch. ADR 07 invariant 3a: only the streaming text block
	// re-renders on append.
	const entriesRef = useRef(getStore().getState().document.entries);
	useEffect(
		() =>
			getStore().subscribe((state) => {
				entriesRef.current = state.document.entries;
			}),
		[],
	);

	if (vm.turns.length === 0) {
		return (
			<div className={styles.scrollContainer} ref={scrollContainerRef}>
				<div className={styles.empty}>No messages yet. Send a prompt to begin.</div>
			</div>
		);
	}

	const lastTurn = vm.turns[vm.turns.length - 1];

	return (
		<div className={styles.scrollContainer} ref={scrollContainerRef}>
			{vm.turns.map((turn) => {
				switch (turn.kind) {
					case "user":
						return (
							<UserTurnView
								key={turn.entryId}
								turn={turn}
								entriesRef={entriesRef}
								onNavigate={onSelectBranch}
								onEdit={onEdit}
							/>
						);
					case "assistant":
						return (
							<AssistantTurnView
								// turnKey — not entryId: a split entry produces two turns
								// that share the first entry's id (message turn + trailing-tool turn).
								key={turn.turnKey}
								turn={turn}
								isStreaming={isStreaming && turn === lastTurn}
								onToggleGroup={onToggleGroup}
								onToggleAction={onToggleAction}
							/>
						);
					case "system":
						return <SystemTurnView key={turn.entryId} turn={turn} />;
					case "userBash":
						return <UserBashView key={turn.entryId} turn={turn} />;
					case "gitChange":
						return <GitChangeView key={turn.entryId} turn={turn} />;
					default:
						return null;
				}
			})}
			{/* Always mounted — visibility animates (opacity/translate) rather than
			    a hard mount/unmount. data-visible drives the transition; the hidden
			    state is inert (visibility + pointer-events) and untabbable. */}
			<button
				type="button"
				className={styles.jumpToBottom}
				onClick={isDiverged ? goLive : jumpToBottom}
				data-visible={awayFromBottom || isDiverged ? "true" : "false"}
				data-new={newContentBelow ? "true" : "false"}
				tabIndex={awayFromBottom || isDiverged ? 0 : -1}
				aria-hidden={!awayFromBottom && !isDiverged}
				aria-label={isDiverged ? "Back to live" : newContentBelow ? "Jump to new messages" : "Jump to bottom"}
				title={
					isDiverged
						? "Back to live (following the current branch again)"
						: newContentBelow
							? "Jump to new messages"
							: "Jump to bottom"
				}
			>
				<ChevronDownIcon size={16} />
				<span className={styles.jumpDot} aria-hidden="true" />
			</button>
		</div>
	);
});

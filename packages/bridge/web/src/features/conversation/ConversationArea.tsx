// ============================================================================
// ConversationArea — renders the turn list via ViewModel projection.
// Turn-based dispatch: UserTurn, AssistantTurn (flat blocks), SystemTurn.
// Consecutive steps share a visual spine; grouping is renderer-owned
// (segmentBlocks) — the ViewModel has no group entity. All scroll behavior
// (at-bottom detection, auto-scroll, anchors, keyboard focus) lives in
// useViewportTracking.
// ============================================================================

import { memo, useEffect, useRef } from "react";
import type { ViewModel } from "../../../../src/viewmodel/index.ts";
import { getStore, useStore } from "../../infra/state/store.tsx";
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
	onNavigate: (entryId: string) => void;
	onEdit: (entryId: string, index: number, text: string) => void;
}

export const ConversationArea = memo(function ConversationArea({
	vm,
	isStreaming,
	onNavigate,
	onEdit,
}: ConversationAreaProps) {
	// Expand/fold toggles are pure store actions — read here instead of
	// threaded from the shell.
	const onToggleGroup = useStore((s) => s.toggleActionGroup);
	const onToggleStep = useStore((s) => s.toggleStep);
	const { awayFromBottom, newContentBelow, jumpToBottom } = useViewportTracking(vm, isStreaming);

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
			<div className={styles.scrollContainer}>
				<div className={styles.empty}>No messages yet. Send a prompt to begin.</div>
			</div>
		);
	}

	const lastTurn = vm.turns[vm.turns.length - 1];

	return (
		<div className={styles.scrollContainer}>
			{vm.turns.map((turn) => {
				switch (turn.kind) {
					case "user":
						return (
							<UserTurnView
								key={turn.entryId}
								turn={turn}
								entriesRef={entriesRef}
								onNavigate={onNavigate}
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
								onToggleStep={onToggleStep}
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
				onClick={jumpToBottom}
				data-visible={awayFromBottom ? "true" : "false"}
				data-new={newContentBelow ? "true" : "false"}
				tabIndex={awayFromBottom ? 0 : -1}
				aria-hidden={!awayFromBottom}
				aria-label={newContentBelow ? "Jump to new messages" : "Jump to bottom"}
				title={newContentBelow ? "Jump to new messages" : "Jump to bottom"}
			>
				<ChevronDownIcon size={16} />
				<span className={styles.jumpDot} aria-hidden="true" />
			</button>
		</div>
	);
});

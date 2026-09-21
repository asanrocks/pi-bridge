// ============================================================================
// useKeyboardRing — constructs the full AppKeyHandlers set (the j/k/g/G/e/y/
// h/l ring, Alt combos, chrome toggles) fed into useAppKeybindings. Kept
// beside the dispatch table (keybindings.ts); its inputs are app-level
// (vm, rpc, store, shell triggers), not conversation-internal.
//
// Handlers read fresh store state at event time (getStore().getState()) and
// the latest `vm` (useAppKeybindings ref-stores the handlers, so the document
// listener is attached once while always dispatching against current
// closures). Turn navigation keys on turnKey, never entryId — see
// nextFocusedTurnKey (viewmodel) for the contract.
// ============================================================================

import { useCallback } from "react";
import type { TurnVM, ViewModel } from "../../../src/viewmodel/index.ts";
import { newestLeafInSubtree, nextFocusedTurnKey, segmentBlocks, turnKeyOf } from "../../../src/viewmodel/index.ts";
import { copyToClipboard } from "../features/conversation/clipboard.ts";
import { getStore } from "../infra/state/store.tsx";
import type { AppKeyHandlers } from "./keybindings.ts";

export interface KeyboardRingDeps {
	vm: ViewModel;
	/** Shared with ComposeDock (its Ctrl+P / cycle button) — owned by App. */
	onCycleModel: (direction: "forward" | "backward") => void;
	onOpenSession: (projectId: string, stem: string, sessionId?: string) => void;
	onOpenProject: (projectId: string) => void;
	/** Begin edit mode for a past user message (useComposerCommit). */
	beginEdit: (entryId: string, index: number, text: string) => void;
	/** Branch-target selection (useBranchSelect matrix): navigate when idle
	 * and live, read-only peek re-target while busy or diverged. */
	navigate: (entryId: string) => void;
	sidebarToggle: () => void;
	/** Open the sidebar's new-session surface (Alt+N with >1 Project). */
	newSession: () => void;
	/** Toggle the history pane (Ctrl/Cmd+H) — its shell hook's imperative
	 *  handle, same pattern as sidebarToggle. */
	historyToggle: () => void;
}

export function useKeyboardRing(deps: KeyboardRingDeps): AppKeyHandlers {
	const {
		vm,
		beginEdit,
		navigate,
		onCycleModel,
		onOpenSession,
		onOpenProject,
		sidebarToggle,
		newSession,
		historyToggle,
	} = deps;

	const onExpandComposer = useCallback(() => {
		const s = getStore().getState();
		// Expanding to type is always safe — sending (a steer) is allowed while
		// streaming, so blocking the expand was an inconsistency, not a lock.
		if (s.connection.kind !== "connected") return;
		if (!s.composerExpanded) s.setComposerExpanded(true);
	}, []);

	const onNavigateTurn = useCallback(
		(direction: "prev" | "next") => {
			const s = getStore().getState();
			// Skip system dividers — they aren't content to read or act on.
			const nav = vm.turns.filter((t) => t.kind === "user" || t.kind === "assistant");
			const key = nextFocusedTurnKey(vm.turns, s.focusedTurnId, direction, () => findTurnNearestCenter(nav));
			if (key !== null) s.setFocusedTurnId(key);
		},
		[vm],
	);

	const onJumpTurn = useCallback(
		(edge: "first" | "last") => {
			// Skip system dividers — they aren't content to read or act on.
			const nav = vm.turns.filter((t) => t.kind === "user" || t.kind === "assistant");
			if (nav.length === 0) return;
			const target = edge === "first" ? nav[0] : nav[nav.length - 1];
			getStore().getState().setFocusedTurnId(turnKeyOf(target));
		},
		[vm],
	);

	const onToggleFocusedGroup = useCallback(() => {
		const s = getStore().getState();
		const id = s.focusedTurnId;
		if (!id) return;
		const turn = vm.turns.find((t) => turnKeyOf(t) === id && t.kind === "assistant");
		if (!turn || turn.kind !== "assistant") return;
		const firstGroup = segmentBlocks(turn.blocks).find((seg) => seg.kind === "group");
		if (!firstGroup || firstGroup.kind !== "group") return;
		const cardKeys = firstGroup.actions.map((h) => `${h.entryId}:b${h.blockIndex}`);
		s.toggleActionGroup(firstGroup.key, cardKeys);
	}, [vm]);

	const onEditFocused = useCallback(() => {
		const s = getStore().getState();
		const id = s.focusedTurnId;
		if (!id) return;
		const turn = vm.turns.find((t) => turnKeyOf(t) === id && t.kind === "user");
		if (!turn || turn.kind !== "user") return;
		beginEdit(turn.entryId, turn.index, turn.text);
	}, [vm, beginEdit]);

	const onCopyFocused = useCallback(async () => {
		const s = getStore().getState();
		const id = s.focusedTurnId;
		if (!id) return;
		const turn = vm.turns.find((t) => turnKeyOf(t) === id);
		if (!turn) return;
		let text: string;
		if (turn.kind === "user") {
			text = turn.text;
		} else if (turn.kind === "assistant") {
			text = turn.blocks
				.filter((b) => b.blockType === "text")
				.map((b) => b.text)
				.join("\n\n");
		} else {
			return; // system — nothing to copy
		}
		await copyToClipboard(text);
	}, [vm]);

	const onBranchSibling = useCallback(
		(direction: "prev" | "next") => {
			const s = getStore().getState();
			const id = s.focusedTurnId;
			if (!id) return;
			const turn = vm.turns.find((t) => turnKeyOf(t) === id && t.kind === "user");
			if (!turn || turn.kind !== "user") return;
			const { siblings, currentSiblingIndex: idx } = turn;
			if (!siblings || siblings.length <= 1 || idx === undefined) return;
			const target = direction === "prev" ? siblings[idx - 1] : siblings[idx + 1];
			if (!target) return;
			const leafId = newestLeafInSubtree(target, s.document.entries);
			// Repoint focus to the target sibling so the ring follows the branch
			// across the async select (the old sibling leaves the rendered path
			// and would otherwise drop focus, breaking consecutive h/l). The
			// useBranchSelect matrix picks navigate (idle + live) or a read-only
			// peek re-target (busy / already peeking).
			s.setFocusedTurnId(target);
			navigate(leafId);
		},
		[vm, navigate],
	);

	// Alt+↑/↓ — cycle the active sessions (global snapshot, newest first —
	// the sidebar's pinned order). Cyclic; from the launcher (nothing
	// attached) both directions open the newest. Live mid-stream: switching is
	// an attach (ADR 11), not a retarget of the streaming instance.
	const onCycleActiveSession = useCallback(
		(direction: "prev" | "next") => {
			const s = getStore().getState();
			const list = s.activeSessions;
			if (list.length === 0) return;
			const idx = list.findIndex(
				(r) =>
					(r.projectId === s.currentProjectId && r.stem === s.currentStem) || r.sessionId === s.activeSessionId,
			);
			const len = list.length;
			const target = idx === -1 ? list[0] : list[direction === "next" ? (idx + 1) % len : (idx - 1 + len) % len];
			if (target.projectId === s.currentProjectId && target.stem === s.currentStem) return;
			onOpenSession(target.projectId, target.stem, target.sessionId);
		},
		[onOpenSession],
	);

	// Alt+N — new session. With one Project, go to its home (the prompt input
	// starts the session); with several, surface the sidebar's project list
	// rather than guess.
	const onNewSession = useCallback(() => {
		const s = getStore().getState();
		if (s.projects.length === 1) {
			onOpenProject(s.projects[0].id);
		} else if (s.projects.length > 1) {
			newSession();
		}
	}, [onOpenProject, newSession]);

	const onToggleSidebar = useCallback(() => sidebarToggle(), [sidebarToggle]);
	const onToggleHistory = useCallback(() => historyToggle(), [historyToggle]);

	return {
		onCycleModel,
		onExpandComposer,
		onNavigateTurn,
		onJumpTurn,
		onToggleFocusedGroup,
		onEditFocused,
		onCopyFocused,
		onBranchSibling,
		onCycleActiveSession,
		onNewSession,
		onToggleSidebar,
		onToggleHistory,
	};
}

// ---------------------------------------------------------------------------
// findTurnNearestCenter — when no turn is focused (or the focused entry is
// stale / off-path), j/k snap to the turn closest to the viewport's vertical
// center. Gmail-style: the first navigation after the page lands where your
// eye already is. Pure DOM read; returns the index into `turns`.
// ---------------------------------------------------------------------------

function findTurnNearestCenter(turns: TurnVM[]): number {
	let best = 0;
	let bestDist = Infinity;
	const viewCenter = window.innerHeight / 2;
	for (let i = 0; i < turns.length; i++) {
		const el = document.querySelector(`[data-turn-key="${CSS.escape(turnKeyOf(turns[i]))}"]`);
		if (!el) continue;
		const rect = el.getBoundingClientRect();
		if (rect.height === 0) continue;
		const center = rect.top + rect.height / 2;
		const dist = Math.abs(center - viewCenter);
		if (dist < bestDist) {
			bestDist = dist;
			best = i;
		}
	}
	return best;
}

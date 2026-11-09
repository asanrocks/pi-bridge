// ============================================================================
// App — root shell: TopBar, Sidebar, ConversationArea/ComposeDock (or the
// Launcher), HistoryPane, FileBrowser. The shell owns only chrome composition;
// per-area wiring lives with its area:
//   - useSidebarShell (sidebar)  — Sidebar props + the chrome handles
//                                  (mode, hamburger toggle, Alt+N)
//   - useHistoryPaneShell        — same pattern for the history pane
//                                  (mode, clock toggle, hover signal)
//   - ComposeDock / Launcher      — self-sufficient (store + useRpc); the
//                                  dock's one prop is the commit callback,
//                                  shared with the keyboard ring
//   - useViewModel (state)        — store→ViewModel projection + cache
//   - useComposerCommit (composer)— draft→wire commit/fork flow
//   - useModelCycling (composer)  — the Ctrl+P / picker model cycle
//   - useKeyboardRing (app)       — AppKeyHandlers over vm + store + rpc
// What stays here is genuinely shell-level: the status notification wiring,
// the branch-select matrix (useBranchSelect), the TopBar, and the
// launcher/conversation fork.
// ============================================================================

import { useCallback } from "react";
import type { SessionAddress } from "../../../src/core/index.ts";
import { liveActivityPhase } from "../../../src/viewmodel/index.ts";
import { ComposeDock } from "../features/composer/ComposeDock.tsx";
import { useComposerCommit } from "../features/composer/useComposerCommit.ts";
import { useModelCycling } from "../features/composer/useModelCycling.ts";
import { ConversationArea } from "../features/conversation/ConversationArea.tsx";
import { useHistoryPaneShell } from "../features/history/useHistoryPaneShell.tsx";
import { Launcher } from "../features/launcher/Launcher.tsx";
import { useSidebarShell } from "../features/sidebar/useSidebarShell.tsx";
import { TopBar } from "../features/topbar/TopBar.tsx";
import { topBarTitle } from "../features/topbar/topBarTitle.ts";
import { waitingBadgeCount, waitingNewCount as waitingNewCountOf } from "../features/topbar/waitingBadge.ts";
import { FileBrowser } from "../features/viewer/FileBrowser.tsx";
import { useConnection } from "../infra/net/useConnection.ts";
import { useBranchSelect, useRpc } from "../infra/net/useRpc.ts";
import { useServiceWorkerSessionOpen } from "../infra/net/useServiceWorkerSessionOpen.ts";
import { useDraftGuard } from "../infra/persist/draftPersistence.ts";
import { StoreProvider, useStore } from "../infra/state/store.tsx";
import { useViewModel } from "../infra/state/useViewModel.ts";
import styles from "./App.module.css";
import { useAppKeybindings } from "./keybindings.ts";
import { SecureContextHint } from "./SecureContextHint.tsx";
import { ToastBar } from "./ToastBar.tsx";
import { useAttentionNotifications } from "./useAttentionNotifications.ts";
import { useKeyboardRing } from "./useKeyboardRing.ts";
import { useStatusNotifications } from "./useStatusNotifications.ts";

// ---------------------------------------------------------------------------
// Root wrapper
// ---------------------------------------------------------------------------

export function App() {
	return (
		<StoreProvider>
			<AppInner />
		</StoreProvider>
	);
}

// ---------------------------------------------------------------------------
// AppInner — access store inside Provider
// ---------------------------------------------------------------------------

function AppInner() {
	const { retry } = useConnection();
	useDraftGuard();

	const vm = useViewModel();
	const rpc = useRpc();
	// Branch selection matrix (navigate when idle + live, peek otherwise) —
	// shared by the conversation pager and the keyboard ring.
	const handleBranchSelect = useBranchSelect();
	const { commit, beginEdit } = useComposerCommit(rpc);
	const cycleModel = useModelCycling();
	const sidebar = useSidebarShell();
	const history = useHistoryPaneShell();

	// Status the shell renders directly (TopBar title, busy guard,
	// notifications). Models, registry lists, and composer status are
	// consumed inside the features that render them.
	//
	// The title names the object the surface renders — the attached Session, or
	// the Project whose home is open — never the `staged` document a detach
	// leaves behind (see `topBarTitle`). The tab title reads the same value.
	const statusName = useStore(topBarTitle);
	const isStreaming = useStore((s) => s.document.status.isStreaming);
	const connection = useStore((s) => s.connection);
	const currentStem = useStore((s) => s.currentStem);
	// Passive awareness (ADR 23): how many Sessions other than this one are
	// waiting for a reply, and how many of those finished since this page last
	// read them (per page, in memory — see `unreadCompletions`). Both selectors
	// return a number: the address is built inside them, so it is an argument and
	// never the snapshot — a selector returning a fresh object would make
	// `getSnapshot` incomparable and loop.
	const waitingCount = useStore((s) => waitingBadgeCount(s.queue, attachedAddress(s)));
	const waitingNewCount = useStore((s) => waitingNewCountOf(s.queue, s.unreadCompletions, attachedAddress(s)));

	// ── Status notification ──────────────────────────────────────────────
	const activityPhase = isStreaming ? liveActivityPhase(vm) : null;
	useStatusNotifications({
		isStreaming,
		statusName,
		activity: { emoji: activityPhase === "thinking" ? "🧠" : activityPhase === "tool" ? "🔧" : "💬" },
	});
	// The queue-wide half of the same story: a Session other than the one being
	// read finishes, so the notice names it and a click opens it.
	useAttentionNotifications();
	useServiceWorkerSessionOpen(rpc.openSession);

	// ── Keyboard ring (document-level, via useAppKeybindings) ────────────
	useAppKeybindings(
		useKeyboardRing({
			vm,
			onCycleModel: cycleModel,
			onOpenSession: rpc.openSession,
			onOpenProject: rpc.openProject,
			beginEdit,
			navigate: handleBranchSelect,
			sidebarToggle: sidebar.toggle,
			newSession: sidebar.newSession,
			historyToggle: history.toggle,
		}),
	);

	const hasOpenSession = currentStem !== null;

	// Stable callbacks for memo'd chrome (TopBar): a fresh arrow per render
	// would defeat its memo on every streaming patch.
	const handleRename = useCallback(
		async (name: string) => {
			await rpc.renameSession(name);
		},
		[rpc],
	);

	return (
		<div className={styles.root}>
			<ToastBar />
			<SecureContextHint />
			{/* TopBar */}
			<TopBar
				name={statusName}
				connection={connection}
				showSidebarToggle={sidebar.mode === "hidden"}
				onSidebarToggle={sidebar.onMenuButton}
				menuButtonRef={sidebar.menuButtonRef}
				waitingCount={waitingCount}
				waitingNewCount={waitingNewCount}
				onSidebarHover={sidebar.setHamburgerHover}
				showHistoryToggle={hasOpenSession && history.mode === "hidden"}
				onHistory={history.toggle}
				onHistoryHover={history.setHistoryHover}
				canRename={hasOpenSession}
				onRename={handleRename}
				onRetry={retry}
			/>

			{/* Compact switcher (narrow viewport, ADR 23): the fullscreen pane is
			    one row away, so skimming costs one move instead of two. */}
			{sidebar.quickSwitcher}

			<div className={styles.body}>
				{/* Sidebar — Project folders with their sessions (ADR 11) */}
				{sidebar.sidebar}

				{/* Conversation or the Project home */}
				<div className={styles.conversation}>
					{hasOpenSession ? (
						<>
							<ConversationArea
								vm={vm}
								isStreaming={isStreaming}
								onSelectBranch={handleBranchSelect}
								onEdit={beginEdit}
								onRecover={rpc.recoverTurn}
							/>
							{/* The dock's one prop is the commit callback, shared with
							    the keyboard ring — hence created here, not inside. */}
							<ComposeDock onCommit={commit} />
						</>
					) : (
						<Launcher retry={retry} />
					)}
				</div>
			</div>
			{/* HistoryPane — the shared PaneShell on the right (mode owned by
			    useHistoryPaneShell, so it survives the pane's unmount when no
			    session is open) */}
			{hasOpenSession && history.pane}
			<FileBrowser />
		</div>
	);
}

/** The address this tab is reading, in the shape the badge helpers take it. */
function attachedAddress(s: { currentProjectId: string | null; currentStem: string | null }): SessionAddress | null {
	return s.currentProjectId !== null && s.currentStem !== null
		? { projectId: s.currentProjectId, stem: s.currentStem }
		: null;
}

// ============================================================================
// App — root shell: TopBar, Sidebar, ConversationArea/ComposeDock (or the
// Launcher), HistoryPane, FileViewer. The shell owns only chrome composition;
// per-area wiring lives with its area:
//   - useSidebarShell (sidebar)  — Sidebar props + the chrome handles
//                                  (mode mirror, hamburger toggle, Alt+N)
//   - ComposeDock / Launcher      — self-sufficient (store + useRpc); the
//                                  dock's one prop is the commit callback,
//                                  shared with the keyboard ring
//   - useViewModel (state)        — store→ViewModel projection + cache
//   - useComposerCommit (composer)— draft→wire commit/fork flow
//   - useModelCycling (composer)  — the Ctrl+P / picker model cycle
//   - useKeyboardRing (app)       — AppKeyHandlers over vm + store + rpc
// What stays here is genuinely shell-level: the status notification wiring,
// the busy-guarded navigate, the TopBar, and the launcher/conversation fork.
// ============================================================================

import { useCallback } from "react";
import { liveActivityPhase } from "../../../src/viewmodel/index.ts";
import { ComposeDock } from "../features/composer/ComposeDock.tsx";
import { useComposerCommit } from "../features/composer/useComposerCommit.ts";
import { useModelCycling } from "../features/composer/useModelCycling.ts";
import { ConversationArea } from "../features/conversation/ConversationArea.tsx";
import { HistoryPane } from "../features/history/HistoryPane.tsx";
import { Launcher } from "../features/launcher/Launcher.tsx";
import { useSidebarShell } from "../features/sidebar/useSidebarShell.tsx";
import { TopBar } from "../features/topbar/TopBar.tsx";
import { FileViewer } from "../features/viewer/FileViewer.tsx";
import { useConnection } from "../infra/net/useConnection.ts";
import { useRpc } from "../infra/net/useRpc.ts";
import { useDraftGuard } from "../infra/persist/draftPersistence.ts";
import { StoreProvider, useStore } from "../infra/state/store.tsx";
import { useViewModel } from "../infra/state/useViewModel.ts";
import styles from "./App.module.css";
import { useAppKeybindings } from "./keybindings.ts";
import { ToastBar } from "./ToastBar.tsx";
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
	const { commit, beginEdit } = useComposerCommit(rpc);
	const cycleModel = useModelCycling();
	const sidebar = useSidebarShell();

	// Status the shell renders directly (TopBar title, busy guard,
	// notifications). Models, registry lists, and composer status are
	// consumed inside the features that render them.
	const statusName = useStore((s) => s.document.status.name);
	const isStreaming = useStore((s) => s.document.status.isStreaming);
	const isCompacting = useStore((s) => s.document.status.isCompacting);
	const connection = useStore((s) => s.connection);
	const currentStem = useStore((s) => s.currentStem);
	const historyOpen = useStore((s) => s.historyOpen);
	const setHistoryOpen = useStore((s) => s.setHistoryOpen);

	// ── Status notification ──────────────────────────────────────────────
	const isBusy = isStreaming || isCompacting;
	const activityPhase = isStreaming ? liveActivityPhase(vm) : null;
	useStatusNotifications({
		isStreaming,
		statusName,
		activity: { emoji: activityPhase === "thinking" ? "🧠" : activityPhase === "tool" ? "🔧" : "💬" },
	});

	// Branch navigation (conversation pager + history pane): blocked while a
	// turn is in flight — a fork mid-turn would race the run.
	const handleNavigate = useCallback(
		(entryId: string) => {
			if (isBusy) return;
			rpc.navigate(entryId);
		},
		[isBusy, rpc],
	);

	// ── Keyboard ring (document-level, via useAppKeybindings) ────────────
	useAppKeybindings(
		useKeyboardRing({
			vm,
			onCycleModel: cycleModel,
			onOpenSession: rpc.openSession,
			onOpenProject: rpc.openProject,
			beginEdit,
			navigate: handleNavigate,
			sidebarToggle: sidebar.toggle,
			newSession: sidebar.newSession,
		}),
	);

	const hasOpenSession = currentStem !== null;

	return (
		<div className={styles.root}>
			<ToastBar />
			{/* TopBar */}
			<TopBar
				name={statusName}
				connection={connection}
				showSidebarToggle={sidebar.mode === "hidden"}
				onSidebarToggle={sidebar.toggle}
				onSidebarHover={sidebar.setHamburgerHover}
				onHistory={() => setHistoryOpen(!historyOpen)}
				onRename={async (name) => {
					await rpc.renameSession(name);
				}}
				onRetry={retry}
			/>

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
								onNavigate={handleNavigate}
								onEdit={beginEdit}
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
			{hasOpenSession && <HistoryPane />}
			<FileViewer />
		</div>
	);
}

// ============================================================================
// App — root shell: TopBar, Sidebar, ConversationArea/ComposeDock (or the
// Launcher), HistoryPane, FileViewer. The behavior that used to live here is
// extracted into hooks:
//   - useViewModel (infra)       — store→ViewModel projection + cache
//   - useComposerCommit (composer) — draft→wire commit/fork flow
//   - useKeyboardRing (infra)    — AppKeyHandlers over vm + store + rpc
// App owns what is genuinely shell: chrome state, the shared model-cycling
// callback, and thin pass-throughs to the RPC layer.
// ============================================================================

import { useCallback, useMemo, useRef, useState } from "react";
import type { ImageContent, ModelRef } from "../../../src/core/index.ts";
import { findNextModel, liveActivityPhase } from "../../../src/viewmodel/index.ts";
import { ComposeDock } from "../features/composer/ComposeDock.tsx";
import { useComposerCommit } from "../features/composer/useComposerCommit.ts";
import { ConversationArea } from "../features/conversation/ConversationArea.tsx";
import { HistoryPane } from "../features/history/HistoryPane.tsx";
import { Launcher } from "../features/launcher/Launcher.tsx";
import { Sidebar, type SidebarMode } from "../features/sidebar/Sidebar.tsx";
import { TopBar } from "../features/topbar/TopBar.tsx";
import { FileViewer } from "../features/viewer/FileViewer.tsx";
import { useDraftGuard } from "../infra/draftPersistence.ts";
import { useAppKeybindings } from "../infra/keybindings.ts";
import { StoreProvider, useStore } from "../infra/store.tsx";
import { useConnection } from "../infra/useConnection.ts";
import { useKeyboardRing } from "../infra/useKeyboardRing.ts";
import { useRpc } from "../infra/useRpc.ts";
import { useStatusNotifications } from "../infra/useStatusNotifications.ts";
import { useViewModel } from "../infra/useViewModel.ts";
import styles from "./App.module.css";
import { ToastBar } from "./ToastBar.tsx";

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

	// Status fields the shell renders directly (TopBar title, dock model row,
	// busy states). The full document is consumed inside useViewModel.
	const statusName = useStore((s) => s.document.status.name);
	const statusModel = useStore((s) => s.document.status.model);
	const statusThinkingLevel = useStore((s) => s.document.status.thinkingLevel);
	const isStreaming = useStore((s) => s.document.status.isStreaming);
	const isCompacting = useStore((s) => s.document.status.isCompacting);

	const connection = useStore((s) => s.connection);
	const currentProjectId = useStore((s) => s.currentProjectId);
	const currentStem = useStore((s) => s.currentStem);
	const projects = useStore((s) => s.projects);
	const activeSessions = useStore((s) => s.activeSessions);
	const sessionPages = useStore((s) => s.sessionPages);
	const models = useStore((s) => s.models);
	const thinkingLevels = useStore((s) => s.thinkingLevels);
	const scopedModels = useStore((s) => s.document.scopedModels);

	const toggleActionGroup = useStore((s) => s.toggleActionGroup);
	const toggleStep = useStore((s) => s.toggleStep);
	const historyOpen = useStore((s) => s.historyOpen);
	const setHistoryOpen = useStore((s) => s.setHistoryOpen);

	const rpc = useRpc();
	const { commit, beginEdit } = useComposerCommit(rpc);

	// ── Status notification ──────────────────────────────────────────────
	const isBusy = isStreaming || isCompacting;
	const activityPhase = isStreaming ? liveActivityPhase(vm) : null;
	useStatusNotifications({
		isStreaming,
		statusName,
		activity: { emoji: activityPhase === "thinking" ? "🧠" : activityPhase === "tool" ? "🔧" : "💬" },
	});

	// ── Model cycling (shared: keyboard Ctrl+P + the dock's picker) ──────
	const cycleModels = useMemo(() => {
		if (scopedModels.length > 0) return scopedModels;
		const seen = new Set<string>();
		return models.filter((m) => {
			if (seen.has(m.provider)) return false;
			seen.add(m.provider);
			return true;
		});
	}, [scopedModels, models]);
	const handleCycleModel = useCallback(
		(direction: "forward" | "backward") => {
			const next = findNextModel(cycleModels, statusModel, direction);
			if (next) rpc.setModel(next.provider, next.id);
		},
		[cycleModels, statusModel, rpc],
	);

	// ── Thin pass-throughs to the RPC layer ──────────────────────────────
	const handleToggleGroup = useCallback(
		(key: string, cardKeys: string[]) => toggleActionGroup(key, cardKeys),
		[toggleActionGroup],
	);
	const handleToggleStep = useCallback((key: string) => toggleStep(key), [toggleStep]);

	const handleNavigate = useCallback(
		(entryId: string) => {
			if (isBusy) return;
			rpc.navigate(entryId);
		},
		[isBusy, rpc],
	);

	// Attach, don't retarget: opening a session resolves-or-creates an
	// activation on the daemon and rebinds this connection (ADR 11) — the
	// previously attached session keeps running headless. No isBusy guard:
	// streaming on the old attachment is not a reason to reject a switch.
	// (The serial-switch rule in useRpc still rejects a second open while one
	// is in flight — that one is a real candidate-promotion race.)
	const handleOpenSession = useCallback(
		(projectId: string, stem: string, sessionId?: string) => {
			// Passing the id lets the client seed a cache cursor (ADR 09) instead of
			// falling back to a full replace on every UI session switch.
			rpc.openSession(projectId, stem, sessionId);
		},
		[rpc],
	);

	// Create a session by sending its first prompt (ADR 12 slice): the
	// daemon admits the prompt (with any attachments and the pre-session
	// model/thinking-level choices) before attaching, so the session the
	// client navigates into already carries the in-flight turn. There is no
	// empty-session path — text is required.
	const handleNewSession = useCallback(
		(projectId: string, text: string, images?: ImageContent[], model?: ModelRef, thinkingLevel?: string) => {
			return rpc.newSession(projectId, text, { images, model, thinkingLevel });
		},
		[rpc],
	);

	// Row-menu Close: terminates the live instance with no confirmation. If it
	// was the viewed session, useRpc falls back to the Project home.
	const handleCloseSession = useCallback(
		(projectId: string, stem: string) => {
			rpc.closeSession(projectId, stem);
		},
		[rpc],
	);

	const handleOpenProject = useCallback(
		(projectId: string) => {
			rpc.openProject(projectId);
		},
		[rpc],
	);

	const handleShowLauncher = useCallback(() => {
		void rpc.detach();
	}, [rpc]);

	const handleLoadFolder = useCallback(
		(projectId: string) => {
			rpc.loadFolderSessions(projectId);
		},
		[rpc],
	);

	const handleLoadMoreFolder = useCallback(
		(projectId: string) => {
			rpc.loadMoreFolderSessions(projectId);
		},
		[rpc],
	);

	// ── Keyboard ring (document-level, via useAppKeybindings) ────────────
	// Imperative handles the Sidebar populates: sidebarToggle opens the
	// sidebar (if closed); newSession opens its new-session surface (Alt+N
	// when more than one Project is configured — ==1 navigates to the Project
	// home, where the prompt input starts a session).
	const sidebarToggleRef = useRef<() => void>(() => {});
	const newSessionRef = useRef<() => void>(() => {});

	useAppKeybindings(
		useKeyboardRing({
			vm,
			onCycleModel: handleCycleModel,
			onOpenSession: handleOpenSession,
			onOpenProject: handleOpenProject,
			beginEdit,
			navigate: handleNavigate,
			sidebarToggle: () => sidebarToggleRef.current(),
			newSession: () => newSessionRef.current(),
		}),
	);

	// ── Sidebar shell state. The Sidebar owns its mode and the peek drawer;
	// the App mirrors the mode for cross-component chrome (TopBar hamburger
	// visibility) and forwards the hamburger's raw hover signal down. ──
	const [sidebarMode, setSidebarMode] = useState<SidebarMode>("hidden");
	const [sidebarHover, setSidebarHover] = useState(false);

	const hasOpenSession = currentStem !== null;

	return (
		<div className={styles.root}>
			<ToastBar />
			{/* TopBar */}
			<TopBar
				name={statusName}
				connection={connection}
				showSidebarToggle={sidebarMode === "hidden"}
				onSidebarToggle={() => sidebarToggleRef.current()}
				onSidebarHover={setSidebarHover}
				onHistory={() => setHistoryOpen(!historyOpen)}
				onRename={async (name) => {
					await rpc.renameSession(name);
				}}
				onRetry={retry}
			/>

			<div className={styles.body}>
				{/* Sidebar — Project folders with their sessions (ADR 11) */}
				<Sidebar
					projects={projects}
					currentProjectId={currentProjectId}
					currentStem={currentStem}
					activeSessions={activeSessions}
					sessionPages={sessionPages}
					onOpenSession={handleOpenSession}
					onOpenProject={handleOpenProject}
					onCloseSession={handleCloseSession}
					onShowLauncher={handleShowLauncher}
					onLoadFolder={handleLoadFolder}
					onLoadMoreFolder={handleLoadMoreFolder}
					toggleRef={sidebarToggleRef}
					newSessionRef={newSessionRef}
					onModeChange={setSidebarMode}
					hamburgerHover={sidebarHover}
				/>

				{/* Conversation or the Project home */}
				<div className={styles.conversation}>
					{hasOpenSession ? (
						<>
							<ConversationArea
								vm={vm}
								isStreaming={isStreaming}
								onToggleGroup={handleToggleGroup}
								onToggleStep={handleToggleStep}
								onNavigate={handleNavigate}
								onEdit={beginEdit}
							/>
							<ComposeDock
								onCommit={commit}
								onStop={rpc.abort}
								onDiscardSteer={rpc.discardSteer}
								isBusy={isBusy}
								connected={connection.kind === "connected"}
								model={statusModel}
								thinkingLevel={statusThinkingLevel}
								models={models}
								scopedModels={scopedModels}
								thinkingLevels={thinkingLevels}
								isStreaming={isStreaming}
								onSetModel={rpc.setModel}
								onSetThinkingLevel={rpc.setThinkingLevel}
								onCycleModel={handleCycleModel}
							/>
						</>
					) : (
						<Launcher
							connection={connection}
							projects={projects}
							activeSessions={activeSessions}
							projectId={currentProjectId}
							models={models}
							onOpenProject={handleOpenProject}
							onOpenSession={handleOpenSession}
							onNewSession={handleNewSession}
							retry={retry}
						/>
					)}
				</div>
			</div>
			{hasOpenSession && <HistoryPane />}
			<FileViewer />
		</div>
	);
}

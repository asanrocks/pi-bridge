// ============================================================================
// useSidebarShell — the Sidebar's container hook: composes the presentational
// Sidebar (which stays props-only) with its store data and RPC actions, and
// owns the shell chrome that used to live in App — the mode (owned here via
// usePaneMode so it survives any future pane unmounts; reported to App for
// TopBar hamburger visibility), the compact switcher a narrow viewport opens
// instead of the fullscreen pane (ADR 23), and the imperative handles
// (hamburger toggle, Alt+N new-session surface). App consumes
// { sidebar, quickSwitcher, menuButtonRef, mode, toggle, onMenuButton,
// newSession, setHamburgerHover }; new sidebar wiring grows here, not in the
// shell.
// ============================================================================

import { useCallback, useRef, useState } from "react";
import { useMediaQuery } from "../../infra/lib/useMediaQuery.ts";
import { useRpc } from "../../infra/net/useRpc.ts";
import { useStore } from "../../infra/state/store.tsx";
import { usePaneMode } from "../../render/usePaneMode.ts";
import { QuickSwitcher } from "./QuickSwitcher.tsx";
import { Sidebar } from "./Sidebar.tsx";

const SIDEBAR_BREAKPOINT = "(min-width: 768px)";

export function useSidebarShell() {
	const projects = useStore((s) => s.projects);
	const currentProjectId = useStore((s) => s.currentProjectId);
	const currentStem = useStore((s) => s.currentStem);
	const queue = useStore((s) => s.queue);
	const sessionPages = useStore((s) => s.sessionPages);
	const rpc = useRpc();
	const isWide = useMediaQuery(SIDEBAR_BREAKPOINT);

	const [hamburgerHover, setHamburgerHover] = useState(false);
	const toggleRef = useRef<() => void>(() => {});
	// Alt+N with several Projects: ensure the sidebar is open so its project
	// list is reachable (a session is started from a Project's home prompt).
	const newSessionRef = useRef<() => void>(() => {});
	const { mode, setMode, dismissOverlay } = usePaneMode({
		isWide,
		persistenceKey: "pi-bridge:sidebar-open",
		toggleRef,
		openRef: newSessionRef,
	});

	// Stable callbacks: App re-renders on every document write (it hosts the
	// projection), and an inline arrow here would defeat Sidebar's memo on every
	// streaming delta.
	const showLauncher = useCallback(() => void rpc.detach(), [rpc]);

	// Opening a session is an attach, not a retarget (ADR 11): the daemon
	// resolves-or-creates the activation and rebinds this connection — the
	// previously attached session keeps streaming headless, so there is no
	// isBusy guard here. Passing the row's sessionId lets the client seed a
	// cache cursor (ADR 09) instead of falling back to a full replace on
	// every UI session switch.
	const sidebar = (
		<Sidebar
			projects={projects}
			currentProjectId={currentProjectId}
			currentStem={currentStem}
			queue={queue}
			sessionPages={sessionPages}
			onOpenSession={rpc.openSession}
			onOpenProject={rpc.openProject}
			onMarkInactive={rpc.closeSession}
			onSetSessionState={rpc.setSessionState}
			onArchiveSession={rpc.archiveSession}
			onShowLauncher={showLauncher}
			onLoadFolder={rpc.loadFolderSessions}
			onLoadMoreFolder={rpc.loadMoreFolderSessions}
			mode={mode}
			setMode={setMode}
			isWide={isWide}
			dismissOverlay={dismissOverlay}
			hamburgerHover={hamburgerHover}
		/>
	);

	const toggle = useCallback(() => toggleRef.current(), []);
	const newSession = useCallback(() => newSessionRef.current(), []);

	// ── Compact switcher (narrow viewport) ──────────────────────────────
	// The TopBar menu button anchors the panel and carries the waiting badge,
	// so one owner (the shell) holds both.
	const menuButtonRef = useRef<HTMLButtonElement | null>(null);
	const [quickOpen, setQuickOpen] = useState(false);
	const openQuick = useCallback(() => setQuickOpen(true), []);
	const closeQuick = useCallback(() => setQuickOpen(false), []);
	// The one shortcut out of the compact list: the full surface, opened rather
	// than toggled, so a stale mode cannot close it on the way in.
	const viewAll = useCallback(() => {
		setQuickOpen(false);
		setMode("fullscreen");
	}, [setMode]);

	const handleOpenFromQuick = useCallback(
		(session: { projectId: string; stem: string; sessionId?: string }) => {
			// Passing the row's sessionId lets the client seed a cache cursor
			// (ADR 09) instead of a full replace (the same rule the Sidebar applies).
			rpc.openSession(session.projectId, session.stem, session.sessionId);
			setQuickOpen(false);
		},
		[rpc],
	);

	const handleSetStateFromQuick = useCallback(
		(session: { projectId: string; stem: string }, state: "notified" | "deferred") => {
			rpc.setSessionState(session.projectId, session.stem, state);
		},
		[rpc],
	);

	/** The TopBar menu button: the full pane on a wide viewport, the compact
	 * list on a narrow one (the fullscreen overlay is one row away). */
	const onMenuButton = isWide ? toggle : openQuick;

	const quickSwitcher =
		quickOpen && !isWide ? (
			<QuickSwitcher
				anchor={menuButtonRef.current}
				queue={queue}
				currentProjectId={currentProjectId}
				currentStem={currentStem}
				onOpen={handleOpenFromQuick}
				onSetState={handleSetStateFromQuick}
				onViewAll={viewAll}
				onClose={closeQuick}
			/>
		) : null;

	return { sidebar, quickSwitcher, menuButtonRef, mode, isWide, toggle, onMenuButton, newSession, setHamburgerHover };
}

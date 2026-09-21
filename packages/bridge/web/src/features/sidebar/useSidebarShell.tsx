// ============================================================================
// useSidebarShell — the Sidebar's container hook: composes the presentational
// Sidebar (which stays props-only) with its store data and RPC actions, and
// owns the shell chrome that used to live in App — the mode (owned here via
// usePaneMode so it survives any future pane unmounts; reported to App for
// TopBar hamburger visibility) and the imperative handles (hamburger toggle,
// Alt+N new-session surface). App consumes { sidebar, mode, toggle,
// newSession, setHamburgerHover }; new sidebar wiring grows here, not in the
// shell.
// ============================================================================

import { useCallback, useRef, useState } from "react";
import { useMediaQuery } from "../../infra/lib/useMediaQuery.ts";
import { useRpc } from "../../infra/net/useRpc.ts";
import { useStore } from "../../infra/state/store.tsx";
import { usePaneMode } from "../../render/usePaneMode.ts";
import { Sidebar } from "./Sidebar.tsx";

const SIDEBAR_BREAKPOINT = "(min-width: 768px)";

export function useSidebarShell() {
	const projects = useStore((s) => s.projects);
	const currentProjectId = useStore((s) => s.currentProjectId);
	const currentStem = useStore((s) => s.currentStem);
	const activeSessions = useStore((s) => s.activeSessions);
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
			activeSessions={activeSessions}
			sessionPages={sessionPages}
			onOpenSession={rpc.openSession}
			onOpenProject={rpc.openProject}
			onCloseSession={rpc.closeSession}
			onShowLauncher={() => void rpc.detach()}
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

	return { sidebar, mode, toggle, newSession, setHamburgerHover };
}

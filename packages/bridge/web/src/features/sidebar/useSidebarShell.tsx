// ============================================================================
// useSidebarShell — the Sidebar's container hook: composes the presentational
// Sidebar (which stays props-only) with its store data and RPC actions, and
// owns the shell chrome that used to live in App — the mode mirror (TopBar
// hamburger visibility), the raw hamburger hover signal, and the imperative
// handles the Sidebar populates (hamburger toggle, Alt+N new-session
// surface). App consumes { sidebar, mode, toggle, newSession,
// setHamburgerHover }; new sidebar wiring grows here, not in the shell.
// ============================================================================

import { useCallback, useRef, useState } from "react";
import { useRpc } from "../../infra/net/useRpc.ts";
import { useStore } from "../../infra/state/store.tsx";
import { Sidebar, type SidebarMode } from "./Sidebar.tsx";

export function useSidebarShell() {
	const projects = useStore((s) => s.projects);
	const currentProjectId = useStore((s) => s.currentProjectId);
	const currentStem = useStore((s) => s.currentStem);
	const activeSessions = useStore((s) => s.activeSessions);
	const sessionPages = useStore((s) => s.sessionPages);
	const rpc = useRpc();

	const [mode, setMode] = useState<SidebarMode>("hidden");
	const [hamburgerHover, setHamburgerHover] = useState(false);
	const toggleRef = useRef<() => void>(() => {});
	const newSessionRef = useRef<() => void>(() => {});

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
			toggleRef={toggleRef}
			newSessionRef={newSessionRef}
			onModeChange={setMode}
			hamburgerHover={hamburgerHover}
		/>
	);

	const toggle = useCallback(() => toggleRef.current(), []);
	const newSession = useCallback(() => newSessionRef.current(), []);

	return { sidebar, mode, toggle, newSession, setHamburgerHover };
}

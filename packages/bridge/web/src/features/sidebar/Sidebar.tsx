// ============================================================================
// Sidebar — tri-mode Project pane (ADR 11): hidden / rail / fullscreen, the
// shared PaneShell behavior for the left side. This module supplies only the
// pane's policy and chrome: width bounds, the corner-toggle header (the
// (12, 6) TopBar-hamburger box, so the same screen corner toggles the
// sidebar in every mode), the shared panel body, and the navigation
// callbacks. Mode, resize, drag-overshoot, edge-reveal, peek, and Esc all
// live in render/PaneShell; the mode itself is owned by useSidebarShell.
// Siblings:
//   - useSidebarShell  — store data + RPC actions + mode ownership
//   - useFolderExpansion — persisted folder fold state + auto-expand
//   - SidebarContent   — the shared panel body (header + folder tree)
//     ├─ ProjectFolder  — one foldable Project branch
//     └─ SessionRow     — one session leaf (+ row menu)
// ============================================================================

import { memo, useCallback, useMemo } from "react";
import type { ProjectInfo, SessionInfo } from "../../../../src/core/index.ts";
import type { SessionFolderPage } from "../../infra/state/store.ts";
import { PaneShell, type PaneShellHeaderActions, type PaneVariant } from "../../render/PaneShell.tsx";
import type { PaneMode } from "../../render/usePaneMode.ts";
import styles from "./Sidebar.module.css";
import { SidebarContent } from "./SidebarContent.tsx";
import { useFolderExpansion } from "./useFolderExpansion.ts";

/* Desktop width bounds for the resizable rail. Default matches the
   historical fixed width; min keeps section headers + rows readable,
   max keeps a usable conversation column (also viewport-capped at 45%). */
const SIDEBAR_DEFAULT_W = 220;
const SIDEBAR_MIN_W = 180;
const SIDEBAR_MAX_W = 360;

/* Corner toggle: the same (12, 6) box as the TopBar hamburger and the peek
   drawer's pin button, so the same screen corner toggles the sidebar
   throughout. ✕ matches the fullscreen overlay: an open sidebar closes;
   only the transient peek shows the hamburger, which pins the rail. */
const renderSidebarHeader = (variant: PaneVariant, actions: PaneShellHeaderActions) => (
	<div className={styles.overlayHeader}>
		{variant === "peek" ? (
			<button
				type="button"
				className={styles.sidebarAddBtn}
				onClick={actions.pin}
				aria-label="Open sidebar"
				title="Open sidebar"
			>
				<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
					<rect x="3" y="6" width="18" height="2" />
					<rect x="3" y="11" width="18" height="2" />
					<rect x="3" y="16" width="18" height="2" />
				</svg>
			</button>
		) : (
			<button
				type="button"
				className={styles.sidebarAddBtn}
				onClick={variant === "rail" ? actions.hide : actions.dismiss}
				aria-label={variant === "rail" ? "Hide sidebar" : "Close sidebar"}
				title={variant === "rail" ? "Hide sidebar" : "Close (Esc)"}
			>
				<svg
					viewBox="0 0 20 20"
					width="18"
					height="18"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					aria-hidden="true"
				>
					<path d="M5 5l10 10M15 5L5 15" />
				</svg>
			</button>
		)}
	</div>
);

export const Sidebar = memo(function Sidebar({
	projects,
	currentProjectId,
	currentStem,
	activeSessions,
	sessionPages,
	onOpenSession,
	onOpenProject,
	onCloseSession,
	onArchiveSession,
	onShowLauncher,
	onLoadFolder,
	onLoadMoreFolder,
	mode,
	setMode,
	isWide,
	dismissOverlay,
	hamburgerHover,
}: {
	projects: ProjectInfo[];
	currentProjectId: string | null;
	/** Open session's stem, or null on the Project home / launcher. */
	currentStem: string | null;
	/** Global active/streaming snapshot (ADR 11) — the authority for the
	 *  pinned section at the top of each folder. */
	activeSessions: SessionInfo[];
	/** Per-Project lazily fetched history pages, keyed by projectId. */
	sessionPages: Record<string, SessionFolderPage>;
	onOpenSession: (projectId: string, stem: string, sessionId?: string) => void;
	/** Navigate to a Project's home (the compose surface) — the sidebar's
	 *  folder-name click. */
	onOpenProject: (projectId: string) => void;
	/** Terminate a session's live instance (row menu Close, no confirmation). */
	onCloseSession: (projectId: string, stem: string) => void;
	/** Close then archive a session (row menu Archive, no confirmation) —
	 *  available on dormant rows too, where only the move happens. */
	onArchiveSession: (projectId: string, stem: string) => void;
	/** Detach and return to the Launcher (global project picker). */
	onShowLauncher: () => void;
	onLoadFolder: (projectId: string) => void;
	onLoadMoreFolder: (projectId: string) => void;
	/** Tri-mode state (owned by useSidebarShell) + setter for pane-level
	 *  policy (the fullscreen dismissal below). */
	mode: PaneMode;
	setMode: React.Dispatch<React.SetStateAction<PaneMode>>;
	isWide: boolean;
	dismissOverlay: () => void;
	/** Raw hover signal from the TopBar hamburger (the App just forwards
	 *  it): true while the pointer is over the hamburger. PaneShell owns
	 *  the peek drawer this drives, including the grace-delayed hide. */
	hamburgerHover: boolean;
}) {
	// The Projects header and the per-folder rows share the tri-state fold
	// record (folded / active / open); the header fans out across all ids.
	const projectIds = useMemo(() => projects.map((p) => p.id), [projects]);
	const { folds, cycleFolder, cycleAllFolders } = useFolderExpansion(projectIds, currentProjectId, currentStem);

	const handleCloseSession = useCallback(
		(session: SessionInfo) => {
			onCloseSession(session.projectId, session.stem);
		},
		[onCloseSession],
	);

	const handleArchiveSession = useCallback(
		(session: SessionInfo) => {
			onArchiveSession(session.projectId, session.stem);
		},
		[onArchiveSession],
	);

	// All-projects leaves the current Project: detach, and the fullscreen
	// overlay backs off (desktop → rail; mobile has nothing to dismiss from
	// hidden mode).
	const handleShowLauncher = useCallback(() => {
		onShowLauncher();
		if (!isWide || mode === "fullscreen") dismissOverlay();
	}, [onShowLauncher, isWide, mode, dismissOverlay]);

	return (
		<PaneShell
			side="left"
			isWide={isWide}
			mode={mode}
			setMode={setMode}
			cssVar="--sidebar-w"
			storageKey="pi-bridge:sidebar-w"
			defaultWidth={SIDEBAR_DEFAULT_W}
			min={SIDEBAR_MIN_W}
			max={SIDEBAR_MAX_W}
			label="sidebar"
			hoverSignal={hamburgerHover}
			renderHeader={renderSidebarHeader}
		>
			{(api) => (
				<SidebarContent
					projects={projects}
					currentProjectId={currentProjectId}
					currentStem={currentStem}
					activeSessions={activeSessions}
					sessionPages={sessionPages}
					folds={folds}
					onToggleAllFolders={cycleAllFolders}
					onToggleFolder={cycleFolder}
					onOpenSession={(session) => {
						// Passing the id lets the client seed a cache cursor (ADR 09)
						// instead of falling back to a full replace on every UI
						// session switch. Picking dismisses the overlays.
						onOpenSession(session.projectId, session.stem, session.sessionId);
						api.dismissAfterPick();
					}}
					onOpenProject={(projectId) => {
						onOpenProject(projectId);
						api.dismissAfterPick();
					}}
					onCloseSession={handleCloseSession}
					onArchiveSession={handleArchiveSession}
					onShowLauncher={handleShowLauncher}
					onLoadFolder={onLoadFolder}
					onLoadMoreFolder={onLoadMoreFolder}
				/>
			)}
		</PaneShell>
	);
});

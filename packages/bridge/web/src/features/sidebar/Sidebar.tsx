// ============================================================================
// Sidebar — tri-mode panel (ADR 11): hidden / rail / fullscreen. Desktop
// (≥768px) supports all three: a resizable rail whose drag snaps live at
// both bounds — crossing below the min snaps it shut (dragging back wider
// snaps it open), crossing above the max snaps the fullscreen overlay in
// (dragging back snaps it out) — and the release decides with the same
// predicate, so the on-screen state never lies. Fullscreen is a pure
// overlay above the TopBar (close button + Esc). While hidden on desktop,
// the TopBar hamburger hover-peeks this same content as a temporary
// drawer, and a left edge-drag strip reveals the rail pointer-absolute
// (visible only once the pointer passes the min width). Mobile has only
// hidden / fullscreen (full-screen width).
//
// This module is the orchestrator; the pieces are siblings:
//   - useSidebarMode    — the hidden/rail/fullscreen state machine
//   - useFolderExpansion — persisted folder fold state + auto-expand
//   - usePeekDrawer     — the hover-peek drawer (hidden mode)
//   - useEdgeReveal     — the left-edge drag-open gesture
//   - SidebarContent    — the shared panel body (header + folder tree)
//     ├─ ProjectFolder  — one foldable Project branch
//     └─ SessionRow     — one session leaf (+ row menu)
// ============================================================================

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectInfo, SessionInfo } from "../../../../src/core/index.ts";
import { useMediaQuery } from "../../infra/lib/useMediaQuery.ts";
import type { SessionFolderPage } from "../../infra/state/store.ts";
import { ResizeHandle, usePaneResize } from "../../render/ResizeHandle.tsx";
import styles from "./Sidebar.module.css";
import { SidebarContent } from "./SidebarContent.tsx";
import { useEdgeReveal } from "./useEdgeReveal.ts";
import { useFolderExpansion } from "./useFolderExpansion.ts";
import { usePeekDrawer } from "./usePeekDrawer.ts";
import { type SidebarMode, useSidebarMode } from "./useSidebarMode.ts";

export type { SidebarMode };

const SIDEBAR_BREAKPOINT = "(min-width: 768px)";

/* Desktop width bounds for the resizable rail. Default matches the
   historical fixed width; min keeps section headers + rows readable,
   max keeps a usable conversation column (also viewport-capped at 45%). */
const SIDEBAR_DEFAULT_W = 220;
const SIDEBAR_MIN_W = 180;
const SIDEBAR_MAX_W = 360;

export const Sidebar = memo(function Sidebar({
	projects,
	currentProjectId,
	currentStem,
	activeSessions,
	sessionPages,
	onOpenSession,
	onOpenProject,
	onCloseSession,
	onShowLauncher,
	onLoadFolder,
	onLoadMoreFolder,
	toggleRef,
	newSessionRef,
	onModeChange,
	hamburgerHover,
}: {
	projects: ProjectInfo[];
	currentProjectId: string | null;
	/** Open session's stem, or null on the Project home / launcher. */
	currentStem: string | null;
	/** Global active/streaming snapshot (ADR 11) — the authority for the
	 * pinned section at the top of each folder. */
	activeSessions: SessionInfo[];
	/** Per-Project lazily fetched history pages, keyed by projectId. */
	sessionPages: Record<string, SessionFolderPage>;
	onOpenSession: (projectId: string, stem: string, sessionId?: string) => void;
	/** Navigate to a Project's home (the compose surface) — the sidebar's
	 * folder-name click. */
	onOpenProject: (projectId: string) => void;
	/** Terminate a session's live instance (row menu Close, no confirmation). */
	onCloseSession: (projectId: string, stem: string) => void;
	/** Detach and return to the Launcher (global project picker). */
	onShowLauncher: () => void;
	onLoadFolder: (projectId: string) => void;
	onLoadMoreFolder: (projectId: string) => void;
	toggleRef: React.MutableRefObject<() => void>;
	/** Imperative open-sidebar handle populated by the Sidebar. Alt+N calls
	    this with several Projects configured — the project list lives here;
	    a session is started by sending a prompt from a Project's home. */
	newSessionRef: React.MutableRefObject<() => void>;
	/** Mode report for the App shell (TopBar hamburger visibility). Called
	    on every mode change after mount. */
	onModeChange?: (mode: SidebarMode) => void;
	/** Raw hover signal from the TopBar hamburger (the App just forwards
	    it): true while the pointer is over the hamburger. The Sidebar owns
	    the peek drawer this drives, including the grace-delayed hide. */
	hamburgerHover: boolean;
}) {
	const isWide = useMediaQuery(SIDEBAR_BREAKPOINT);

	const { mode, setMode, dismissOverlay } = useSidebarMode({
		isWide,
		toggleRef,
		newSessionRef,
		onModeChange,
	});
	// The Projects header and the per-folder rows share the tri-state fold
	// record (folded / active / open); the header fans out across all ids.
	const projectIds = useMemo(() => projects.map((p) => p.id), [projects]);
	const { folds, cycleFolder, cycleAllFolders } = useFolderExpansion(projectIds, currentProjectId, currentStem);
	const { peekOpen, showPeek, hideNow, peekDrawerRef } = usePeekDrawer(mode, hamburgerHover);

	// Live overshoot preview from the rail's resize handle: crossing below
	// min snaps the rail shut (and back open when dragged wider); crossing
	// above max snaps the fullscreen overlay in (and back out) — the on-screen
	// state always matches what a release at that moment would do. The handle
	// stays mounted through both previews (only the rail div swaps out), so
	// the drag keeps its pointer capture even under the fullscreen overlay.
	// The "min" side is also driven by the edge-reveal drag.
	const [dragPreview, setDragPreview] = useState<"min" | "max" | null>(null);
	const handleOvershootPreview = useCallback((dir: "min" | "max" | null) => setDragPreview(dir), []);
	// dragPreview is only meaningful mid-drag in rail mode; any mode change
	// clears it so an interrupted gesture can't leave the rail invisibly
	// "open" (the entry drags reset it too — belt and braces).
	useEffect(() => {
		if (mode !== "rail" && dragPreview !== null) setDragPreview(null);
	}, [mode, dragPreview]);

	// Drag overshoot release on the rail's resize handle: below min hides,
	// above max fullscreens. The handle restores the pre-drag width first
	// (both directions), so backing out of either state is an undo.
	const handleOvershoot = useCallback(
		(dir: "min" | "max") => {
			setMode(dir === "min" ? "hidden" : "fullscreen");
		},
		[setMode],
	);

	// Resizable rail (desktop): owns the width, persists it, and publishes
	// --sidebar-w so .body and the TopBar clear the gutter. useLayoutEffect
	// inside the hook runs before paint (no one-frame flash); 0 unless the
	// desktop rail is up — fullscreen and the peek drawer are overlays (the
	// conversation keeps full width underneath), and mobile is off-canvas.
	// An overshoot preview takes the rail off-canvas the same way (collapsed
	// or fullscreened): active goes false so the gutter snaps to 0 with it.
	const resize = usePaneResize({
		cssVar: "--sidebar-w",
		storageKey: "pi-bridge:sidebar-w",
		defaultWidth: SIDEBAR_DEFAULT_W,
		min: SIDEBAR_MIN_W,
		max: SIDEBAR_MAX_W,
		active: isWide && mode === "rail" && dragPreview === null,
	});

	const reveal = useEdgeReveal({ resize, setMode, setDragPreview });

	// Picking anything that navigates (a session row, a folder's new-session
	// +) dismisses overlays: mobile fullscreen closes outright; desktop
	// fullscreen backs off to the rail so the picked surface is visible;
	// the peek drawer closes.
	const dismissAfterPick = useCallback(() => {
		if (!isWide) setMode("hidden");
		else if (mode === "fullscreen") setMode("rail");
		else hideNow();
	}, [isWide, mode, setMode, hideNow]);

	// Opening a session is an attach (ADR 11): the daemon resolves-or-creates
	// the activation and rebinds this connection — no isBusy guard, the old
	// attachment keeps streaming headless.
	const handleOpenSession = useCallback(
		(session: SessionInfo) => {
			// Passing the id lets the client seed a cache cursor (ADR 09) instead
			// of falling back to a full replace on every UI session switch.
			onOpenSession(session.projectId, session.stem, session.sessionId);
			dismissAfterPick();
		},
		[onOpenSession, dismissAfterPick],
	);

	// Opening a Project home (folder +) is navigation too — same dismissal
	// policy as a session pick.
	const handleOpenProject = useCallback(
		(projectId: string) => {
			onOpenProject(projectId);
			dismissAfterPick();
		},
		[onOpenProject, dismissAfterPick],
	);

	const handleCloseSession = useCallback(
		(session: SessionInfo) => {
			onCloseSession(session.projectId, session.stem);
		},
		[onCloseSession],
	);

	// All-projects leaves the current Project: detach, and the fullscreen
	// overlay backs off (desktop → rail; mobile has nothing to dismiss from
	// hidden mode).
	const handleShowLauncher = useCallback(() => {
		onShowLauncher();
		if (!isWide || mode === "fullscreen") dismissOverlay();
	}, [onShowLauncher, isWide, mode, dismissOverlay]);

	const sidebarContent = (
		<SidebarContent
			projects={projects}
			currentProjectId={currentProjectId}
			currentStem={currentStem}
			activeSessions={activeSessions}
			sessionPages={sessionPages}
			folds={folds}
			onToggleAllFolders={cycleAllFolders}
			onToggleFolder={cycleFolder}
			onOpenSession={handleOpenSession}
			onOpenProject={handleOpenProject}
			onCloseSession={handleCloseSession}
			onShowLauncher={handleShowLauncher}
			onLoadFolder={onLoadFolder}
			onLoadMoreFolder={onLoadMoreFolder}
		/>
	);

	// Pure overlay above the whole shell (TopBar included): the conversation
	// keeps its full width — --sidebar-w stays 0. Used both for the real
	// fullscreen mode and, rendered inside the desktop fragment, for the
	// live max-overshoot drag preview — the snap-in is the honest feedback
	// for crossing the threshold.
	const fullscreenPane = (
		<div className={styles.sidebarFullscreen}>
			<div className={styles.overlayHeader}>
				<button
					type="button"
					className={styles.sidebarAddBtn}
					onClick={dismissOverlay}
					aria-label="Close sidebar"
					title="Close (Esc)"
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
			</div>
			{sidebarContent}
		</div>
	);

	if (mode === "fullscreen") {
		return fullscreenPane;
	}

	if (isWide) {
		return (
			<>
				{/* Max-overshoot preview: the fullscreen overlay snaps in
				    mid-drag. It MUST render inside this fragment — an early
				    return would unmount the ResizeHandle, silently releasing
				    the drag's pointer capture (stuck overlay + stuck
				    pane-resizing cursor). The handle stays mounted beneath
				    the overlay and keeps receiving the drag's moves. */}
				{dragPreview === "max" && fullscreenPane}
				{/* Hover-peek drawer: same content as the rail, overlaid below
				    the TopBar hamburger. Hides (grace-delayed) when the pointer
				    leaves the hamburger or the drawer. */}
				{mode === "hidden" && peekOpen && (
					<nav
						ref={peekDrawerRef}
						className={styles.sidebarPeek}
						style={{ width: resize.width }}
						onMouseEnter={() => showPeek(true)}
						onMouseLeave={() => showPeek(false)}
					>
						{/* Overlay toggle row: the hamburger at its TopBar position.
					    Clicking it pins the rail open — the same corner toggle as
					    everywhere else, and the escape hatch from hover-only. */}
						<div className={styles.overlayHeader}>
							<button
								type="button"
								className={styles.sidebarAddBtn}
								onClick={() => setMode("rail")}
								aria-label="Open sidebar"
								title="Open sidebar"
							>
								<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
									<rect x="3" y="6" width="18" height="2" />
									<rect x="3" y="11" width="18" height="2" />
									<rect x="3" y="16" width="18" height="2" />
								</svg>
							</button>
						</div>
						{sidebarContent}
					</nav>
				)}
				{/* Edge-reveal strip: drag from the left edge to open + resize
				    the rail. Pointer-only affordance — keyboard users have the
				    TopBar hamburger. Skipped while the peek drawer is open so its
				    resize cursor doesn't sit on the drawer's left edge; kept
				    mounted during its own drag (revealDragging) because its
				    pointerdown flips the mode to "rail" — unmounting would
				    silently release the pointer capture mid-gesture. */}
				{((mode === "hidden" && !peekOpen) || reveal.revealDragging) && (
					<div
						className={styles.sidebarRevealStrip}
						aria-hidden="true"
						title="Drag to open sidebar"
						onPointerDown={reveal.onPointerDown}
						onPointerMove={reveal.onPointerMove}
						onPointerUp={reveal.onPointerEnd}
						onPointerCancel={reveal.onPointerEnd}
					/>
				)}
				{/* The rail. Unmounted during either overshoot preview — a min
				    preview snaps it shut for real (pane and gutter disappear
				    together); a max preview replaces it with the fullscreen
				    overlay, so the folder tree renders once. */}
				{mode === "rail" && dragPreview === null && (
					<div className={styles.sidebar} style={{ width: resize.width }}>
						{/* Corner toggle: the same (12, 6) box as the TopBar hamburger
						    and the peek drawer's pin button. The rail previously had
						    nothing there — pinning from the peek drawer removed the
						    only click target, breaking the same-corner-toggles
						    invariant. ✕ matches the fullscreen overlay: an open
						    sidebar closes; only the transient peek shows the
						    hamburger. */}
						<div className={styles.overlayHeader}>
							<button
								type="button"
								className={styles.sidebarAddBtn}
								onClick={() => setMode("hidden")}
								aria-label="Hide sidebar"
								title="Hide sidebar"
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
						</div>
						{sidebarContent}
					</div>
				)}
				{/* The handle is a fixed-position sibling (not a child) so the
				    pane's overflow: hidden can't clip it; it centers on the pane
				    border. Stays mounted through both overshoot previews — it
				    owns the drag's pointer capture, even under the fullscreen
				    overlay of a max preview (pointer capture ignores hit-testing). */}
				{mode === "rail" && (
					<ResizeHandle
						controller={resize}
						edge="right"
						label="Resize sidebar"
						onOvershoot={handleOvershoot}
						onOvershootChange={handleOvershootPreview}
					/>
				)}
			</>
		);
	}

	return null;
});

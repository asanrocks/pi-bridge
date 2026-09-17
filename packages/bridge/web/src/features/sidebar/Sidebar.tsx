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
// A folder tree: each Project (static allowlisted cwd configuration) is a
// foldable folder; its sessions are the leaves. Active sessions pin below the folder
// row from the global snapshot (the authority for live state) and stay
// visible regardless of the fold — folding hides only the lazily fetched
// history. Desktop rail visibility persists in localStorage, independent of
// the rail's width (the resize controller's own persistence).
//
// Selection model: the Project header navigates — clicking the name opens
// the Project's home (the compose surface); the chevron beside it is the
// fold toggle, nothing else. Selection lives only on session rows: exactly
// one row (the attached (projectId, stem)) wears the accent tint; the
// folder shows accent text solely at a Project home, where nothing is
// selected.
// ============================================================================

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo, SessionInfo } from "../../../../src/core/index.ts";
import type { SessionFolderPage } from "../../infra/store.ts";
import { useMediaQuery } from "../../infra/useMediaQuery.ts";
import { ResizeHandle, usePaneResize } from "../../render/ResizeHandle.tsx";
import styles from "./Sidebar.module.css";
import { groupSessions, relativeTime } from "./timeUtils.ts";

const SIDEBAR_BREAKPOINT = "(min-width: 768px)";

/** Sidebar display mode. `rail` (docked, resizable column) is desktop-only;
 *  mobile offers just hidden / fullscreen. */
export type SidebarMode = "hidden" | "rail" | "fullscreen";

const LS_KEY = "pi-bridge:sidebar-open";
const LS_FOLDERS_KEY = "pi-bridge:sidebar-folders";

/** Grace delay before an un-hovered peek drawer hides, so the pointer can
 *  cross the hamburger → drawer gap without a flicker. */
const PEEK_CLOSE_MS = 200;

/* Desktop width bounds for the resizable rail. Default matches the
   historical fixed width; min keeps section headers + rows readable,
   max keeps a usable conversation column (also viewport-capped at 45%). */
const SIDEBAR_DEFAULT_W = 220;
const SIDEBAR_MIN_W = 180;
const SIDEBAR_MAX_W = 360;

/** Stable empty array so memoized folders without active rows don't churn. */
const NO_SESSIONS: SessionInfo[] = [];

// ---------------------------------------------------------------------------
// SessionRow — one leaf: liveness dot + label + relative time.
// ---------------------------------------------------------------------------

const SessionRow = memo(function SessionRow({
	session,
	dot,
	selected,
	onOpen,
	onClose,
}: {
	session: SessionInfo;
	/** Green = active, orange + pulse = streaming, muted = dormant history. */
	dot: "active" | "streaming" | "idle";
	/** Attached session ("you are here"): the one row wearing the accent
	 * tint. Matched on (projectId, stem) — rows always carry stems, so no
	 * sessionId fallback is needed. */
	selected?: boolean;
	onOpen: (session: SessionInfo) => void;
	/** Present only on rows with a live instance (the pinned active section):
	 * opens the row menu whose Close item terminates it. No confirmation —
	 * the kill is the point. */
	onClose?: (session: SessionInfo) => void;
}) {
	const label = (session.name || session.firstMessageText || session.stem) ?? "";
	const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
	const dotCls = [
		styles.sidebarLiveDot,
		dot === "streaming" ? styles.sidebarLiveDotStreaming : dot === "idle" ? styles.sidebarDotIdle : "",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<div className={styles.sidebarItemWrap}>
			<button
				type="button"
				className={[styles.sidebarItem, selected ? styles.sidebarItemSelected : ""].filter(Boolean).join(" ")}
				onClick={() => onOpen(session)}
				title={label}
				aria-current={selected ? "page" : undefined}
			>
				<span className={dotCls} aria-hidden="true" />
				<span className={styles.sidebarItemRow}>
					<span className={styles.sidebarItemName}>{label.slice(0, 60)}</span>
					<span className={styles.sidebarItemTime}>{relativeTime(session.timestamp)}</span>
				</span>
			</button>
			{onClose && (
				<button
					type="button"
					className={styles.sidebarMenuBtn}
					aria-label="Session menu"
					aria-haspopup="menu"
					aria-expanded={menuAnchor !== null}
					onClick={(e) => {
						e.stopPropagation();
						setMenuAnchor(e.currentTarget.getBoundingClientRect());
					}}
				>
					<svg
						viewBox="0 0 16 16"
						width="14"
						height="14"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
					</svg>
				</button>
			)}
			{menuAnchor && (
				<>
					<button
						type="button"
						aria-label="Close menu"
						className={styles.portalOverlay}
						onClick={() => setMenuAnchor(null)}
					/>
					<div
						className={styles.cwdPopover}
						style={{
							position: "fixed",
							top: menuAnchor.bottom + 4,
							left: Math.max(8, Math.min(menuAnchor.right - 130, window.innerWidth - 130 - 8)),
							width: 130,
						}}
					>
						<button
							type="button"
							className={styles.sidebarMenuClose}
							onClick={() => {
								setMenuAnchor(null);
								onClose?.(session);
							}}
						>
							Close
						</button>
					</div>
				</>
			)}
		</div>
	);
});

// ---------------------------------------------------------------------------
// ProjectFolder — one branch: foldable Project row + its session leaves.
// ---------------------------------------------------------------------------

const ProjectFolder = memo(function ProjectFolder({
	project,
	currentProjectId,
	currentStem,
	expanded,
	activeRows,
	page,
	onToggle,
	onOpenProject,
	onOpen,
	onClose,
	onLoad,
	onLoadMore,
}: {
	project: ProjectInfo;
	/** The attached (projectId, stem) pair — session-row selection input. */
	currentProjectId: string | null;
	currentStem: string | null;
	expanded: boolean;
	/** Active sessions from the global snapshot, pinned below the folder row
	 * and always visible — the fold hides only the history. */
	activeRows: SessionInfo[];
	page: SessionFolderPage | undefined;
	onToggle: (projectId: string) => void;
	/** Navigate to the Project's home (the compose surface). The folder name
	 * is a navigation target; the chevron is the fold toggle. */
	onOpenProject: (projectId: string) => void;
	onOpen: (session: SessionInfo) => void;
	/** Terminate a live instance (row menu Close). Passed only to the pinned
	 * active rows — dormant history has no instance to kill. */
	onClose: (session: SessionInfo) => void;
	onLoad: (projectId: string) => void;
	onLoadMore: (projectId: string) => void;
}) {
	// Lazy first page: fetch on expand when no page is cached. Re-fires after
	// a reconnect reset (sessionPages cleared → undefined again).
	useEffect(() => {
		if (expanded && page === undefined) onLoad(project.id);
	}, [expanded, page, project.id, onLoad]);

	const activeIds = useMemo(() => new Set(activeRows.map((r) => r.sessionId)), [activeRows]);
	// The active snapshot is the authority (ADR 11): snapshot rows render in
	// the pinned section; a scanned row claiming activity but absent from the
	// snapshot renders as dormant history.
	const history = useMemo(
		() => (page?.kind === "ready" ? page.sessions.filter((s) => !activeIds.has(s.sessionId)) : []),
		[page, activeIds],
	);
	const groups = useMemo(() => groupSessions(history), [history]);

	// Disclosure header, not a selection target: accent text only at a
	// Project home (browsed without an attached session) — folder-exclusive
	// chrome that cannot be misread as row selection.
	const isHome = currentProjectId === project.id && currentStem === null;
	const rowCls = [styles.sidebarFolderRow, isHome ? styles.sidebarFolderCurrent : ""].filter(Boolean).join(" ");
	const isSelected = (s: SessionInfo) => s.projectId === currentProjectId && s.stem === currentStem;

	return (
		<div>
			{/* Row group: the chevron toggles the fold; the name navigates to
			    the Project home (the compose surface). Two buttons, not one —
			    a nested button is invalid HTML, and a combined click
			    (navigate + toggle) would collapse the folder exactly when
			    you browse away. */}
			<div className={styles.sidebarFolderRowGroup}>
				<button
					type="button"
					className={styles.sidebarFolderToggle}
					onClick={() => onToggle(project.id)}
					aria-expanded={expanded}
					aria-label={expanded ? `Collapse ${project.id}` : `Expand ${project.id}`}
				>
					<svg
						viewBox="0 0 16 16"
						width="12"
						height="12"
						className={expanded ? styles.sidebarChevronOpen : styles.sidebarChevron}
						fill="currentColor"
						aria-hidden="true"
					>
						<path d="M6 3l5 5-5 5z" />
					</svg>
				</button>
				<button type="button" className={rowCls} onClick={() => onOpenProject(project.id)} title={project.cwd}>
					<span className={styles.sidebarItemName}>{project.id}</span>
				</button>
			</div>
			{/* Pinned active sessions: always visible — folding hides only the
			    history. The live dot is the signal; no other chrome. */}
			<div className={styles.sidebarFolderChildren}>
				{activeRows.map((s) => (
					<SessionRow
						key={s.sessionId}
						session={s}
						dot={s.isStreaming ? "streaming" : "active"}
						selected={isSelected(s)}
						onOpen={onOpen}
						onClose={onClose}
					/>
				))}
			</div>
			{expanded && (
				<div className={styles.sidebarFolderChildren}>
					{(page === undefined || page.kind === "loading") && (
						<div className={styles.sidebarFolderMsg}>Loading…</div>
					)}
					{page?.kind === "error" && (
						<button type="button" className={styles.sidebarFolderRetry} onClick={() => onLoad(project.id)}>
							Load failed — retry
						</button>
					)}
					{page?.kind === "ready" && history.length === 0 && activeRows.length === 0 && (
						<div className={styles.sidebarFolderMsg}>No sessions yet</div>
					)}
					{page?.kind === "ready" &&
						groups.map((group) => (
							<div key={group.label}>
								{/* Always labeled: a lone bucket still needs its header to
								 * distinguish history rows from the pinned section above. */}
								<div className={styles.sidebarGroupHeader}>{group.label}</div>
								{group.items.map((s) => (
									<SessionRow
										key={`${s.projectId}/${s.stem}`}
										session={s}
										dot="idle"
										selected={isSelected(s)}
										onOpen={onOpen}
									/>
								))}
							</div>
						))}
					{page?.kind === "ready" && page.hasMore && (
						<button type="button" className={styles.sidebarLoadMore} onClick={() => onLoadMore(project.id)}>
							Load more
						</button>
					)}
				</div>
			)}
		</div>
	);
});

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

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

	const [mode, setMode] = useState<SidebarMode>(() => {
		if (isWide) {
			try {
				const stored = localStorage.getItem(LS_KEY);
				if (stored !== null) return stored === "true" ? "rail" : "hidden";
			} catch {
				/* ignore */
			}
			return "rail";
		}
		return "hidden";
	});

	// ── Folder expansion (persisted). The current Project always auto-expands
	// (the effect adds, never removes — manual collapse stays respected).
	const [expanded, setExpanded] = useState<Set<string>>(() => {
		try {
			const stored = localStorage.getItem(LS_FOLDERS_KEY);
			if (stored !== null) return new Set(JSON.parse(stored) as string[]);
		} catch {
			/* ignore */
		}
		return new Set();
	});
	// Landing on a Project's home (no session attached) opens its folder — the
	// browse-this-project stance. The same holds at boot for a session URL: the
	// first non-null current Project expands even when a stem is attached —
	// first-paint context, unlike a live session switch, where unfolding is
	// noise (a pinned row is already visible regardless of folding). Adds,
	// never removes — manual collapse stays respected.
	const didBootExpandRef = useRef(false);
	useEffect(() => {
		if (currentProjectId === null) return;
		const isBoot = !didBootExpandRef.current;
		didBootExpandRef.current = true;
		if (!isBoot && currentStem !== null) return;
		setExpanded((s) => (s.has(currentProjectId) ? s : new Set(s).add(currentProjectId)));
	}, [currentProjectId, currentStem]);
	const toggleFolder = useCallback((projectId: string) => {
		setExpanded((s) => {
			const next = new Set(s);
			if (next.has(projectId)) next.delete(projectId);
			else next.add(projectId);
			return next;
		});
	}, []);
	useEffect(() => {
		try {
			localStorage.setItem(LS_FOLDERS_KEY, JSON.stringify([...expanded]));
		} catch {
			/* ignore */
		}
	}, [expanded]);

	// Alt+N with several Projects: ensure the sidebar is open so its project
	// list is reachable (a session is started from a Project's home prompt).
	useEffect(() => {
		newSessionRef.current = () => {
			if (mode === "hidden") setMode(isWide ? "rail" : "fullscreen");
		};
	}, [mode, isWide, newSessionRef]);

	// Mobile has no rail: crossing to narrow collapses a rail to hidden
	// (hidden/fullscreen stay valid). Crossing back to wide preserves the
	// mode — a deliberately hidden sidebar must not reopen on breakpoint
	// changes.
	useEffect(() => {
		if (!isWide) setMode((m) => (m === "rail" ? "hidden" : m));
	}, [isWide]);
	useEffect(() => {
		toggleRef.current = () => {
			setMode((m) => {
				// Desktop: hidden ↔ rail; fullscreen backs off to the rail (the
				// toggle dismisses the overlay). Mobile: hidden ↔ fullscreen.
				if (isWide) return m === "hidden" ? "rail" : m === "rail" ? "hidden" : "rail";
				return m === "hidden" ? "fullscreen" : "hidden";
			});
		};
	}, [isWide, toggleRef]);
	// Desktop rail visibility only — fullscreen is transient, and a mobile
	// session must not leak its fullscreen into the desktop preference.
	useEffect(() => {
		try {
			if (isWide) localStorage.setItem(LS_KEY, String(mode !== "hidden"));
		} catch {
			/* ignore */
		}
	}, [mode, isWide]);
	useEffect(() => {
		onModeChange?.(mode);
	}, [mode, onModeChange]);

	// Fullscreen dismissal: close button, Esc, session open, All-projects.
	// Desktop returns to the rail (the mode it was dragged from); mobile
	// returns to hidden (its only other mode).
	const dismissOverlay = useCallback(() => {
		setMode((m) => (m === "fullscreen" ? (isWide ? "rail" : "hidden") : m));
	}, [isWide]);
	useEffect(() => {
		if (mode !== "fullscreen") return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") dismissOverlay();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [mode, dismissOverlay]);

	// ── Hover-peek drawer (desktop, hidden mode): same content as the rail,
	// a full-height overlay above the TopBar (it covers the hamburger too)
	// while the pointer is over the hamburger or the drawer. Shown
	// immediately; hidden on a grace delay. The delay exists because the
	// drawer mounts directly over the hamburger, so the hamburger's
	// mouseleave fires while the pointer hasn't moved at all — and the
	// ordering of that leave vs the drawer's mouseenter is not something we
	// can rely on. So the hide never trusts events alone: when the timer
	// fires it asks the browser where the pointer is (:hover) and keeps the
	// drawer if it's still over it. Any mode change cancels it outright.
	const [peekOpen, setPeekOpen] = useState(false);
	const peekTimerRef = useRef<number | undefined>(undefined);
	const peekDrawerRef = useRef<HTMLElement | null>(null);
	const showPeek = useCallback((show: boolean) => {
		if (peekTimerRef.current !== undefined) {
			window.clearTimeout(peekTimerRef.current);
			peekTimerRef.current = undefined;
		}
		if (show) setPeekOpen(true);
		else
			peekTimerRef.current = window.setTimeout(() => {
				peekTimerRef.current = undefined;
				if (!peekDrawerRef.current?.matches(":hover")) setPeekOpen(false);
			}, PEEK_CLOSE_MS);
	}, []);
	useEffect(() => {
		showPeek(hamburgerHover);
	}, [hamburgerHover, showPeek]);
	useEffect(() => {
		if (mode !== "hidden") {
			if (peekTimerRef.current !== undefined) {
				window.clearTimeout(peekTimerRef.current);
				peekTimerRef.current = undefined;
			}
			setPeekOpen(false);
		}
	}, [mode]);
	useEffect(
		() => () => {
			if (peekTimerRef.current !== undefined) window.clearTimeout(peekTimerRef.current);
		},
		[],
	);

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

	// Drag overshoot release on the rail's resize handle: below min hides,
	// above max fullscreens. The handle restores the pre-drag width first
	// (both directions), so backing out of either state is an undo.
	const handleOvershoot = useCallback((dir: "min" | "max") => {
		setMode(dir === "min" ? "hidden" : "fullscreen");
	}, []);

	// Edge-reveal strip (desktop, hidden): pointer-absolute drag — the
	// implied width is the pointer's x position (the bar's right edge chases
	// the pointer), and the rail appears only once that width exceeds min;
	// before that the drag previews closed, same snap semantics as the rail's
	// handle. A release below min keeps it hidden with the pre-drag stored
	// width restored. revealDragging keeps the strip mounted for the whole
	// gesture: its pointerdown flips mode to "rail", and unmounting the
	// strip would silently release the capture mid-drag.
	const [revealDragging, setRevealDragging] = useState(false);
	// Watchdog: the strip adds pane-resizing on pointerdown and normally
	// removes it on pointerup — but if it unmounts mid-drag (breakpoint
	// crossing), clear it whenever no reveal drag is active. Idempotent.
	useEffect(() => {
		if (!revealDragging) document.documentElement.classList.remove("pane-resizing");
	}, [revealDragging]);
	const revealBaseWidth = useRef<number | null>(null);
	const revealOnPointerDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.currentTarget.setPointerCapture(e.pointerId);
			revealBaseWidth.current = resize.width;
			setRevealDragging(true);
			setMode("rail");
			// At the far-left edge the implied width is already below min — start
			// snapped shut so the rail is never shown more eagerly than the drag.
			setDragPreview(e.clientX < resize.min ? "min" : null);
			document.documentElement.classList.add("pane-resizing");
		},
		[resize],
	);
	const revealOnPointerMove = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (revealBaseWidth.current === null || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
			const raw = e.clientX;
			resize.setWidth(raw);
			setDragPreview(raw < resize.min ? "min" : null);
		},
		[resize],
	);
	const revealOnPointerEnd = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
			const base = revealBaseWidth.current;
			revealBaseWidth.current = null;
			e.currentTarget.releasePointerCapture(e.pointerId);
			document.documentElement.classList.remove("pane-resizing");
			setRevealDragging(false);
			setDragPreview(null);
			if (base === null) return;
			// Release decides on the pointer's position (exact even if the last
			// pointermove's state update hasn't flushed): below min → hide with
			// the pre-drag stored width restored; at/above → commit the dragged
			// width.
			if (e.clientX < resize.min) {
				resize.setWidth(base);
				setMode("hidden");
			} else {
				resize.commitCurrent();
			}
		},
		[resize],
	);

	// Opening a session is an attach (ADR 11): the daemon resolves-or-creates
	// the activation and rebinds this connection — no isBusy guard, the old
	// attachment keeps streaming headless.
	const handleOpenSession = useCallback(
		(session: SessionInfo) => {
			// Passing the id lets the client seed a cache cursor (ADR 09) instead
			// of falling back to a full replace on every UI session switch.
			onOpenSession(session.projectId, session.stem, session.sessionId);
			// Selection dismisses overlays: mobile fullscreen and the desktop
			// peek drawer close outright; desktop fullscreen backs off to the
			// rail so the picked conversation is visible.
			if (!isWide) setMode("hidden");
			else if (mode === "fullscreen") setMode("rail");
			else if (peekOpen || peekTimerRef.current !== undefined) {
				if (peekTimerRef.current !== undefined) {
					window.clearTimeout(peekTimerRef.current);
					peekTimerRef.current = undefined;
				}
				setPeekOpen(false);
			}
		},
		[isWide, mode, onOpenSession, peekOpen],
	);

	const handleCloseSession = useCallback(
		(session: SessionInfo) => {
			onCloseSession(session.projectId, session.stem);
		},
		[onCloseSession],
	);

	const activeByProject = useMemo(() => {
		const map = new Map<string, SessionInfo[]>();
		for (const s of activeSessions) {
			const arr = map.get(s.projectId);
			if (arr) arr.push(s);
			else map.set(s.projectId, [s]);
		}
		return map;
	}, [activeSessions]);

	const sidebarContent = (
		<>
			<div className={styles.sidebarSectionHeader}>
				<span>Projects</span>
				<span className={styles.headerActions}>
					{/* Back to the global project picker. Hidden while already there. */}
					{currentProjectId !== null && (
						<button
							type="button"
							className={styles.sidebarAddBtn}
							onClick={() => {
								onShowLauncher();
								if (!isWide || mode === "fullscreen") dismissOverlay();
							}}
							title="All projects"
							aria-label="All projects"
						>
							<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true">
								<path d="M3.5 3.5a1 1 0 011-1h3.5a1 1 0 011 1V7a1 1 0 01-1 1H4.5a1 1 0 01-1-1V3.5zm7.5 0a1 1 0 011-1h3.5a1 1 0 011 1V7a1 1 0 01-1 1H12a1 1 0 01-1-1V3.5zM3.5 11a1 1 0 011-1H8a1 1 0 011 1v3.5a1 1 0 01-1 1H4.5a1 1 0 01-1-1V11zm7.5 0a1 1 0 011-1h3.5a1 1 0 011 1v3.5a1 1 0 01-1 1H12a1 1 0 01-1-1V11z" />
							</svg>
						</button>
					)}
				</span>
			</div>
			{projects.length === 0 && <div className={styles.sidebarEmpty}>No projects configured</div>}
			<div className={styles.sidebarList}>
				{projects.map((project) => (
					<ProjectFolder
						key={project.id}
						project={project}
						currentProjectId={currentProjectId}
						currentStem={currentStem}
						expanded={expanded.has(project.id)}
						activeRows={activeByProject.get(project.id) ?? NO_SESSIONS}
						page={sessionPages[project.id]}
						onToggle={toggleFolder}
						onOpenProject={onOpenProject}
						onOpen={handleOpenSession}
						onClose={handleCloseSession}
						onLoad={onLoadFolder}
						onLoadMore={onLoadMoreFolder}
					/>
				))}
			</div>
		</>
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
				{((mode === "hidden" && !peekOpen) || revealDragging) && (
					<div
						className={styles.sidebarRevealStrip}
						aria-hidden="true"
						title="Drag to open sidebar"
						onPointerDown={revealOnPointerDown}
						onPointerMove={revealOnPointerMove}
						onPointerUp={revealOnPointerEnd}
						onPointerCancel={revealOnPointerEnd}
					/>
				)}
				{/* The rail. Unmounted during either overshoot preview — a min
				    preview snaps it shut for real (pane and gutter disappear
				    together); a max preview replaces it with the fullscreen
				    overlay, so the folder tree renders once. */}
				{mode === "rail" && dragPreview === null && (
					<div className={styles.sidebar} style={{ width: resize.width }}>
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

// ============================================================================
// Sidebar — dual-mode collapsible panel (ADR 11). A folder tree: each Project
// (static allowlisted cwd configuration) is a foldable folder; its sessions
// are the leaves. Active sessions pin below the folder row from the global
// snapshot (the authority for live state) and stay visible regardless of the
// fold — folding hides only the lazily fetched history. Inline column
// ≥768px, slide-in overlay below. Open/close and folder expansion persist in
// localStorage.
// ============================================================================

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo, SessionInfo } from "../../../../src/core/index.ts";
import type { SessionFolderPage } from "../../infra/store.ts";
import { useMediaQuery } from "../../infra/useMediaQuery.ts";
import { ResizeHandle, usePaneResize } from "../../render/ResizeHandle.tsx";
import styles from "./Sidebar.module.css";
import { groupSessions, relativeTime } from "./timeUtils.ts";

const SIDEBAR_BREAKPOINT = "(min-width: 768px)";
const LS_KEY = "pi-bridge:sidebar-open";
const LS_FOLDERS_KEY = "pi-bridge:sidebar-folders";

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
	onOpen,
	onClose,
}: {
	session: SessionInfo;
	/** Green = active, orange + pulse = streaming, muted = dormant history. */
	dot: "active" | "streaming" | "idle";
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
			<button type="button" className={styles.sidebarItem} onClick={() => onOpen(session)} title={label}>
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
	isCurrent,
	expanded,
	activeRows,
	page,
	onToggle,
	onOpen,
	onClose,
	onLoad,
	onLoadMore,
}: {
	project: ProjectInfo;
	isCurrent: boolean;
	expanded: boolean;
	/** Active sessions from the global snapshot, pinned below the folder row
	 * and always visible — the fold hides only the history. */
	activeRows: SessionInfo[];
	page: SessionFolderPage | undefined;
	onToggle: (projectId: string) => void;
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

	const rowCls = [styles.sidebarFolderRow, isCurrent ? styles.sidebarItemActive : ""].filter(Boolean).join(" ");

	return (
		<div>
			<button
				type="button"
				className={rowCls}
				onClick={() => onToggle(project.id)}
				title={project.cwd}
				aria-expanded={expanded}
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
				<span className={styles.sidebarItemName}>{project.id}</span>
			</button>
			{/* Pinned active sessions: always visible — folding hides only the
			    history. The live dot is the signal; no other chrome. */}
			<div className={styles.sidebarFolderChildren}>
				{activeRows.map((s) => (
					<SessionRow
						key={s.sessionId}
						session={s}
						dot={s.isStreaming ? "streaming" : "active"}
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
									<SessionRow key={`${s.projectId}/${s.stem}`} session={s} dot="idle" onOpen={onOpen} />
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
	onNewSession,
	onCloseSession,
	onShowLauncher,
	onLoadFolder,
	onLoadMoreFolder,
	toggleRef,
	newSessionRef,
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
	onNewSession: (projectId: string) => void;
	/** Terminate a session's live instance (row menu Close, no confirmation). */
	onCloseSession: (projectId: string, stem: string) => void;
	/** Detach and return to the Launcher (global project picker). */
	onShowLauncher: () => void;
	onLoadFolder: (projectId: string) => void;
	onLoadMoreFolder: (projectId: string) => void;
	toggleRef: React.MutableRefObject<() => void>;
	/** Imperative new-session trigger populated by the Sidebar. Alt+N calls
	    this: with one project it starts directly; with several it opens the
	    sidebar (if closed) and surfaces the project picker the [+] owns. */
	newSessionRef: React.MutableRefObject<() => void>;
}) {
	const isWide = useMediaQuery(SIDEBAR_BREAKPOINT);

	const [open, setOpen] = useState(() => {
		try {
			const stored = localStorage.getItem(LS_KEY);
			if (stored !== null) return stored === "true";
		} catch {
			/* ignore */
		}
		return isWide;
	});
	const [projectPopoverAnchor, setProjectPopoverAnchor] = useState<DOMRect | null>(null);
	const newSessionBtnRef = useRef<HTMLButtonElement>(null);
	// Set by Alt+N when the sidebar is closed: open() renders the [+] button,
	// then the pending effect below triggers the new-session flow once it's
	// mounted. Avoids a detached popover anchored to a non-existent button.
	const [pendingNewSession, setPendingNewSession] = useState(false);

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

	const triggerNewSession = useCallback(() => {
		if (projects.length === 1) {
			onNewSession(projects[0].id);
		} else if (projects.length > 1) {
			setProjectPopoverAnchor(newSessionBtnRef.current?.getBoundingClientRect() ?? null);
		}
	}, [projects, onNewSession]);

	useEffect(() => {
		newSessionRef.current = () => {
			if (open) {
				triggerNewSession();
			} else {
				setOpen(true);
				setPendingNewSession(true);
			}
		};
	}, [open, triggerNewSession, newSessionRef]);

	// After opening, trigger the deferred new-session once the [+] button
	// has mounted (the desktop/mobile panels return null when !open).
	useEffect(() => {
		if (pendingNewSession && open && newSessionBtnRef.current) {
			setPendingNewSession(false);
			triggerNewSession();
		}
	}, [pendingNewSession, open, triggerNewSession]);

	useEffect(() => {
		setOpen(isWide);
	}, [isWide]);
	useEffect(() => {
		toggleRef.current = () => setOpen((v) => !v);
	}, [toggleRef]);
	useEffect(() => {
		localStorage.setItem(LS_KEY, String(open));
	}, [open]);

	// Resizable rail (desktop): owns the width, persists it, and publishes
	// --sidebar-w so .body and the TopBar clear the gutter. useLayoutEffect
	// inside the hook runs before paint (no one-frame flash); 0 when closed
	// or on mobile (overlay drawer, off-canvas).
	const resize = usePaneResize({
		cssVar: "--sidebar-w",
		storageKey: "pi-bridge:sidebar-w",
		defaultWidth: SIDEBAR_DEFAULT_W,
		min: SIDEBAR_MIN_W,
		max: SIDEBAR_MAX_W,
		active: isWide && open,
	});

	const panelRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (isWide || !open) return;
		const handler = (e: MouseEvent) => {
			if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		const id = setTimeout(() => document.addEventListener("click", handler), 0);
		return () => {
			clearTimeout(id);
			document.removeEventListener("click", handler);
		};
	}, [isWide, open]);

	// Opening a session is an attach (ADR 11): the daemon resolves-or-creates
	// the activation and rebinds this connection — no isBusy guard, the old
	// attachment keeps streaming headless.
	const handleOpenSession = useCallback(
		(session: SessionInfo) => {
			// Passing the id lets the client seed a cache cursor (ADR 09) instead
			// of falling back to a full replace on every UI session switch.
			onOpenSession(session.projectId, session.stem, session.sessionId);
			if (!isWide) setOpen(false);
		},
		[isWide, onOpenSession],
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
								if (!isWide) setOpen(false);
							}}
							title="All projects"
							aria-label="All projects"
						>
							<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true">
								<path d="M3.5 3.5a1 1 0 011-1h3.5a1 1 0 011 1V7a1 1 0 01-1 1H4.5a1 1 0 01-1-1V3.5zm7.5 0a1 1 0 011-1h3.5a1 1 0 011 1V7a1 1 0 01-1 1H12a1 1 0 01-1-1V3.5zM3.5 11a1 1 0 011-1H8a1 1 0 011 1v3.5a1 1 0 01-1 1H4.5a1 1 0 01-1-1V11zm7.5 0a1 1 0 011-1h3.5a1 1 0 011 1v3.5a1 1 0 01-1 1H12a1 1 0 01-1-1V11z" />
							</svg>
						</button>
					)}
					<button
						ref={newSessionBtnRef}
						type="button"
						className={styles.sidebarAddBtn}
						onClick={triggerNewSession}
						disabled={projects.length === 0}
						title="New session"
						aria-label="New session"
					>
						+
					</button>
				</span>
			</div>
			{projectPopoverAnchor && projects.length > 1 && (
				<>
					<button
						type="button"
						aria-label="Close project picker"
						className={styles.portalOverlay}
						onClick={() => setProjectPopoverAnchor(null)}
					/>
					<div
						className={styles.cwdPopover}
						style={{
							position: "fixed",
							top: projectPopoverAnchor.bottom + 4,
							left: Math.max(8, Math.min(projectPopoverAnchor.left, window.innerWidth - 240 - 8)),
							width: 240,
						}}
					>
						{projects.map((project) => (
							<button
								type="button"
								key={project.id}
								className={styles.cwdPopoverItem}
								onClick={() => {
									setProjectPopoverAnchor(null);
									onNewSession(project.id);
								}}
								title={project.cwd}
							>
								{project.id}
							</button>
						))}
					</div>
				</>
			)}
			{projects.length === 0 && <div className={styles.sidebarEmpty}>No projects configured</div>}
			<div className={styles.sidebarList}>
				{projects.map((project) => (
					<ProjectFolder
						key={project.id}
						project={project}
						isCurrent={project.id === currentProjectId}
						expanded={expanded.has(project.id)}
						activeRows={activeByProject.get(project.id) ?? NO_SESSIONS}
						page={sessionPages[project.id]}
						onToggle={toggleFolder}
						onOpen={handleOpenSession}
						onClose={handleCloseSession}
						onLoad={onLoadFolder}
						onLoadMore={onLoadMoreFolder}
					/>
				))}
			</div>
		</>
	);

	if (isWide) {
		if (!open) return null;
		// The handle is a fixed-position sibling (not a child) so the pane's
		// overflow: hidden can't clip it; it centers on the pane border.
		return (
			<>
				<div className={styles.sidebar} style={{ width: resize.width }}>
					{sidebarContent}
				</div>
				<ResizeHandle controller={resize} edge="right" label="Resize sidebar" />
			</>
		);
	}

	if (!open) return null;
	return (
		<>
			<button
				type="button"
				className={styles.sidebarBackdrop}
				onClick={() => setOpen(false)}
				aria-label="Close sidebar"
			/>
			<div className={styles.sidebarOverlay} ref={panelRef}>
				{sidebarContent}
			</div>
		</>
	);
});

// ============================================================================
// Sidebar — dual-mode collapsible panel (ADR 11). Two sections: Projects
// (static allowlisted cwd configuration) above, Sessions (the current
// Project's history) below. Inline column ≥768px, slide-in overlay below.
// Open/close persists in localStorage.
// ============================================================================

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo } from "../../../../src/core/index.ts";
import { useMediaQuery } from "../../infra/useMediaQuery.ts";
import { ResizeHandle, usePaneResize } from "../../render/ResizeHandle.tsx";
import styles from "./Sidebar.module.css";
import { groupSessions, relativeTime, type SidebarSession } from "./timeUtils.ts";

const SIDEBAR_BREAKPOINT = "(min-width: 768px)";
const LS_KEY = "pi-bridge:sidebar-open";

/* Desktop width bounds for the resizable rail. Default matches the
   historical fixed width; min keeps section headers + rows readable,
   max keeps a usable conversation column (also viewport-capped at 45%). */
const SIDEBAR_DEFAULT_W = 220;
const SIDEBAR_MIN_W = 180;
const SIDEBAR_MAX_W = 360;

export const Sidebar = memo(function Sidebar({
	projects,
	currentProjectId,
	sessions,
	isBusy,
	sessionsHasMore,
	onOpenProject,
	onOpenSession,
	onNewSession,
	onShowLauncher,
	onLoadMore,
	toggleRef,
	newSessionRef,
}: {
	projects: ProjectInfo[];
	currentProjectId: string | null;
	sessions: SidebarSession[];
	isBusy: boolean;
	sessionsHasMore: boolean;
	onOpenProject: (projectId: string) => void;
	onOpenSession: (projectId: string, stem: string) => void;
	onNewSession: (projectId: string) => void;
	/** Detach and return to the Launcher (global project picker). */
	onShowLauncher: () => void;
	onLoadMore: () => void;
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

	const handleOpenProject = (projectId: string) => {
		onOpenProject(projectId);
		if (!isWide) setOpen(false);
	};

	const handleOpenSession = (session: SidebarSession) => {
		if (isBusy) return;
		onOpenSession(session.projectId, session.stem);
		if (!isWide) setOpen(false);
	};

	const groups = useMemo(() => groupSessions(sessions), [sessions]);
	const showHeaders = groups.length > 1;

	const sidebarContent = (
		<>
			{/* Projects section */}
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
			<div className={styles.sidebarInstanceList}>
				{projects.map((project) => {
					const isCurrent = project.id === currentProjectId;
					const rowCls = [styles.sidebarInstanceRow, isCurrent ? styles.sidebarItemActive : ""]
						.filter(Boolean)
						.join(" ");
					return (
						<div key={project.id} className={rowCls}>
							<button
								type="button"
								className={styles.sidebarInstanceBtn}
								onClick={() => handleOpenProject(project.id)}
								title={project.cwd}
							>
								<span className={styles.sidebarItemName}>{project.id}</span>
							</button>
						</div>
					);
				})}
			</div>
			<div className={styles.sidebarSectionHeader}>
				<span>Sessions</span>
			</div>
			{sessions.length === 0 && !sessionsHasMore && (
				<div className={styles.sidebarEmpty}>
					{currentProjectId ? "No sessions yet" : "Select a project to see sessions"}
				</div>
			)}
			<div className={styles.sidebarList}>
				{groups.map((group) => (
					<div key={group.label}>
						{showHeaders && <div className={styles.sidebarGroupHeader}>{group.label}</div>}
						{group.items.map((s) => {
							const label = (s.name || s.firstMessageText || s.stem) ?? "";
							const dotCls = [styles.sidebarLiveDot, s.isStreaming ? styles.sidebarLiveDotStreaming : ""]
								.filter(Boolean)
								.join(" ");
							return (
								<button
									type="button"
									key={`${s.projectId}/${s.stem}`}
									className={styles.sidebarItem}
									onClick={() => handleOpenSession(s)}
									disabled={isBusy}
									title={label}
								>
									<span className={dotCls} aria-hidden="true" />
									<span className={styles.sidebarItemRow}>
										<span className={styles.sidebarItemName}>{label.slice(0, 60)}</span>
										<span className={styles.sidebarItemTime}>{relativeTime(s.timestamp)}</span>
									</span>
								</button>
							);
						})}
					</div>
				))}
			</div>
			{sessionsHasMore && (
				<button
					type="button"
					className={styles.sidebarLoadMore}
					onClick={onLoadMore}
					aria-label="Load more sessions"
					title="Load more sessions"
				>
					↻
				</button>
			)}
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

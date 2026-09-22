// ============================================================================
// ProjectFolder — one sidebar branch: a single fold button (chevron + name —
// the name toggles, it does not navigate), one new-session button (opens the
// Project home, the compose surface — there is no empty-session creation
// path), and the children below: pinned active rows and lazily fetched,
// group-labeled history, all flush-left (no indent).
// ============================================================================

import { memo, useEffect, useMemo } from "react";
import type { ProjectInfo, SessionInfo } from "../../../../src/core/index.ts";
import type { SessionFolderPage } from "../../infra/state/store.ts";
import { SessionRow } from "./SessionRow.tsx";
import styles from "./Sidebar.module.css";
import { groupSessions } from "./timeUtils.ts";
import type { FolderFoldState } from "./useFolderExpansion.ts";

export const ProjectFolder = memo(function ProjectFolder({
	project,
	currentProjectId,
	currentStem,
	fold,
	activeRows,
	page,
	onToggle,
	onOpenProject,
	onOpen,
	onClose,
	onArchive,
	onLoad,
	onLoadMore,
}: {
	project: ProjectInfo;
	/** The attached (projectId, stem) pair — session-row selection input. */
	currentProjectId: string | null;
	currentStem: string | null;
	/** Tri-state fold: folded (nothing) / active (pinned rows) / open (all). */
	fold: FolderFoldState;
	/** Active sessions from the global snapshot, pinned below the folder row. */
	activeRows: SessionInfo[];
	page: SessionFolderPage | undefined;
	onToggle: (projectId: string, hasActive: boolean) => void;
	/** Open the Project's home (the compose surface) — the new-session
	 * affordance; the first prompt there creates the session. */
	onOpenProject: (projectId: string) => void;
	onOpen: (session: SessionInfo) => void;
	/** Terminate a live instance (row menu Close). Passed only to the pinned
	 * active rows — dormant history has no instance to kill. */
	onClose: (session: SessionInfo) => void;
	/** Close then archive a session (row menu Archive). Passed to active and
	 * dormant rows alike: a dormant row's close is a no-op, so archiving is
	 * how history is thinned without opening each session. */
	onArchive: (session: SessionInfo) => void;
	onLoad: (projectId: string) => void;
	onLoadMore: (projectId: string) => void;
}) {
	const hasActive = activeRows.length > 0;
	// "active" with nothing pinned renders folded — a two-state folder in
	// disguise (the cycle skips the active step too).
	const showChildren = fold === "open" || (fold === "active" && hasActive);
	const showHistory = fold === "open";

	// Lazy first page: fetch on unfold when no page is cached. Re-fires after
	// a reconnect reset (sessionPages cleared → undefined again).
	useEffect(() => {
		if (showHistory && page === undefined) onLoad(project.id);
	}, [showHistory, page, project.id, onLoad]);

	const activeIds = useMemo(() => new Set(activeRows.map((r) => r.sessionId)), [activeRows]);
	// The active snapshot is the authority (ADR 11): snapshot rows render in
	// the pinned section; a scanned row claiming activity but absent from the
	// snapshot renders as dormant history.
	const history = useMemo(
		() => (page?.kind === "ready" ? page.sessions.filter((s) => !activeIds.has(s.sessionId)) : []),
		[page, activeIds],
	);
	const groups = useMemo(() => groupSessions(history), [history]);

	const isSelected = (s: SessionInfo) => s.projectId === currentProjectId && s.stem === currentStem;

	// Chevron mirrors the three states: right (folded), diagonal (active
	// only), down (open). Base class carries color + transition.
	const chevronVariant = showHistory
		? styles.sidebarChevronOpen
		: fold === "active" && hasActive
			? styles.sidebarChevronMid
			: "";
	const chevronCls = [styles.sidebarChevron, chevronVariant].filter(Boolean).join(" ");

	return (
		<div>
			{/* Row group: the fold button (chevron + name — one target, the whole
			    row toggles) and the new-session button. Two buttons, not one —
			    a nested button is invalid HTML, and folding is not navigating. */}
			<div className={styles.sidebarFolderRowGroup}>
				<button
					type="button"
					className={styles.sidebarFolderRow}
					onClick={() => onToggle(project.id, hasActive)}
					aria-expanded={showChildren}
					title={project.cwd}
				>
					<svg
						viewBox="0 0 16 16"
						width="12"
						height="12"
						className={chevronCls}
						fill="currentColor"
						aria-hidden="true"
					>
						<path d="M6 3l5 5-5 5z" />
					</svg>
					<span className={styles.sidebarItemName}>{project.id}</span>
				</button>
				<button
					type="button"
					className={styles.sidebarFolderNewBtn}
					onClick={() => onOpenProject(project.id)}
					title={`New session — ${project.id}`}
					aria-label={`New session in ${project.id}`}
				>
					<svg
						viewBox="0 0 16 16"
						width="12"
						height="12"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						aria-hidden="true"
					>
						<path d="M8 2.5v11M2.5 8h11" strokeLinecap="round" />
					</svg>
				</button>
			</div>
			{showChildren && (
				<>
					{/* Pinned active sessions: visible in "active" and "open". The
					    live dot is the signal; no other chrome. */}
					<div className={styles.sidebarFolderChildren}>
						{activeRows.map((s) => (
							<SessionRow
								key={s.sessionId}
								session={s}
								dot={s.isStreaming ? "streaming" : "active"}
								selected={isSelected(s)}
								onOpen={onOpen}
								onClose={onClose}
								onArchive={onArchive}
							/>
						))}
					</div>
					{showHistory && (
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
												onArchive={onArchive}
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
				</>
			)}
		</div>
	);
});

// ============================================================================
// ProjectFolder — one sidebar branch: foldable Project row (the name
// navigates to the Project home; the chevron toggles the fold), the pinned
// active rows beneath it, and the lazily fetched, group-labeled history.
// ============================================================================

import { memo, useEffect, useMemo } from "react";
import type { ProjectInfo, SessionInfo } from "../../../../src/core/index.ts";
import type { SessionFolderPage } from "../../infra/state/store.ts";
import { SessionRow } from "./SessionRow.tsx";
import styles from "./Sidebar.module.css";
import { groupSessions } from "./timeUtils.ts";

export const ProjectFolder = memo(function ProjectFolder({
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

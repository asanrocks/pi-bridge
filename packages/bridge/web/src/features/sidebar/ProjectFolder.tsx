// ============================================================================
// ProjectFolder — one sidebar branch: a single fold button (chevron + name —
// the name toggles, it does not navigate), one new-session button (opens the
// Project home, the compose surface — there is no empty-session creation
// path), and the children below: the Project's queued rows and
// lazily fetched, group-labeled history, all flush-left (no indent).
// ============================================================================

import { memo, useEffect, useMemo } from "react";
import type { ProjectInfo, SessionInfo } from "../../../../src/core/index.ts";
import { useNow } from "../../infra/lib/useNow.ts";
import type { SessionFolderPage } from "../../infra/state/store.ts";
import { CaretIcon, ChevronDownIcon, PlusIcon } from "../../render/icons.tsx";
import { SessionRow } from "./SessionRow.tsx";
import styles from "./Sidebar.module.css";
import { groupSessions } from "./timeUtils.ts";
import type { FolderFoldState } from "./useFolderExpansion.ts";

export const ProjectFolder = memo(function ProjectFolder({
	project,
	currentProjectId,
	currentStem,
	fold,
	queueRows,
	page,
	onToggle,
	onOpenProject,
	onOpen,
	onClose,
	onSetState,
	onArchive,
	onLoad,
	onLoadMore,
}: {
	project: ProjectInfo;
	/** The attached (projectId, stem) pair — session-row selection input. */
	currentProjectId: string | null;
	currentStem: string | null;
	/** Tri-state fold: folded (nothing) / active (queued rows) / open (all). */
	fold: FolderFoldState;
	/** The Project's queued sessions, pinned below the folder row in
	 * the daemon's queue order: notified → busy → deferred, activity desc. */
	queueRows: SessionInfo[];
	page: SessionFolderPage | undefined;
	onToggle: (projectId: string, hasQueued: boolean) => void;
	/** Open the Project's home (the compose surface) — the new-session
	 * affordance; the first prompt there creates the session. */
	onOpenProject: (projectId: string) => void;
	onOpen: (session: SessionInfo) => void;
	/** Clear queue membership (row menu Close) — on every queued row: a
	 * queued session can be closed without opening it, dormant or not. */
	onClose: (session: SessionInfo) => void;
	/** The user's parking toggle (row menu Defer/Restore) — passed only to
	 * non-busy queued rows. */
	onSetState: (session: SessionInfo, state: "notified" | "deferred") => void;
	/** Close then archive a session (row menu Archive). Passed to queued and
	 * dormant rows alike: a dormant row's close is a no-op, so archiving is
	 * how history is thinned without opening each session. */
	onArchive: (session: SessionInfo) => void;
	onLoad: (projectId: string) => void;
	onLoadMore: (projectId: string) => void;
}) {
	const hasQueued = queueRows.length > 0;
	// "active" with nothing pinned renders folded — a two-state folder in
	// disguise (the cycle skips the active step too).
	const showChildren = fold === "open" || (fold === "active" && hasQueued);
	const showHistory = fold === "open";

	// Lazy first page: fetch on unfold when no page is cached. Re-fires after
	// a reconnect reset (sessionPages cleared → undefined again).
	useEffect(() => {
		if (showHistory && page === undefined) onLoad(project.id);
	}, [showHistory, page, project.id, onLoad]);

	const queueIds = useMemo(() => new Set(queueRows.map((r) => r.sessionId)), [queueRows]);
	// The queue is the authority: queued rows render in the pinned
	// section; a scanned row the store reports queued never renders twice —
	// history filters by membership.
	const history = useMemo(
		() => (page?.kind === "ready" ? page.sessions.filter((s) => !queueIds.has(s.sessionId)) : []),
		[page, queueIds],
	);
	// Bucket boundaries are a function of the clock, so the grouping re-derives
	// when the shared label clock ticks.
	const now = useNow();
	const groups = useMemo(() => groupSessions(history, now), [history, now]);

	const isSelected = (s: SessionInfo) => s.projectId === currentProjectId && s.stem === currentStem;

	// The caret mirrors the three fold states — right (folded), diagonal
	// (queued only), down (open) — as the glyph's own direction, never a CSS
	// rotation.
	const caretDirection = showHistory ? "down" : fold === "active" && hasQueued ? "diagonal" : "right";

	return (
		<div>
			{/* Row group: the fold button (chevron + name — one target, the whole
			    row toggles) and the new-session button. Two buttons, not one —
			    a nested button is invalid HTML, and folding is not navigating. */}
			<div className={styles.sidebarFolderRowGroup}>
				<button
					type="button"
					className={styles.sidebarFolderRow}
					onClick={() => onToggle(project.id, hasQueued)}
					aria-expanded={showChildren}
					title={project.cwd}
				>
					<CaretIcon size={12} direction={caretDirection} className={styles.sidebarChevron} />
					<span className={styles.sidebarItemName}>{project.id}</span>
				</button>
				<button
					type="button"
					className={styles.sidebarFolderNewBtn}
					onClick={() => onOpenProject(project.id)}
					title={`New session — ${project.id}`}
					aria-label={`New session in ${project.id}`}
				>
					<PlusIcon size={12} />
				</button>
			</div>
			{showChildren && (
				<>
					{/* The Project's queued sessions: visible in "active" and
					    "open". The state's mark is the signal; no other chrome. */}
					<div className={styles.sidebarFolderChildren}>
						{queueRows.map((s) => (
							<SessionRow
								key={s.sessionId}
								session={s}
								mark={s.state === "busy" ? "busy" : s.state === "deferred" ? "deferred" : "notified"}
								selected={isSelected(s)}
								onOpen={onOpen}
								onClose={onClose}
								onSetState={s.state === "busy" ? undefined : onSetState}
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
							{page?.kind === "ready" && history.length === 0 && queueRows.length === 0 && (
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
												mark="idle"
												selected={isSelected(s)}
												onOpen={onOpen}
												onArchive={onArchive}
											/>
										))}
									</div>
								))}
							{page?.kind === "ready" && page.hasMore && (
								/* Continuation, not an action on an object, and "more below"
								 * is the one meaning a chevron already carries outside this
								 * pane's fold carets — which sit on the folder row above the
								 * rows they fold, not at the list's end. The glyph carries the
								 * affordance, so the control needs no boundary. */
								<button
									type="button"
									className={styles.sidebarLoadMore}
									onClick={() => onLoadMore(project.id)}
									aria-label="Load more sessions"
									title="Load more sessions"
								>
									<ChevronDownIcon size={14} />
								</button>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
});

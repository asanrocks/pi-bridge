// ============================================================================
// ProjectFolder — one sidebar branch: a single fold button (chevron + name —
// the name toggles, it does not navigate), one new-session button (opens the
// Project home, the compose surface — there is no empty-session creation
// path), and the children below: the Project's sessions in state order,
// notified → busy → parked (deferred) → inactive, each group newest activity
// first, all flush-left (no indent). The fold is state-scoped (ADR 23):
// collapsed (name only) → working (notified + busy) → all.
// ============================================================================

import { memo, useEffect, useMemo } from "react";
import type { ProjectInfo, SessionInfo } from "../../../../src/core/index.ts";
import type { SessionFolderPage } from "../../infra/state/store.ts";
import { CaretIcon, ChevronDownIcon, PlusIcon } from "../../render/icons.tsx";
import { SessionRow } from "./SessionRow.tsx";
import styles from "./Sidebar.module.css";
import { hiddenRowCount, splitProjectRows } from "./sessionRows.ts";
import type { FolderFoldState } from "./useFolderExpansion.ts";

/** Stable empty page rows so memoized folders without a loaded page do not
 * churn their split. */
const NO_ROWS: SessionInfo[] = [];

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
	onMarkInactive,
	onSetState,
	onArchive,
	onLoad,
	onLoadMore,
}: {
	project: ProjectInfo;
	/** The attached (projectId, stem) pair — session-row selection input. */
	currentProjectId: string | null;
	currentStem: string | null;
	/** State-scoped fold: collapsed (nothing) / working (notified + busy) /
	 * all (working + parked + inactive). */
	fold: FolderFoldState;
	/** The Project's queued sessions, in the daemon's queue order:
	 * notified → busy → deferred, activity desc. */
	queueRows: SessionInfo[];
	page: SessionFolderPage | undefined;
	onToggle: (projectId: string, hasWorking: boolean) => void;
	/** Open the Project's home (the compose surface) — the new-session
	 * affordance; the first prompt there creates the session. */
	onOpenProject: (projectId: string) => void;
	onOpen: (session: SessionInfo) => void;
	/** Clear a session's state (row menu Mark inactive) — on every row: a
	 * working session can be closed without opening it, dormant or not. */
	onMarkInactive: (session: SessionInfo) => void;
	/** The quick state control on the row's indicator: inactive → notified,
	 * notified ↔ deferred. Busy rows carry no control. */
	onSetState: (session: SessionInfo, state: "notified" | "deferred") => void;
	/** Close then archive a session (row menu Archive). Passed to every row
	 * with a durable file: archiving is how history is thinned without
	 * opening each session. */
	onArchive: (session: SessionInfo) => void;
	onLoad: (projectId: string) => void;
	onLoadMore: (projectId: string) => void;
}) {
	// The page is the inactive tail; the queue holds the state rows. Splitting
	// both in one place keeps the folder's order and membership rules testable.
	const historyRows = page?.kind === "ready" ? page.sessions : NO_ROWS;
	const {
		working: workingRows,
		parked: parkedRows,
		inactive,
	} = useMemo(() => splitProjectRows(queueRows, historyRows), [queueRows, historyRows]);
	const hasWorking = workingRows.length > 0;

	const showChildren = fold === "all" || (fold === "working" && hasWorking);
	const showAll = fold === "all";

	// Lazy first page: fetch on unfold when no page is cached. Re-fires after
	// a reconnect reset (sessionPages cleared → undefined again).
	useEffect(() => {
		if (showAll && page === undefined) onLoad(project.id);
	}, [showAll, page, project.id, onLoad]);

	const isSelected = (s: SessionInfo) => s.projectId === currentProjectId && s.stem === currentStem;

	// The caret mirrors the three fold states — right (collapsed), diagonal
	// (working only), down (all) — as the glyph's own direction, never a CSS
	// rotation.
	const caretDirection = showAll ? "down" : fold === "working" && hasWorking ? "diagonal" : "right";

	// A collapsed folder still says how much it hides, so parked work is
	// findable without unfolding every Project. Only rows already known count:
	// the count never triggers a history fetch.
	const hiddenCount = hiddenRowCount(fold, { working: workingRows, parked: parkedRows, inactive });

	return (
		<div>
			{/* Row group: the fold button (chevron + name — one target, the whole
			    row toggles) and the new-session button. Two buttons, not one —
			    a nested button is invalid HTML, and folding is not navigating. */}
			<div className={styles.sidebarFolderRowGroup}>
				<button
					type="button"
					className={styles.sidebarFolderRow}
					onClick={() => onToggle(project.id, hasWorking)}
					aria-expanded={showChildren}
					title={project.cwd}
				>
					<CaretIcon size={12} direction={caretDirection} className={styles.sidebarChevron} />
					<span className={styles.sidebarItemName}>{project.id}</span>
					{hiddenCount > 0 && (
						<span className={styles.sidebarFolderHidden} title={`${hiddenCount} sessions hidden`}>
							+{hiddenCount}
						</span>
					)}
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
				<div className={styles.sidebarFolderChildren}>
					{workingRows.map((s) => (
						<SessionRow
							key={s.sessionId}
							session={s}
							mark={s.state === "busy" ? "busy" : "notified"}
							selected={isSelected(s)}
							onOpen={onOpen}
							onMarkInactive={onMarkInactive}
							onSetState={s.state === "busy" ? undefined : onSetState}
							onArchive={onArchive}
						/>
					))}
					{showAll &&
						parkedRows.map((s) => (
							<SessionRow
								key={s.sessionId}
								session={s}
								mark="deferred"
								selected={isSelected(s)}
								onOpen={onOpen}
								onMarkInactive={onMarkInactive}
								onSetState={onSetState}
								onArchive={onArchive}
							/>
						))}
					{showAll && (page === undefined || page.kind === "loading") && (
						<div className={styles.sidebarFolderMsg}>Loading…</div>
					)}
					{showAll && page?.kind === "error" && (
						<button type="button" className={styles.sidebarFolderRetry} onClick={() => onLoad(project.id)}>
							Load failed — retry
						</button>
					)}
					{showAll && page?.kind === "ready" && inactive.length === 0 && queueRows.length === 0 && (
						<div className={styles.sidebarFolderMsg}>No sessions yet</div>
					)}
					{showAll &&
						inactive.map((s) => (
							<SessionRow
								key={`${s.projectId}/${s.stem}`}
								session={s}
								mark="idle"
								selected={isSelected(s)}
								onOpen={onOpen}
								onMarkInactive={onMarkInactive}
								onSetState={onSetState}
								onArchive={onArchive}
							/>
						))}
					{showAll && page?.kind === "ready" && page.hasMore && (
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
		</div>
	);
});

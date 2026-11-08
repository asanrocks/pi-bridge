// ============================================================================
// ProjectFolder — one sidebar branch: a single fold button (chevron + name —
// the name toggles, it does not navigate), one new-session button (opens the
// Project home, the compose surface — there is no empty-session creation
// path), and the children below: the Project's Sessions in queue order (Inbox
// → Later) followed by the archived history, each group newest activity first,
// all flush-left (no indent). The fold is location-scoped: collapsed (name
// only) → inbox (the attention list) → all (Inbox + Later + archived).
// ============================================================================

import { memo, useEffect, useMemo } from "react";
import type { ProjectInfo, SessionInfo, SessionLocation } from "../../../../src/core/index.ts";
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
	onMove,
	onTrash,
	onLoad,
	onLoadMore,
}: {
	project: ProjectInfo;
	/** The attached (projectId, stem) pair — session-row selection input. */
	currentProjectId: string | null;
	currentStem: string | null;
	/** Location-scoped fold: collapsed (nothing) / inbox (the attention list) /
	 * all (Inbox + Later + archived). */
	fold: FolderFoldState;
	/** The Project's queued Sessions, in the daemon's queue order:
	 * Inbox → Later, activity desc. */
	queueRows: SessionInfo[];
	page: SessionFolderPage | undefined;
	onToggle: (projectId: string, hasInbox: boolean) => void;
	/** Open the Project's home (the compose surface) — the new-session
	 * affordance; the first prompt there creates the session. */
	onOpenProject: (projectId: string) => void;
	onOpen: (session: SessionInfo) => void;
	/** The row menu's moves: Park/Unpark between Inbox and Later, Archive and
	 * Unarchive as the resting place (archiving also stops a running agent).
	 * Passed to every row — the menu is shaped by the row's own location. */
	onMove: (session: SessionInfo, location: SessionLocation) => void;
	/** The row menu's Trash: ends the runtime, then hides the file. Passed to
	 * every row with a durable file. */
	onTrash: (session: SessionInfo) => void;
	onLoad: (projectId: string) => void;
	onLoadMore: (projectId: string) => void;
}) {
	// The page is the archived tail; the queue holds the placed rows. Splitting
	// both in one place keeps the folder's order and membership rules testable.
	const historyRows = page?.kind === "ready" ? page.sessions : NO_ROWS;
	const {
		inbox: inboxRows,
		later: laterRows,
		archived,
	} = useMemo(() => splitProjectRows(queueRows, historyRows), [queueRows, historyRows]);
	const hasInbox = inboxRows.length > 0;

	const showChildren = fold === "all" || (fold === "inbox" && hasInbox);
	const showAll = fold === "all";

	// Lazy first page: fetch on unfold when no page is cached. Re-fires after
	// a reconnect reset (sessionPages cleared → undefined again).
	useEffect(() => {
		if (showAll && page === undefined) onLoad(project.id);
	}, [showAll, page, project.id, onLoad]);

	const isSelected = (s: SessionInfo) => s.projectId === currentProjectId && s.stem === currentStem;

	// The caret mirrors the three fold states — right (collapsed), diagonal
	// (inbox only), down (all) — as the glyph's own direction, never a CSS
	// rotation.
	const caretDirection = showAll ? "down" : fold === "inbox" && hasInbox ? "diagonal" : "right";

	// A collapsed folder still says how much it hides, so Later work is
	// findable without unfolding every Project. Only rows already known count:
	// the count never triggers a history fetch.
	const hiddenCount = hiddenRowCount(fold, { inbox: inboxRows, later: laterRows, archived });

	return (
		<div>
			{/* Row group: the fold button (chevron + name — one target, the whole
			    row toggles) and the new-session button. Two buttons, not one —
			    a nested button is invalid HTML, and folding is not navigating. */}
			<div className={styles.sidebarFolderRowGroup}>
				<button
					type="button"
					className={styles.sidebarFolderRow}
					onClick={() => onToggle(project.id, hasInbox)}
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
					{inboxRows.map((s) => (
						<SessionRow
							key={`${s.projectId}/${s.stem}`}
							session={s}
							selected={isSelected(s)}
							onOpen={onOpen}
							onMove={onMove}
							onTrash={onTrash}
						/>
					))}
					{showAll &&
						laterRows.map((s) => (
							<SessionRow
								key={`${s.projectId}/${s.stem}`}
								session={s}
								selected={isSelected(s)}
								onOpen={onOpen}
								onMove={onMove}
								onTrash={onTrash}
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
					{showAll && page?.kind === "ready" && archived.length === 0 && queueRows.length === 0 && (
						<div className={styles.sidebarFolderMsg}>No sessions yet</div>
					)}
					{showAll &&
						archived.map((s) => (
							<SessionRow
								key={`${s.projectId}/${s.stem}`}
								session={s}
								selected={isSelected(s)}
								onOpen={onOpen}
								onMove={onMove}
								onTrash={onTrash}
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

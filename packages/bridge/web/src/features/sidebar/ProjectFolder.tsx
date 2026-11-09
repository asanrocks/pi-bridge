// ============================================================================
// ProjectFolder — one sidebar branch: a single fold button (chevron + name —
// the name toggles, it does not navigate), one new-session button (opens the
// Project home, the compose surface — there is no empty-session creation
// path), and the children below: the Project's Sessions in queue order (Inbox
// → Later) followed by the archived history, each group newest activity first,
// all flush-left (no indent).
//
// The heading is binary (folded / unfolded); what the unfolded list shows is a
// reveal ladder controlled at its end: Load more adds Later, then the archived
// history, then older pages of it; Show less removes them again. Both are
// chevrons with no words, because "more below" / "less below" is the meaning a
// chevron already carries.
// ============================================================================

import { memo, useEffect, useMemo } from "react";
import type { ProjectInfo, SessionInfo, SessionLocation } from "../../../../src/core/index.ts";
import type { SessionFolderPage } from "../../infra/state/store.ts";
import { CaretIcon, ChevronDownIcon, ChevronUpIcon, PlusIcon } from "../../render/icons.tsx";
import { advanceReveal, effectiveReveal, type FolderState, floorReveal, retreatReveal } from "./foldState.ts";
import { SessionRow } from "./SessionRow.tsx";
import styles from "./Sidebar.module.css";
import { splitProjectRows } from "./sessionRows.ts";

/** Stable empty page rows so memoized folders without a loaded page do not
 * churn their split. */
const NO_ROWS: SessionInfo[] = [];

export const ProjectFolder = memo(function ProjectFolder({
	project,
	currentProjectId,
	currentStem,
	folder,
	queueRows,
	page,
	onToggle,
	onOpenProject,
	onOpen,
	onMove,
	onTrash,
	onAdvance,
	onRetreat,
	onLoad,
	onLoadMore,
}: {
	project: ProjectInfo;
	/** The attached (projectId, stem) pair — session-row selection input. */
	currentProjectId: string | null;
	currentStem: string | null;
	/** The heading state plus the remembered reveal step. */
	folder: FolderState;
	/** The Project's queued Sessions, in the daemon's queue order:
	 * Inbox → Later, activity desc. */
	queueRows: SessionInfo[];
	page: SessionFolderPage | undefined;
	/** The folder heading: fold or unfold, keeping the reveal. */
	onToggle: (projectId: string) => void;
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
	/** Load more below the cap: the next reveal step. */
	onAdvance: (projectId: string, hasInbox: boolean, hasLater: boolean) => void;
	/** Show less: the previous reveal step. */
	onRetreat: (projectId: string, hasInbox: boolean, hasLater: boolean) => void;
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
	const hasLater = laterRows.length > 0;

	const reveal = effectiveReveal(folder.reveal, hasInbox, hasLater);
	const floor = floorReveal(hasInbox, hasLater);
	const showChildren = !folder.folded;
	const showLater = showChildren && reveal !== "inbox";
	const showArchived = showChildren && reveal === "all";
	/** At the cap, Load more means "the next page from the server"; the button
	 * disappears once history is exhausted. */
	const canPaginate = page?.kind === "ready" && page.hasMore === true;

	// Lazy first page: fetch on reaching the cap when no page is cached.
	// Re-fires after a reconnect reset (sessionPages cleared → undefined again).
	useEffect(() => {
		if (showArchived && page === undefined) onLoad(project.id);
	}, [showArchived, page, project.id, onLoad]);

	const isSelected = (s: SessionInfo) => s.projectId === currentProjectId && s.stem === currentStem;

	return (
		<div>
			{/* Row group: the fold button (chevron + name — one target, the whole
			    row toggles) and the new-session button. Two buttons, not one —
			    a nested button is invalid HTML, and folding is not navigating. */}
			<div className={styles.sidebarFolderRowGroup}>
				<button
					type="button"
					className={styles.sidebarFolderRow}
					onClick={() => onToggle(project.id)}
					aria-expanded={showChildren}
					title={project.cwd}
				>
					<CaretIcon size={12} direction={showChildren ? "down" : "right"} className={styles.sidebarChevron} />
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
					{showLater &&
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
					{showArchived && (page === undefined || page.kind === "loading") && (
						<div className={styles.sidebarFolderMsg}>Loading…</div>
					)}
					{showArchived && page?.kind === "error" && (
						<button type="button" className={styles.sidebarFolderRetry} onClick={() => onLoad(project.id)}>
							Load failed — retry
						</button>
					)}
					{showArchived && page?.kind === "ready" && archived.length === 0 && queueRows.length === 0 && (
						<div className={styles.sidebarFolderMsg}>No sessions yet</div>
					)}
					{showArchived &&
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
					{showChildren && (reveal !== "all" || canPaginate) && (
						<div className={styles.sidebarListEnd}>
							<button
								type="button"
								className={styles.sidebarListEndBtn}
								onClick={() =>
									reveal === "all" ? onLoadMore(project.id) : onAdvance(project.id, hasInbox, hasLater)
								}
								aria-label={moreLabel(reveal, hasLater)}
								title={moreLabel(reveal, hasLater)}
							>
								<ChevronDownIcon size={14} />
							</button>
							{reveal !== floor && (
								<button
									type="button"
									className={styles.sidebarListEndBtn}
									onClick={() => onRetreat(project.id, hasInbox, hasLater)}
									aria-label={lessLabel(reveal, hasInbox, hasLater)}
									title={lessLabel(reveal, hasInbox, hasLater)}
								>
									<ChevronUpIcon size={14} />
								</button>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
});

/** What Load more will do, named after its effect rather than its position:
 * at the cap it is a server page, below it a reveal step. */
function moreLabel(reveal: FolderState["reveal"], hasLater: boolean): string {
	if (reveal === "all") return "Load more sessions";
	return advanceReveal(reveal, hasLater) === "later" ? "Show Later sessions" : "Show archived sessions";
}

/** What Show less will remove — the rows that disappear, not a direction. */
function lessLabel(reveal: FolderState["reveal"], hasInbox: boolean, hasLater: boolean): string {
	return retreatReveal(reveal, hasInbox, hasLater) === "inbox" ? "Show Inbox only" : "Hide archived sessions";
}

// ============================================================================
// SidebarContent — the panel body shared by the rail, the hover-peek drawer,
// and the fullscreen overlay: the "Projects" header (a fold-all toggle plus
// the All-projects action) and the Project folder list. Presentational — the
// mode machine and the overlay-dismissal wiring live in Sidebar.
//
// Selection model: the Projects header folds or unfolds every folder at once;
// the folder row toggles its own fold and the + button opens the Project home.
// What an unfolded folder reveals is a ladder advanced at the list's end, not a
// heading state. Nothing on a folder row navigates by name. Selection lives only
// on session rows: exactly one row (the attached (projectId, stem)) wears the
// accent tint; a folder never does — it is a fold control, not a target.
// ============================================================================

import { memo, useMemo } from "react";
import type { ProjectInfo, SessionInfo, SessionLocation } from "../../../../src/core/index.ts";
import type { SessionFolderPage } from "../../infra/state/store.ts";
import { CaretIcon, GridIcon } from "../../render/icons.tsx";
import { DEFAULT_FOLDER_STATE, type FolderState } from "./foldState.ts";
import { ProjectFolder } from "./ProjectFolder.tsx";
import styles from "./Sidebar.module.css";

/** Stable empty array so memoized folders without active rows don't churn. */
const NO_SESSIONS: SessionInfo[] = [];

export const SidebarContent = memo(function SidebarContent({
	projects,
	currentProjectId,
	currentStem,
	queue,
	sessionPages,
	folders,
	onToggleAllFolders,
	onToggleFolder,
	onAdvanceFolder,
	onRetreatFolder,
	onOpenSession,
	onOpenProject,
	onMoveSession,
	onTrashSession,
	onShowLauncher,
	onLoadFolder,
	onLoadMoreFolder,
}: {
	projects: ProjectInfo[];
	currentProjectId: string | null;
	/** Open session's stem, or null on the Project home / launcher. */
	currentStem: string | null;
	/** The global queue — the authority for each folder's Inbox and Later
	 * rows, sliced per Project in queue order. */
	queue: SessionInfo[];
	/** Per-Project lazily fetched history pages, keyed by projectId. */
	sessionPages: Record<string, SessionFolderPage>;
	/** Per-Project folder state; missing entries default to an unfolded
	 * attention list. */
	folders: Record<string, FolderState>;
	/** Projects header: fold everything, or unfold everything. */
	onToggleAllFolders: () => void;
	onToggleFolder: (projectId: string) => void;
	/** A folder's Load more, below the archived cap: the next reveal step. */
	onAdvanceFolder: (projectId: string, hasInbox: boolean, hasLater: boolean) => void;
	/** A folder's Show less: the previous reveal step. */
	onRetreatFolder: (projectId: string, hasInbox: boolean, hasLater: boolean) => void;
	onOpenSession: (session: SessionInfo) => void;
	onOpenProject: (projectId: string) => void;
	/** The row menu's moves: Park/Unpark between Inbox and Later, Archive and
	 * Unarchive as the resting place (archiving also stops a running agent). */
	onMoveSession: (session: SessionInfo, location: SessionLocation) => void;
	/** The row menu's Trash: ends the runtime, then hides the file. */
	onTrashSession: (session: SessionInfo) => void;
	/** Detach and return to the Launcher (global project picker); overlay
	 * dismissal is already folded in by the owner. */
	onShowLauncher: () => void;
	onLoadFolder: (projectId: string) => void;
	onLoadMoreFolder: (projectId: string) => void;
}) {
	const queueByProject = useMemo(() => {
		const map = new Map<string, SessionInfo[]>();
		for (const s of queue) {
			const arr = map.get(s.projectId);
			if (arr) arr.push(s);
			else map.set(s.projectId, [s]);
		}
		return map;
	}, [queue]);

	// Header chevron mirrors the folders: down while any folder is unfolded,
	// right while every folder is folded.
	const allFolded = projects.length > 0 && projects.every((p) => (folders[p.id] ?? DEFAULT_FOLDER_STATE).folded);

	return (
		<>
			<div className={styles.sidebarSectionHeader}>
				{/* The label itself is the fold-all toggle — the folder headings'
				    gesture, applied to every Project at once. */}
				<button
					type="button"
					className={styles.sidebarSectionToggle}
					onClick={() => onToggleAllFolders()}
					title={allFolded ? "Unfold all projects" : "Fold all projects"}
				>
					<CaretIcon size={12} direction={allFolded ? "right" : "down"} className={styles.sidebarChevron} />
					<span>Projects</span>
				</button>
				<span className={styles.headerActions}>
					{/* To the global project picker (Launcher — detach). Hidden while
					    already there. Same ghost control as the folders' new-session
					    button — pane-level actions share one style. The 2×2 grid
					    glyph is deliberate: the action is a destination overview
					    ("browse all Projects"), not a directional back, and a
					    directional arrow next to the fold carets would read as
					    collapse. */}
					{currentProjectId !== null && (
						<button
							type="button"
							className={styles.sidebarFolderNewBtn}
							onClick={onShowLauncher}
							title="All projects"
							aria-label="All projects"
						>
							<GridIcon size={12} />
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
						folder={folders[project.id] ?? DEFAULT_FOLDER_STATE}
						queueRows={queueByProject.get(project.id) ?? NO_SESSIONS}
						page={sessionPages[project.id]}
						onToggle={onToggleFolder}
						onOpenProject={onOpenProject}
						onOpen={onOpenSession}
						onMove={onMoveSession}
						onTrash={onTrashSession}
						onAdvance={onAdvanceFolder}
						onRetreat={onRetreatFolder}
						onLoad={onLoadFolder}
						onLoadMore={onLoadMoreFolder}
					/>
				))}
			</div>
		</>
	);
});

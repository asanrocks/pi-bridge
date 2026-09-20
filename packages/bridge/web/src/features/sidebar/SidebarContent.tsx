// ============================================================================
// SidebarContent — the panel body shared by the rail, the hover-peek drawer,
// and the fullscreen overlay: the "Projects" header (a fold-all toggle plus
// the All-projects action) and the Project folder list. Presentational — the
// mode machine and the overlay-dismissal wiring live in Sidebar.
//
// Selection model: the Projects header cycles every folder's fold state; the
// folder row toggles its own fold and the + button opens the Project home.
// Nothing on a folder row navigates by name. Selection lives only on session
// rows: exactly one row (the attached (projectId, stem)) wears the accent
// tint; a folder never does — it is a fold control, not a target.
// ============================================================================

import { memo, useMemo } from "react";
import type { ProjectInfo, SessionInfo } from "../../../../src/core/index.ts";
import type { SessionFolderPage } from "../../infra/state/store.ts";
import { ProjectFolder } from "./ProjectFolder.tsx";
import styles from "./Sidebar.module.css";
import type { FolderFoldState } from "./useFolderExpansion.ts";

/** Stable empty array so memoized folders without active rows don't churn. */
const NO_SESSIONS: SessionInfo[] = [];

export const SidebarContent = memo(function SidebarContent({
	projects,
	currentProjectId,
	currentStem,
	activeSessions,
	sessionPages,
	folds,
	onToggleAllFolders,
	onToggleFolder,
	onOpenSession,
	onOpenProject,
	onCloseSession,
	onShowLauncher,
	onLoadFolder,
	onLoadMoreFolder,
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
	/** Per-Project fold states; missing entries default to "active". */
	folds: Record<string, FolderFoldState>;
	/** Projects header: apply one uniform fold state to every folder. */
	onToggleAllFolders: (hasActiveById: Record<string, boolean>) => void;
	onToggleFolder: (projectId: string, hasActive: boolean) => void;
	onOpenSession: (session: SessionInfo) => void;
	onOpenProject: (projectId: string) => void;
	onCloseSession: (session: SessionInfo) => void;
	/** Detach and return to the Launcher (global project picker); overlay
	 * dismissal is already folded in by the owner. */
	onShowLauncher: () => void;
	onLoadFolder: (projectId: string) => void;
	onLoadMoreFolder: (projectId: string) => void;
}) {
	const activeByProject = useMemo(() => {
		const map = new Map<string, SessionInfo[]>();
		for (const s of activeSessions) {
			const arr = map.get(s.projectId);
			if (arr) arr.push(s);
			else map.set(s.projectId, [s]);
		}
		return map;
	}, [activeSessions]);

	// Per-folder "has pinned active rows" — the cycle input that decides
	// whether a folder has the active step at all. Also feeds the header
	// chevron's effective-folded test.
	const hasActiveById = useMemo(() => {
		const out: Record<string, boolean> = {};
		for (const p of projects) out[p.id] = (activeByProject.get(p.id)?.length ?? 0) > 0;
		return out;
	}, [projects, activeByProject]);

	// Header chevron mirrors the folders: down while every folder is open,
	// right while every folder is effectively folded, diagonal in between.
	const effectiveFold = (id: string): FolderFoldState => {
		const f = folds[id] ?? "active";
		return f === "active" && !hasActiveById[id] ? "folded" : f;
	};
	const allOpen = projects.length > 0 && projects.every((p) => effectiveFold(p.id) === "open");
	const allFolded = projects.length > 0 && projects.every((p) => effectiveFold(p.id) === "folded");
	const headerChevronCls = [
		styles.sidebarChevron,
		allOpen ? styles.sidebarChevronOpen : allFolded ? "" : styles.sidebarChevronMid,
	]
		.filter(Boolean)
		.join(" ");

	return (
		<>
			<div className={styles.sidebarSectionHeader}>
				{/* The label itself is the fold-all toggle — same cycle the folder
				    rows use, applied to every Project at once. */}
				<button
					type="button"
					className={styles.sidebarSectionToggle}
					onClick={() => onToggleAllFolders(hasActiveById)}
					title="Fold / active / unfold all"
				>
					<svg
						viewBox="0 0 16 16"
						width="12"
						height="12"
						className={headerChevronCls}
						fill="currentColor"
						aria-hidden="true"
					>
						<path d="M6 3l5 5-5 5z" />
					</svg>
					<span>Projects</span>
				</button>
				<span className={styles.headerActions}>
					{/* Back to the global project picker. Hidden while already there.
					    Same ghost icon-button spec as the folders' new-session
					    button — pane-level actions share one style. */}
					{currentProjectId !== null && (
						<button
							type="button"
							className={styles.sidebarFolderNewBtn}
							onClick={onShowLauncher}
							title="All projects"
							aria-label="All projects"
						>
							<svg
								viewBox="0 0 16 16"
								width="12"
								height="12"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d="M13.5 8H2.5M7.5 2.5L2.5 8l5 5.5" />
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
						fold={folds[project.id] ?? "active"}
						activeRows={activeByProject.get(project.id) ?? NO_SESSIONS}
						page={sessionPages[project.id]}
						onToggle={onToggleFolder}
						onOpenProject={onOpenProject}
						onOpen={onOpenSession}
						onClose={onCloseSession}
						onLoad={onLoadFolder}
						onLoadMore={onLoadMoreFolder}
					/>
				))}
			</div>
		</>
	);
});

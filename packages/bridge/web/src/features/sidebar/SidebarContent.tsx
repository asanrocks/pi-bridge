// ============================================================================
// SidebarContent — the panel body shared by the rail, the hover-peek drawer,
// and the fullscreen overlay: the "Projects" header (with the All-projects
// action) and the Project folder list. Presentational — the mode machine and
// the overlay-dismissal wiring live in Sidebar.
//
// Selection model: the Project header navigates — clicking the name opens
// the Project's home (the compose surface); the chevron beside it is the
// fold toggle, nothing else. Selection lives only on session rows: exactly
// one row (the attached (projectId, stem)) wears the accent tint; the
// folder shows accent text solely at a Project home, where nothing is
// selected.
// ============================================================================

import { memo, useMemo } from "react";
import type { ProjectInfo, SessionInfo } from "../../../../src/core/index.ts";
import type { SessionFolderPage } from "../../infra/state/store.ts";
import { ProjectFolder } from "./ProjectFolder.tsx";
import styles from "./Sidebar.module.css";

/** Stable empty array so memoized folders without active rows don't churn. */
const NO_SESSIONS: SessionInfo[] = [];

export const SidebarContent = memo(function SidebarContent({
	projects,
	currentProjectId,
	currentStem,
	activeSessions,
	sessionPages,
	expanded,
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
	/** Expanded folder ids (persisted by the owner). */
	expanded: Set<string>;
	onToggleFolder: (projectId: string) => void;
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

	return (
		<>
			<div className={styles.sidebarSectionHeader}>
				<span>Projects</span>
				<span className={styles.headerActions}>
					{/* Back to the global project picker. Hidden while already there. */}
					{currentProjectId !== null && (
						<button
							type="button"
							className={styles.sidebarAddBtn}
							onClick={onShowLauncher}
							title="All projects"
							aria-label="All projects"
						>
							<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true">
								<path d="M3.5 3.5a1 1 0 011-1h3.5a1 1 0 011 1V7a1 1 0 01-1 1H4.5a1 1 0 01-1-1V3.5zm7.5 0a1 1 0 011-1h3.5a1 1 0 011 1V7a1 1 0 01-1 1H12a1 1 0 01-1-1V3.5zM3.5 11a1 1 0 011-1H8a1 1 0 011 1v3.5a1 1 0 01-1 1H4.5a1 1 0 01-1-1V11zm7.5 0a1 1 0 011-1h3.5a1 1 0 011 1v3.5a1 1 0 01-1 1H12a1 1 0 01-1-1V11z" />
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
						expanded={expanded.has(project.id)}
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

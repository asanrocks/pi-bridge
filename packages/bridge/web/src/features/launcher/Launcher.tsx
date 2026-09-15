// ============================================================================
// Launcher — the "home" view (ADR 11). Two jobs: browse Projects, and resume
// an active session. Shown globally at /launcher and scoped to one Project at
// /chat/<projectId> (same surface, filtered). No create/attach machinery: a
// session is opened by address and the daemon resolves or activates it.
// ============================================================================

import { memo, useMemo } from "react";
import type { ProjectInfo, SessionInfo } from "../../../../src/core/index.ts";
import type { ConnectionState } from "../../infra/store.ts";
import { relativeTime } from "../sidebar/timeUtils.ts";
import styles from "./Launcher.module.css";

export const Launcher = memo(function Launcher({
	connection,
	projects,
	activeSessions,
	projectId,
	onOpenProject,
	onOpenSession,
	onNewSession,
	retry,
}: {
	connection: ConnectionState;
	projects: ProjectInfo[];
	activeSessions: SessionInfo[];
	/** When set, the Launcher is scoped to one Project's home. */
	projectId: string | null;
	onOpenProject: (projectId: string) => void;
	onOpenSession: (projectId: string, stem: string, sessionId?: string) => void;
	onNewSession: (projectId: string) => void;
	retry: () => void;
}) {
	const scoped = useMemo(
		() => (projectId === null ? projects : projects.filter((p) => p.id === projectId)),
		[projects, projectId],
	);
	const sessions = useMemo(
		() =>
			(projectId === null ? activeSessions : activeSessions.filter((s) => s.projectId === projectId))
				.slice()
				.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)),
		[activeSessions, projectId],
	);

	// ── Down states: full-panel treatment (can't be missed) ────────────────
	if (connection.kind === "connecting") {
		return (
			<div className={styles.state}>
				<div className={styles.stateTitle}>Connecting to pi-bridge…</div>
			</div>
		);
	}
	if (connection.kind === "reconnecting") {
		return (
			<div className={styles.state}>
				<div className={styles.stateTitle}>Reconnecting…</div>
				<div className={styles.stateSub}>attempt {connection.attempt}</div>
				<button type="button" className={styles.stateBtn} onClick={retry}>
					Retry now
				</button>
			</div>
		);
	}
	if (connection.kind === "unreachable") {
		return (
			<div className={styles.state}>
				<div className={styles.stateWarn}>⚠</div>
				<div className={styles.stateTitle}>Can't reach pi-bridge</div>
				<div className={styles.stateSub}>
					pi-bridge isn't running at {location.host}, or the connection was dropped.
				</div>
				<button type="button" className={styles.stateBtn} onClick={retry}>
					Retry now
				</button>
				<div className={styles.stateHint}>auto-retrying…</div>
			</div>
		);
	}
	if (connection.kind === "init_failed") {
		return (
			<div className={styles.state}>
				<div className={styles.stateWarn}>⚠</div>
				<div className={styles.stateTitle}>Daemon unresponsive</div>
				<div className={styles.stateSub}>
					Connected, but the server didn't respond.
					{connection.error ? ` (${connection.error})` : ""}
				</div>
				<button type="button" className={styles.stateBtn} onClick={retry}>
					Retry
				</button>
			</div>
		);
	}

	// ── Connected: launcher content ────────────────────────────────────────
	return (
		<div className={styles.launcher}>
			<div className={styles.header}>
				<span className={styles.headerTitle}>Projects</span>
			</div>
			{scoped.length === 0 ? (
				<div className={styles.empty}>
					<div className={styles.emptyTitle}>No projects configured</div>
					<div className={styles.emptyHint}>Start pi-bridge with --allow &lt;dir&gt;.</div>
				</div>
			) : (
				<div className={styles.rows}>
					{scoped.map((project) => (
						<div key={project.id} className={styles.row}>
							<button
								type="button"
								className={styles.rowMain}
								onClick={() => onOpenProject(project.id)}
								title={project.cwd}
							>
								<div className={styles.rowLine1}>
									<span className={styles.rowName}>{project.id}</span>
									<span className={styles.rowCwd} title={project.cwd}>
										<bdi>{project.cwd}</bdi>
									</span>
								</div>
							</button>
							<button
								type="button"
								className={styles.addBtn}
								onClick={() => onNewSession(project.id)}
								title={`New session in ${project.id}`}
								aria-label={`New session in ${project.id}`}
							>
								+
							</button>
						</div>
					))}
				</div>
			)}

			<div className={styles.header}>
				<span className={styles.headerTitle}>Active sessions</span>
			</div>
			{sessions.length === 0 ? (
				<div className={styles.empty}>
					<div className={styles.emptyTitle}>No active sessions</div>
					<div className={styles.emptyHint}>Start one from a project above.</div>
				</div>
			) : (
				<div className={styles.rows}>
					{sessions.map((session) => {
						const label = session.name || session.firstMessageText || session.stem;
						const dotCls = [styles.dot, session.isStreaming ? styles.dotStreaming : ""].filter(Boolean).join(" ");
						return (
							<div key={`${session.projectId}/${session.stem}`} className={styles.row}>
								<span className={dotCls} aria-hidden="true" />
								<button
									type="button"
									className={styles.rowMain}
									onClick={() => onOpenSession(session.projectId, session.stem, session.sessionId)}
									title={label}
								>
									<div className={styles.rowLine1}>
										<span className={styles.rowName} title={label}>
											{label}
										</span>
										<span className={styles.rowCwd} title={session.stem}>
											<bdi>{session.projectId}</bdi>
										</span>
										{session.isStreaming && <span className={styles.streaming}>streaming</span>}
										<span className={styles.rowTime}>{relativeTime(session.timestamp)}</span>
									</div>
									{session.firstMessageText && (
										<div className={styles.rowPreview}>{session.firstMessageText}</div>
									)}
								</button>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
});

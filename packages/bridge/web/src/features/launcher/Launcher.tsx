// ============================================================================
// Launcher — the unattached home view (ADR 11). Two surfaces:
//  - `/` (global): browse Projects and resume an active session.
//  - `/<projectId>` (Project home): HomeCompose — the shared compose card,
//    centered and always expanded — starts a new session on send (the
//    daemon admits the first prompt, attachments, and the pre-session
//    model choice before attach; ADR 12 slice), plus the Project's active
//    and recent sessions.
// No create buttons: a session is started by sending a prompt, and opened by
// address (the daemon resolves or activates it).
// ============================================================================

import { memo, useMemo } from "react";
import type { ImageContent, ModelInfo, ModelRef, ProjectInfo, SessionInfo } from "../../../../src/core/index.ts";
import type { ConnectionState } from "../../infra/store.ts";
import { HomeCompose } from "../composer/HomeCompose.tsx";
import { relativeTime } from "../sidebar/timeUtils.ts";
import styles from "./Launcher.module.css";

export const Launcher = memo(function Launcher({
	connection,
	projects,
	activeSessions,
	projectId,
	models,
	sessions,
	sessionsHasMore,
	onOpenProject,
	onOpenSession,
	onNewSession,
	onLoadMoreSessions,
	retry,
}: {
	connection: ConnectionState;
	projects: ProjectInfo[];
	activeSessions: SessionInfo[];
	/** When set, the Launcher is scoped to one Project's home. */
	projectId: string | null;
	/** The daemon's model list (getDaemonInfo) — feeds the home's picker. */
	models: ModelInfo[];
	/** The current Project's first history page (scoped surface only). */
	sessions: SessionInfo[];
	sessionsHasMore: boolean;
	onOpenProject: (projectId: string) => void;
	onOpenSession: (projectId: string, stem: string, sessionId?: string) => void;
	/** Send the first prompt of a new session. Resolves true on success —
	 * the caller keeps its draft on failure. */
	onNewSession: (projectId: string, text: string, images?: ImageContent[], model?: ModelRef) => Promise<boolean>;
	onLoadMoreSessions: () => void;
	retry: () => void;
}) {
	const scoped = useMemo(
		() => (projectId === null ? projects : projects.filter((p) => p.id === projectId)),
		[projects, projectId],
	);
	const active = useMemo(
		() =>
			(projectId === null ? activeSessions : activeSessions.filter((s) => s.projectId === projectId))
				.slice()
				.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)),
		[activeSessions, projectId],
	);
	// The history page excludes rows already shown in the active section
	// (live state is the snapshot's authority — ADR 11).
	const history = useMemo(() => {
		if (projectId === null) return [];
		const activeIds = new Set(active.filter((s) => s.projectId === projectId).map((s) => s.sessionId));
		return sessions.filter((s) => !activeIds.has(s.sessionId));
	}, [projectId, sessions, active]);

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

	// ── Connected ──────────────────────────────────────────────────────────
	return (
		<div className={styles.launcher}>
			{projectId !== null && (
				<HomeCompose
					projectId={projectId}
					models={models}
					defaultModel={scoped.find((p) => p.id === projectId)?.defaultModel ?? null}
					connected={connection.kind === "connected"}
					onNewSession={onNewSession}
				/>
			)}

			{projectId === null && (
				<>
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
								<button
									type="button"
									key={project.id}
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
							))}
						</div>
					)}
				</>
			)}

			<div className={styles.header}>
				<span className={styles.headerTitle}>Active sessions</span>
			</div>
			{active.length === 0 ? (
				<div className={styles.empty}>
					<div className={styles.emptyTitle}>No active sessions</div>
					<div className={styles.emptyHint}>
						{projectId === null ? "Start one from a project above." : "Send a prompt to start one."}
					</div>
				</div>
			) : (
				<div className={styles.rows}>
					{active.map((session) => {
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
										{projectId === null && (
											<span className={styles.rowCwd} title={session.stem}>
												<bdi>{session.projectId}</bdi>
											</span>
										)}
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

			{projectId !== null && history.length > 0 && (
				<>
					<div className={styles.header}>
						<span className={styles.headerTitle}>Recent sessions</span>
					</div>
					<div className={styles.rows}>
						{history.map((session) => {
							const label = session.name || session.firstMessageText || session.stem;
							return (
								<div key={`${session.projectId}/${session.stem}`} className={styles.row}>
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
											<span className={styles.rowTime}>{relativeTime(session.timestamp)}</span>
										</div>
										{session.firstMessageText && (
											<div className={styles.rowPreview}>{session.firstMessageText}</div>
										)}
									</button>
								</div>
							);
						})}
						{sessionsHasMore && (
							<button type="button" className={styles.loadMore} onClick={onLoadMoreSessions}>
								Show more
							</button>
						)}
					</div>
				</>
			)}
		</div>
	);
});

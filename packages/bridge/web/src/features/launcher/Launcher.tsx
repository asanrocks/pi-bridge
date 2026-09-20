// ============================================================================
// Launcher — the unattached home view (ADR 11). Two surfaces:
//  - `/` (global): browse Projects and resume an active session.
//  - `/<projectId>` (Project home): the compose card only (HomeCompose) —
//    centered and always expanded, it starts a new session on send (the
//    daemon admits the first prompt, attachments, and the pre-session model
//    choice before attach; ADR 12 slice).
// No create buttons: a session is started by sending a prompt, and opened by
// address (the daemon resolves or activates it). Project sessions are
// browsed from the sidebar, not from the home.
//
// Self-sufficient: reads the store and calls useRpc directly; the only
// shell-provided prop is the connection retry.
// ============================================================================

import { memo, useMemo } from "react";
import { useRpc } from "../../infra/net/useRpc.ts";
import { connectionStatus } from "../../infra/state/connectionStatus.ts";
import { useStore } from "../../infra/state/store.tsx";
import { HomeCompose } from "../composer/HomeCompose.tsx";
import { relativeTime } from "../sidebar/timeUtils.ts";
import styles from "./Launcher.module.css";
import { sortByLastActivity } from "./sortByLastActivity.ts";

export const Launcher = memo(function Launcher({ retry }: { retry: () => void }) {
	const connection = useStore((s) => s.connection);
	const projects = useStore((s) => s.projects);
	const activeSessions = useStore((s) => s.activeSessions);
	/** When set, the Launcher is the Project home (compose only). */
	const projectId = useStore((s) => s.currentProjectId);
	/** The daemon's model list (getDaemonInfo) — feeds the home's picker. */
	const models = useStore((s) => s.models);
	/** The daemon's global `enabledModels` scope — the home's Pinned group. */
	const scopedModels = useStore((s) => s.scopedModels);
	const rpc = useRpc();
	const active = useMemo(() => sortByLastActivity(activeSessions), [activeSessions]);

	// ── Down states: full-panel treatment (can't be missed) ────────────────
	// Wording and visible state come from the shared connectionStatus mapping
	// (the TopBar icon is the other consumer). The warn glyph marks the
	// failed phase; auto-retrying states show a hint; init_failed does not
	// self-retry; connecting has nothing to retry yet.
	const status = connectionStatus(connection);
	if (status) {
		return (
			<div className={styles.state}>
				{status.phase === "failed" && <div className={styles.stateWarn}>⚠</div>}
				<div className={styles.stateTitle}>{status.label}</div>
				<div className={styles.stateSub}>{status.detail}</div>
				{connection.kind !== "connecting" && (
					<button type="button" className={styles.stateBtn} onClick={retry}>
						Retry now
					</button>
				)}
				{(connection.kind === "reconnecting" || connection.kind === "unreachable") && (
					<div className={styles.stateHint}>Auto-retrying…</div>
				)}
			</div>
		);
	}

	// ── Project home: compose only ─────────────────────────────────────────
	if (projectId !== null) {
		const project = projects.find((p) => p.id === projectId);
		return (
			<div className={styles.launcher}>
				<HomeCompose
					projectId={projectId}
					models={models}
					scopedModels={scopedModels}
					defaultModel={project?.defaultModel ?? null}
					defaultThinkingLevel={project?.defaultThinkingLevel ?? null}
					connected={connection.kind === "connected"}
					onNewSession={(projectId, text, images, model, thinkingLevel) =>
						// ADR 12 slice: the daemon admits the first prompt (with any
						// attachments and the pre-session model choice) before attach.
						rpc.newSession(projectId, text, { images, model, thinkingLevel })
					}
				/>
			</div>
		);
	}

	// ── Global launcher: Projects + active sessions ────────────────────────
	return (
		<div className={styles.launcher}>
			<div className={styles.header}>
				<span className={styles.headerTitle}>Projects</span>
			</div>
			{projects.length === 0 ? (
				<div className={styles.empty}>
					<div className={styles.emptyTitle}>No projects configured</div>
					<div className={styles.emptyHint}>Start pi-bridge with --allow &lt;dir&gt;.</div>
				</div>
			) : (
				<div className={styles.rows}>
					{projects.map((project) => (
						<button
							type="button"
							key={project.id}
							className={styles.rowMain}
							onClick={() => rpc.openProject(project.id)}
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

			<div className={styles.header}>
				<span className={styles.headerTitle}>Active sessions</span>
			</div>
			{active.length === 0 ? (
				<div className={styles.empty}>
					<div className={styles.emptyTitle}>No active sessions</div>
					<div className={styles.emptyHint}>Start one from a project above.</div>
				</div>
			) : (
				<div className={styles.rows}>
					{active.map((session) => {
						const label = session.name || session.firstMessageText || session.stem;
						// Preview the latest message; fall back to the first when the copy
						// only has one (or the file scan predates the field).
						const preview = session.lastMessageText ?? session.firstMessageText;
						const when = session.lastActivityAt ?? session.timestamp;
						const dotCls = [styles.dot, session.isStreaming ? styles.dotStreaming : ""].filter(Boolean).join(" ");
						return (
							<div key={`${session.projectId}/${session.stem}`} className={styles.row}>
								<span className={dotCls} aria-hidden="true" />
								<button
									type="button"
									className={styles.rowMain}
									onClick={() => rpc.openSession(session.projectId, session.stem, session.sessionId)}
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
										<span className={styles.rowTime}>{relativeTime(when)}</span>
									</div>
									{preview && <div className={styles.rowPreview}>{preview}</div>}
								</button>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
});

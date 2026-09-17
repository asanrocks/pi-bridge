// ============================================================================
// Launcher — the unattached home view (ADR 11). Two surfaces:
//  - `/` (global): browse Projects and resume an active session.
//  - `/<projectId>` (Project home): a prompt input that starts a new session
//    on send — the daemon admits the first prompt before attach (ADR 12
//    slice), so the conversation the client navigates into is already
//    streaming — plus the Project's active and recent sessions.
// No create buttons: a session is started by sending a prompt, and opened by
// address (the daemon resolves or activates it).
// ============================================================================

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo, SessionInfo } from "../../../../src/core/index.ts";
import type { ConnectionState } from "../../infra/store.ts";
import { relativeTime } from "../sidebar/timeUtils.ts";
import styles from "./Launcher.module.css";

export const Launcher = memo(function Launcher({
	connection,
	projects,
	activeSessions,
	projectId,
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
	/** The current Project's first history page (scoped surface only). */
	sessions: SessionInfo[];
	sessionsHasMore: boolean;
	onOpenProject: (projectId: string) => void;
	onOpenSession: (projectId: string, stem: string, sessionId?: string) => void;
	/** Send the first prompt of a new session. Resolves true on success —
	 * the caller keeps its text on failure. */
	onNewSession: (projectId: string, text: string) => Promise<boolean>;
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
			{projectId !== null && <PromptHero projectId={projectId} onNewSession={onNewSession} />}

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

// ---------------------------------------------------------------------------
// PromptHero — the Project home's input box. Sending creates the session and
// navigates into it; a failure keeps the text for retry.
// ---------------------------------------------------------------------------

const PromptHero = memo(function PromptHero({
	projectId,
	onNewSession,
}: {
	projectId: string;
	onNewSession: (projectId: string, text: string) => Promise<boolean>;
}) {
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	// Landing on the Project home is a come-to-type gesture — focus the input
	// (a ref-effect instead of autoFocus, which biome's a11y rule rejects).
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const send = async () => {
		const value = text.trim();
		if (value === "" || sending) return;
		setSending(true);
		let ok = false;
		try {
			ok = await onNewSession(projectId, value);
		} finally {
			setSending(false);
		}
		if (ok) setText("");
	};

	return (
		<div className={styles.hero}>
			<div className={styles.heroCard}>
				<textarea
					ref={inputRef}
					className={styles.heroInput}
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void send();
						}
					}}
					placeholder={`Send a prompt to ${projectId}…`}
					rows={1}
					disabled={sending}
					aria-label="New session prompt"
				/>
				<button
					type="button"
					className={styles.heroSend}
					onClick={() => void send()}
					disabled={sending || text.trim() === ""}
					aria-label="Start session"
					title="Start session (Enter)"
				>
					⏎
				</button>
			</div>
			<div className={styles.heroHint}>Enter starts a new session · Shift+Enter for a new line</div>
		</div>
	);
});

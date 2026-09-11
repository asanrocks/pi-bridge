// ============================================================================
// Launcher — the "home" view shown when no instance is attached (0 or >1
// live instances, per T1: 1 instance auto-attaches). Three jobs: show what's
// running (pickable rows), start something new (create), and tell the truth
// about the connection (down-state full panels). Polls listInstances while
// mounted + connected so streaming/idle state stays fresh without a push.
// ============================================================================

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { InstanceInfo } from "../../../../src/core/index.ts";
import type { ConnectionState } from "../../infra/store.ts";
import { relativeTime } from "../sidebar/timeUtils.ts";
import styles from "./Launcher.module.css";
import { sortByLastActivity } from "./sortInstances.ts";

export const Launcher = memo(function Launcher({
	connection,
	instances,
	cwdAllowlist,
	onSwitchInstance,
	onNewInstance,
	onKillInstance,
	onRefreshInstances,
	retry,
}: {
	connection: ConnectionState;
	instances: InstanceInfo[];
	cwdAllowlist: string[];
	onSwitchInstance: (instanceId: string) => void;
	onNewInstance: (cwd: string) => Promise<void>;
	onKillInstance: (instanceId: string) => Promise<void>;
	onRefreshInstances: () => Promise<void>;
	retry: () => void;
}) {
	const [cwdAnchor, setCwdAnchor] = useState<DOMRect | null>(null);
	const addBtnRef = useRef<HTMLButtonElement>(null);

	// Liveness: poll listInstances while connected so an unattached instance
	// starting/stopping a stream updates its dot. (No instances_changed push
	// yet — poll is the pragmatic bridge.)
	useEffect(() => {
		if (connection.kind !== "connected") return;
		void onRefreshInstances();
		const id = setInterval(() => {
			void onRefreshInstances();
		}, 5000);
		return () => clearInterval(id);
	}, [connection.kind, onRefreshInstances]);

	// Newest-activity-first: the daemon sends registry (creation) order; what's
	// on top is a client-side presentation decision (see sortInstances.ts).
	const sortedInstances = useMemo(() => sortByLastActivity(instances), [instances]);

	const openCreate = () => {
		if (cwdAllowlist.length === 1) {
			void onNewInstance(cwdAllowlist[0]);
		} else if (cwdAllowlist.length > 1) {
			setCwdAnchor(addBtnRef.current?.getBoundingClientRect() ?? null);
		}
	};

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
				<span className={styles.headerTitle}>Instances</span>
				<button ref={addBtnRef} type="button" className={styles.addBtn} onClick={openCreate} title="New instance">
					+
				</button>
				{cwdAnchor && cwdAllowlist.length > 1 && (
					<>
						<button
							type="button"
							aria-label="Close cwd picker"
							className={styles.popoverOverlay}
							onClick={() => setCwdAnchor(null)}
						/>
						<div
							className={styles.popover}
							style={{
								position: "fixed",
								top: cwdAnchor.bottom + 4,
								left: Math.max(8, Math.min(cwdAnchor.left, window.innerWidth - 240 - 8)),
								width: 240,
							}}
						>
							{cwdAllowlist.map((cwd) => (
								<button
									type="button"
									key={cwd}
									className={styles.popoverItem}
									onClick={() => {
										setCwdAnchor(null);
										void onNewInstance(cwd);
									}}
									title={cwd}
								>
									{cwd}
								</button>
							))}
						</div>
					</>
				)}
			</div>

			{instances.length === 0 ? (
				<div className={styles.empty}>
					<div className={styles.emptyTitle}>No instances running</div>
					<div className={styles.emptyHint}>Create one to start a conversation.</div>
					{cwdAllowlist.length === 1 ? (
						<button type="button" className={styles.createBtn} onClick={() => onNewInstance(cwdAllowlist[0])}>
							+ Create instance
						</button>
					) : cwdAllowlist.length > 1 ? (
						<div className={styles.cwdChips}>
							{cwdAllowlist.map((cwd) => (
								<button
									type="button"
									key={cwd}
									className={styles.cwdChip}
									onClick={() => onNewInstance(cwd)}
									title={cwd}
								>
									{cwd}
								</button>
							))}
						</div>
					) : null}
				</div>
			) : (
				<div className={styles.rows}>
					{sortedInstances.map((inst) => {
						const label = inst.name || inst.cwd || inst.sessionId.slice(0, 16);
						const dotCls = [styles.dot, inst.isStreaming ? styles.dotStreaming : ""].filter(Boolean).join(" ");
						return (
							<div key={inst.instanceId} className={styles.row}>
								<span className={dotCls} aria-hidden="true" />
								<button
									type="button"
									className={styles.rowMain}
									onClick={() => onSwitchInstance(inst.instanceId)}
									title={label}
								>
									<div className={styles.rowLine1}>
										<span className={styles.rowName} title={label}>
											{label}
										</span>
										{inst.cwd && (
											<span className={styles.rowCwd} title={inst.cwd}>
												<bdi>{inst.cwd}</bdi>
											</span>
										)}
										{inst.isStreaming && <span className={styles.streaming}>streaming</span>}
										{inst.lastActivityAt && (
											<span className={styles.rowTime}>{relativeTime(inst.lastActivityAt)}</span>
										)}
									</div>
									{inst.preview && <div className={styles.rowPreview}>{inst.preview}</div>}
								</button>
								<button
									type="button"
									className={styles.xBtn}
									onClick={(e) => {
										e.stopPropagation();
										onKillInstance(inst.instanceId);
									}}
									title="Kill instance"
									aria-label="Kill instance"
								>
									<svg
										viewBox="0 0 20 20"
										width="14"
										height="14"
										fill="currentColor"
										role="img"
										aria-label="Close"
									>
										<path d="M4.34 4.34a.8.8 0 011.32 0L10 8.68l4.34-4.34a.8.8 0 111.32 1.32L11.32 10l4.34 4.34a.8.8 0 01-1.32 1.32L10 11.32l-4.34 4.34a.8.8 0 01-1.32-1.32L8.68 10 4.34 5.66a.8.8 0 010-1.32z" />
									</svg>
								</button>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
});

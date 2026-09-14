// ============================================================================
// Sidebar — dual-mode collapsible panel. Two sections: Instances (alive)
// above, Sessions (dormant) below. Inline column ≥768px, slide-in overlay
// below. Open/close persists in localStorage.
// ============================================================================

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InstanceInfo } from "../../../../src/core/index.ts";
import { useMediaQuery } from "../../infra/useMediaQuery.ts";
import { ResizeHandle, usePaneResize } from "../../render/ResizeHandle.tsx";
import styles from "./Sidebar.module.css";
import { groupSessions, relativeTime, type SidebarSession } from "./timeUtils.ts";

const SIDEBAR_BREAKPOINT = "(min-width: 768px)";
const LS_KEY = "pi-bridge:sidebar-open";

/* Desktop width bounds for the resizable rail. Default matches the
   historical fixed width; min keeps section headers + rows readable,
   max keeps a usable conversation column (also viewport-capped at 45%). */
const SIDEBAR_DEFAULT_W = 220;
const SIDEBAR_MIN_W = 180;
const SIDEBAR_MAX_W = 360;

export const Sidebar = memo(function Sidebar({
	instances,
	attachedInstanceId,
	cwdAllowlist,
	sessions,
	isBusy,
	sessionsHasMore,
	onSwitchInstance,
	onNewInstance,
	onKillInstance,
	onShowLauncher,
	onSwitch,
	onNew,
	onLoadMore,
	toggleRef,
	newInstanceRef,
}: {
	instances: InstanceInfo[];
	attachedInstanceId: string | null;
	cwdAllowlist: string[];
	sessions: SidebarSession[];
	isBusy: boolean;
	sessionsHasMore: boolean;
	onSwitchInstance: (instanceId: string) => void;
	onNewInstance: (cwd: string) => Promise<void>;
	onKillInstance: (instanceId: string) => Promise<void>;
	/** Detach and return to the Launcher (full-page instance list). */
	onShowLauncher: () => void;
	onSwitch: (session: SidebarSession) => void;
	onNew: () => void;
	onLoadMore: () => void;
	toggleRef: React.MutableRefObject<() => void>;
	/** Imperative new-instance trigger populated by the Sidebar. Alt+N calls
	    this: when the allowlist has one cwd the App creates directly; when it
	    has several, this opens the sidebar (if closed) and surfaces the cwd
	    picker the [+] button already owns. */
	newInstanceRef: React.MutableRefObject<() => void>;
}) {
	const isWide = useMediaQuery(SIDEBAR_BREAKPOINT);

	const [open, setOpen] = useState(() => {
		try {
			const stored = localStorage.getItem(LS_KEY);
			if (stored !== null) return stored === "true";
		} catch {
			/* ignore */
		}
		return isWide;
	});
	const [cwdPopoverAnchor, setCwdPopoverAnchor] = useState<DOMRect | null>(null);
	const newInstanceBtnRef = useRef<HTMLButtonElement>(null);
	// Set by Alt+N when the sidebar is closed: open() renders the [+] button,
	// then the pending effect below triggers the new-instance flow once it's
	// mounted. Avoids a detached popover anchored to a non-existent button.
	const [pendingNewInstance, setPendingNewInstance] = useState(false);

	const triggerNewInstance = useCallback(() => {
		if (cwdAllowlist.length === 1) {
			onNewInstance(cwdAllowlist[0]);
		} else if (cwdAllowlist.length > 1) {
			setCwdPopoverAnchor(newInstanceBtnRef.current?.getBoundingClientRect() ?? null);
		}
	}, [cwdAllowlist, onNewInstance]);

	useEffect(() => {
		newInstanceRef.current = () => {
			if (open) {
				triggerNewInstance();
			} else {
				setOpen(true);
				setPendingNewInstance(true);
			}
		};
	}, [open, triggerNewInstance, newInstanceRef]);

	// After opening, trigger the deferred new-instance once the [+] button
	// has mounted (the desktop/mobile panels return null when !open).
	useEffect(() => {
		if (pendingNewInstance && open && newInstanceBtnRef.current) {
			setPendingNewInstance(false);
			triggerNewInstance();
		}
	}, [pendingNewInstance, open, triggerNewInstance]);

	useEffect(() => {
		setOpen(isWide);
	}, [isWide]);
	useEffect(() => {
		toggleRef.current = () => setOpen((v) => !v);
	}, [toggleRef]);
	useEffect(() => {
		localStorage.setItem(LS_KEY, String(open));
	}, [open]);

	// Resizable rail (desktop): owns the width, persists it, and publishes
	// --sidebar-w so .body and the TopBar clear the gutter. useLayoutEffect
	// inside the hook runs before paint (no one-frame flash); 0 when closed
	// or on mobile (overlay drawer, off-canvas). The mobile overlay is
	// off-canvas, so it contributes 0 gutter.
	const resize = usePaneResize({
		cssVar: "--sidebar-w",
		storageKey: "pi-bridge:sidebar-w",
		defaultWidth: SIDEBAR_DEFAULT_W,
		min: SIDEBAR_MIN_W,
		max: SIDEBAR_MAX_W,
		active: isWide && open,
	});

	const panelRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (isWide || !open) return;
		const handler = (e: MouseEvent) => {
			if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		const id = setTimeout(() => document.addEventListener("click", handler), 0);
		return () => {
			clearTimeout(id);
			document.removeEventListener("click", handler);
		};
	}, [isWide, open]);

	const handleSwitchInstance = (instanceId: string) => {
		onSwitchInstance(instanceId);
		if (!isWide) setOpen(false);
	};

	const handleSwitch = (session: SidebarSession) => {
		if (isBusy || session.sessionPath === null) return;
		onSwitch(session);
		if (!isWide) setOpen(false);
	};

	const groups = useMemo(() => groupSessions(sessions), [sessions]);
	const showHeaders = groups.length > 1;

	const sidebarContent = (
		<>
			{/* Instances section */}
			<div className={styles.sidebarSectionHeader}>
				<span>Instances</span>
				<span className={styles.headerActions}>
					{/* Back to the full-page instance list (Launcher). Hidden while
					    unattached — the Launcher is the view in that state. Shares the
					    header-action chrome with the + button (matched pair across panes). */}
					{attachedInstanceId !== null && (
						<button
							type="button"
							className={styles.sidebarAddBtn}
							onClick={() => {
								onShowLauncher();
								if (!isWide) setOpen(false);
							}}
							title="Back to instance list"
							aria-label="Back to instance list"
						>
							<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true">
								<path d="M3.5 3.5a1 1 0 011-1h3.5a1 1 0 011 1V7a1 1 0 01-1 1H4.5a1 1 0 01-1-1V3.5zm7.5 0a1 1 0 011-1h3.5a1 1 0 011 1V7a1 1 0 01-1 1H12a1 1 0 01-1-1V3.5zM3.5 11a1 1 0 011-1H8a1 1 0 011 1v3.5a1 1 0 01-1 1H4.5a1 1 0 01-1-1V11zm7.5 0a1 1 0 011-1h3.5a1 1 0 011 1v3.5a1 1 0 01-1 1H12a1 1 0 01-1-1V11z" />
							</svg>
						</button>
					)}
					<button
						ref={newInstanceBtnRef}
						type="button"
						className={styles.sidebarAddBtn}
						onClick={triggerNewInstance}
						title="New instance"
					>
						+
					</button>
				</span>
			</div>
			{cwdPopoverAnchor && cwdAllowlist.length > 1 && (
				<>
					<button
						type="button"
						aria-label="Close cwd picker"
						className={styles.portalOverlay}
						onClick={() => setCwdPopoverAnchor(null)}
					/>
					<div
						className={styles.cwdPopover}
						style={{
							position: "fixed",
							top: cwdPopoverAnchor.bottom + 4,
							left: Math.max(8, Math.min(cwdPopoverAnchor.left, window.innerWidth - 240 - 8)),
							width: 240,
						}}
					>
						{cwdAllowlist.map((cwd) => (
							<button
								type="button"
								key={cwd}
								className={styles.cwdPopoverItem}
								onClick={() => {
									setCwdPopoverAnchor(null);
									onNewInstance(cwd);
								}}
								title={cwd}
							>
								{cwd}
							</button>
						))}
					</div>
				</>
			)}
			{instances.length === 0 && <div className={styles.sidebarEmpty}>No instances yet</div>}
			<div className={styles.sidebarInstanceList}>
				{instances.map((inst) => {
					const isAttached = inst.instanceId === attachedInstanceId;
					const fullName = inst.name || inst.cwd || inst.sessionId;
					const rowCls = [styles.sidebarInstanceRow, isAttached ? styles.sidebarItemActive : ""]
						.filter(Boolean)
						.join(" ");
					const dotCls = [styles.sidebarLiveDot, inst.isStreaming ? styles.sidebarLiveDotStreaming : ""]
						.filter(Boolean)
						.join(" ");
					return (
						<div key={inst.instanceId} className={rowCls}>
							<span className={dotCls} aria-hidden="true" />
							<button
								type="button"
								className={styles.sidebarInstanceBtn}
								onClick={() => handleSwitchInstance(inst.instanceId)}
								title={fullName}
							>
								<span className={styles.sidebarItemName}>
									{inst.name || inst.cwd || inst.sessionId.slice(0, 16)}
								</span>
							</button>
							<button
								type="button"
								className={styles.sidebarXBtn}
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
			<div className={styles.sidebarSectionHeader}>
				<span>Sessions</span>
				<button
					type="button"
					className={styles.sidebarAddBtn}
					onClick={onNew}
					disabled={isBusy || !attachedInstanceId}
					title="New session"
				>
					+
				</button>
			</div>
			{sessions.length === 0 && !sessionsHasMore && (
				<div className={styles.sidebarEmpty}>
					{attachedInstanceId ? "No sessions yet" : "Select an instance to see sessions"}
				</div>
			)}
			<div className={styles.sidebarList}>
				{groups.map((group) => (
					<div key={group.label}>
						{showHeaders && <div className={styles.sidebarGroupHeader}>{group.label}</div>}
						{group.items.map((s) => {
							const label = (s.name || s.firstMessageText || s.sessionId.slice(0, 16)) ?? "";
							return (
								<button
									type="button"
									key={s.sessionId}
									className={styles.sidebarItem}
									// ADR 09: live sessions have no file on disk yet (sessionPath
									// null) — not a switch target; the instance is already on them.
									onClick={() => handleSwitch(s)}
									disabled={isBusy}
									title={label}
								>
									<div className={styles.sidebarItemRow}>
										<span className={styles.sidebarItemName}>{label.slice(0, 60)}</span>
										<span className={styles.sidebarItemTime}>{relativeTime(s.timestamp)}</span>
									</div>
								</button>
							);
						})}
					</div>
				))}
			</div>
			{sessionsHasMore && (
				<button
					type="button"
					className={styles.sidebarLoadMore}
					onClick={onLoadMore}
					aria-label="Load more sessions"
					title="Load more sessions"
				>
					↻
				</button>
			)}
		</>
	);

	if (isWide) {
		if (!open) return null;
		// The handle is a fixed-position sibling (not a child) so the pane's
		// overflow: hidden can't clip it; it centers on the pane border.
		return (
			<>
				<div className={styles.sidebar} style={{ width: resize.width }}>
					{sidebarContent}
				</div>
				<ResizeHandle controller={resize} edge="right" label="Resize sidebar" />
			</>
		);
	}

	if (!open) return null;
	return (
		<>
			<button
				type="button"
				className={styles.sidebarBackdrop}
				onClick={() => setOpen(false)}
				aria-label="Close sidebar"
			/>
			<div className={styles.sidebarOverlay} ref={panelRef}>
				{sidebarContent}
			</div>
		</>
	);
});

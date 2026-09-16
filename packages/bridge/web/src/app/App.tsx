// ============================================================================
// App — root component composing TopBar, Sidebar, ConversationArea, Composer.
// Wires Zustand store + computeViewModel + useConnection.
// ============================================================================

import { useCallback, useMemo, useRef } from "react";
import type { Document, ImageContent } from "../../../src/core/index.ts";
import {
	computeViewModel,
	findNextModel,
	leafPathKey,
	leafStreamingKey,
	newestLeafInSubtree,
	segmentBlocks,
	type TextBlockVM,
	type TurnVM,
	turnKeyOf,
} from "../../../src/viewmodel/index.ts";
import { Composer } from "../features/composer/Composer.tsx";
import { ConversationArea } from "../features/conversation/ConversationArea.tsx";
import { copyToClipboard } from "../features/conversation/clipboard.ts";
import { HistoryPane } from "../features/history/HistoryPane.tsx";
import { Launcher } from "../features/launcher/Launcher.tsx";
import { Sidebar } from "../features/sidebar/Sidebar.tsx";
import { TopBar } from "../features/topbar/TopBar.tsx";
import { FileViewer } from "../features/viewer/FileViewer.tsx";
import { useDraftGuard } from "../infra/draftPersistence.ts";
import { useAppKeybindings } from "../infra/keybindings.ts";
import { getStore, StoreProvider, useStore } from "../infra/store.tsx";
import { useConnection } from "../infra/useConnection.ts";
import { useRpc } from "../infra/useRpc.ts";
import { requestNotificationPermission, useStatusNotifications } from "../infra/useStatusNotifications.ts";
import styles from "./App.module.css";
import { ToastBar } from "./ToastBar.tsx";

// ---------------------------------------------------------------------------
// Root wrapper
// ---------------------------------------------------------------------------

export function App() {
	return (
		<StoreProvider>
			<AppInner />
		</StoreProvider>
	);
}

// ---------------------------------------------------------------------------
// AppInner — access store inside Provider
// ---------------------------------------------------------------------------

function AppInner() {
	const { retry } = useConnection();
	useDraftGuard();

	// Use individual selectors for primitive status fields
	const leafId = useStore((s) => s.document.status.leafId);
	const statusName = useStore((s) => s.document.status.name);
	const statusModel = useStore((s) => s.document.status.model);
	const statusThinkingLevel = useStore((s) => s.document.status.thinkingLevel);
	const isStreaming = useStore((s) => s.document.status.isStreaming);
	const isCompacting = useStore((s) => s.document.status.isCompacting);
	const stats = useStore((s) => s.document.status.stats);
	const statusContextUsage = useStore((s) => s.document.status.contextUsage);

	// Document entries
	const entries = useStore((s) => s.document.entries);
	const pullTick = useStore((s) => s.pullTick);

	const connection = useStore((s) => s.connection);
	const currentProjectId = useStore((s) => s.currentProjectId);
	const currentStem = useStore((s) => s.currentStem);
	const projects = useStore((s) => s.projects);
	const activeSessions = useStore((s) => s.activeSessions);
	const sessions = useStore((s) => s.sessions);
	const sessionPages = useStore((s) => s.sessionPages);
	const models = useStore((s) => s.models);
	const thinkingLevels = useStore((s) => s.thinkingLevels);
	const scopedModels = useStore((s) => s.document.scopedModels);
	const cycleModels = useMemo(() => {
		if (scopedModels.length > 0) return scopedModels;
		const seen = new Set<string>();
		return models.filter((m) => {
			if (seen.has(m.provider)) return false;
			seen.add(m.provider);
			return true;
		});
	}, [scopedModels, models]);

	const toggleActionGroup = useStore((s) => s.toggleActionGroup);
	const toggleStep = useStore((s) => s.toggleStep);

	const historyOpen = useStore((s) => s.historyOpen);
	const setHistoryOpen = useStore((s) => s.setHistoryOpen);

	// VM cache
	const vmCacheRef = useRef<{ key: string; vm: ReturnType<typeof computeViewModel> } | null>(null);
	const vm = useMemo(() => {
		const doc: Document = {
			status: {
				leafId,
				name: statusName,
				model: statusModel,
				thinkingLevel: statusThinkingLevel,
				isStreaming,
				isCompacting,
				stats,
				contextUsage: statusContextUsage,
				pendingSteer: [],
			},
			entries,
			scopedModels: [],
		};
		// leafPathKey is the single source for the path-identity portion of the
		// cache key; the remaining fields gate re-projection on non-structural
		// state changes (status, pullTick, context usage).
		const key = [
			leafPathKey(doc),
			leafStreamingKey(doc),
			statusName,
			`${statusModel.provider}/${statusModel.modelId}`,
			statusThinkingLevel,
			String(isStreaming),
			String(isCompacting),
			String(currentStem),
			String(pullTick),
			String(JSON.stringify(statusContextUsage)),
		].join("::");

		if (vmCacheRef.current?.key === key) {
			return vmCacheRef.current.vm;
		}

		const prevVm = vmCacheRef.current?.vm;
		const newVm = computeViewModel({ document: doc, sessions, models }, prevVm);
		vmCacheRef.current = { key: key, vm: newVm };
		return newVm;
	}, [
		entries,
		leafId,
		statusName,
		statusModel,
		statusThinkingLevel,
		isStreaming,
		isCompacting,
		stats,
		currentStem,
		sessions,
		models,
		pullTick,
		statusContextUsage,
	]);

	// Status notification
	const activityEmoji = useMemo(() => {
		if (!isStreaming) return "";
		const lastTurn = vm.turns[vm.turns.length - 1];
		if (!lastTurn || lastTurn.kind !== "assistant") return "\uD83D\uDCAC"; // 💬
		// Walk blocks backwards: the latest block is the current phase. Skip
		// finished tools (result attached) and redacted thinking — they carry
		// no live phase signal — and return on the first block that does.
		for (let i = lastTurn.blocks.length - 1; i >= 0; i--) {
			const block = lastTurn.blocks[i];
			if (block.blockType === "tool") {
				if (block.status !== "done" && block.status !== "error") return "\uD83D\uDD27"; // 🔧 live tool (pending/dispatched)
			} else if (block.blockType === "thinking") {
				if (!block.redacted) return "\uD83E\uDDE0"; // 🧠 unredacted thinking
			} else {
				return "\uD83D\uDCAC"; // 💬 text
			}
		}
		return "\uD83D\uDCAC"; // 💬 fallback (all blocks done/redacted)
	}, [isStreaming, vm.turns]);

	useStatusNotifications({
		isStreaming,
		statusName,
		activity: { emoji: activityEmoji },
	});

	const rpc = useRpc();

	const handleToggleGroup = useCallback(
		(key: string, cardKeys: string[]) => toggleActionGroup(key, cardKeys),
		[toggleActionGroup],
	);
	const handleToggleStep = useCallback((key: string) => toggleStep(key), [toggleStep]);

	const sidebarToggleRef = useRef<() => void>(() => {});
	/** Imperative handle the Sidebar populates: open the sidebar (if closed)
	    and surface the project picker. Driven by Alt+N when more than one
	    Project is configured (==1 starts a session directly). */
	const newSessionRef = useRef<() => void>(() => {});

	const isBusy = isStreaming || isCompacting;
	const hasOpenSession = currentStem !== null;

	const handleCycleModel = useCallback(
		(direction: "forward" | "backward") => {
			const next = findNextModel(cycleModels, statusModel, direction);
			if (next) rpc.setModel(next.provider, next.id);
		},
		[cycleModels, statusModel, rpc],
	);

	const handleCommit = useCallback(async () => {
		// Read the draft, clear it optimistically, fire the RPC, and restore
		// it on failure. The optimistic clear empties the textarea immediately
		// — the prompt RPC awaits the *whole turn* (Manager.prompt awaits
		// session.prompt), so clearing only on resolve would leave the text
		// through the entire stream. The restore preserves the no-data-loss
		// guarantee: a failed or offline send keeps the text for retry.
		const s = getStore().getState();
		const draft = s.draft;
		if (draft.kind === "idle") return;
		const text = draft.text;
		const draftImages = draft.kind === "compose" ? draft.images : undefined;
		// Image-only sends are allowed: empty text with attachments.
		if (!text.trim() && !(draftImages && draftImages.length > 0)) return;
		// Connection pre-flight: a disconnected send is a no-op RPC; keep
		// the draft and surface why instead of silently dropping it.
		if (s.connection.kind !== "connected" || !s.currentStem) {
			s.pushToast("draft:offline", "Not connected; draft kept");
			return;
		}
		if (draft.kind === "edit") {
			// Fork the edited message: navigate to its parent then prompt. The
			// AgentSession forks at the parent, producing a sibling user turn.
			if (s.document.status.isStreaming || s.document.status.isCompacting) return;
			const entry = s.document.entries[draft.entryId];
			if (!entry) return;
			// The fork re-sends the edited message; carry its images so the fork
			// doesn't silently drop attachments (edit UI only covers text).
			const entryImages =
				entry.kind === "message" ? entry.content.filter((c): c is ImageContent => c.type === "image") : undefined;
			const savedDraft = draft;
			getStore().getState().clearDraft();
			const navReply = await rpc.navigate(entry.parentId);
			if (!navReply?.ok) {
				getStore().getState().setDraft(savedDraft); // navigate failed; edit intact
				return;
			}
			const promptReply = await rpc.prompt(text, entryImages);
			if (!promptReply?.ok) {
				// Leaf moved to the parent (the intended fork point); restore as
				// a compose draft so retrying forks at the same place.
				getStore().getState().setDraft({ kind: "compose", text });
				return;
			}
		} else {
			// Compose: streaming is OK (queues a steer); only compaction blocks.
			if (s.document.status.isCompacting) return;
			requestNotificationPermission();
			const savedDraft = draft;
			getStore().getState().clearDraft();
			const reply = await rpc.prompt(text, draftImages);
			if (!reply?.ok) {
				getStore().getState().setDraft(savedDraft);
				return;
			}
		}
	}, [rpc]);

	const handleNavigate = useCallback(
		(entryId: string) => {
			if (isBusy) return;
			rpc.navigate(entryId);
		},
		[isBusy, rpc],
	);

	const handleEdit = useCallback(
		(entryId: string, index: number, text: string) => {
			if (isBusy) return;
			const s = getStore().getState();
			if (s.draft.kind === "edit") return; // already editing
			s.beginEdit(entryId, index, text);
		},
		[isBusy],
	);

	// Attach, don't retarget: opening a session resolves-or-creates an
	// activation on the daemon and rebinds this connection (ADR 11) — the
	// previously attached session keeps running headless. No isBusy guard:
	// streaming on the old attachment is not a reason to reject a switch.
	// (The serial-switch rule in useRpc still rejects a second open while one
	// is in flight — that one is a real candidate-promotion race.)
	const handleOpenSession = useCallback(
		(projectId: string, stem: string, sessionId?: string) => {
			// Passing the id lets the client seed a cache cursor (ADR 09) instead of
			// falling back to a full replace on every UI session switch.
			rpc.openSession(projectId, stem, sessionId);
		},
		[rpc],
	);

	const handleNewSession = useCallback(
		(projectId: string) => {
			rpc.newSession(projectId);
		},
		[rpc],
	);

	const handleOpenProject = useCallback(
		(projectId: string) => {
			rpc.openProject(projectId);
		},
		[rpc],
	);

	const handleShowLauncher = useCallback(() => {
		void rpc.detach();
	}, [rpc]);

	const handleLoadFolder = useCallback(
		(projectId: string) => {
			rpc.loadFolderSessions(projectId);
		},
		[rpc],
	);

	const handleLoadMoreFolder = useCallback(
		(projectId: string) => {
			rpc.loadMoreFolderSessions(projectId);
		},
		[rpc],
	);

	// ── Keyboard navigation (document-level, via useAppKeybindings) ──────────
	// Handlers read fresh store state at event time (getStore().getState())
	// and the latest `vm` (the hook stores them in a ref, so the listener is
	// attached once while always dispatching against current closures).

	const handleExpandComposer = useCallback(() => {
		if (isBusy) return;
		if (connection.kind !== "connected") return;
		const s = getStore().getState();
		if (!s.composerExpanded) s.setComposerExpanded(true);
	}, [isBusy, connection]);

	const handleNavigateTurn = useCallback(
		(direction: "prev" | "next") => {
			// Skip system dividers — they aren't content to read or act on.
			const nav = vm.turns.filter((t) => t.kind === "user" || t.kind === "assistant");
			if (nav.length === 0) return;
			const s = getStore().getState();
			// Turn key, not entryId: turnKey stays the identity contract even
			// though run-merged turns never split — keying on entryId would break
			// again the moment a split rule returns.
			let idx = nav.findIndex((t) => turnKeyOf(t) === s.focusedTurnId);
			if (idx === -1) idx = findTurnNearestCenter(nav);
			idx = direction === "next" ? idx + 1 : idx - 1;
			idx = Math.max(0, Math.min(nav.length - 1, idx));
			s.setFocusedTurnId(turnKeyOf(nav[idx]));
		},
		[vm],
	);

	const handleJumpTurn = useCallback(
		(edge: "first" | "last") => {
			const nav = vm.turns.filter((t) => t.kind === "user" || t.kind === "assistant");
			if (nav.length === 0) return;
			const target = edge === "first" ? nav[0] : nav[nav.length - 1];
			getStore().getState().setFocusedTurnId(turnKeyOf(target));
		},
		[vm],
	);

	const handleToggleFocusedGroup = useCallback(() => {
		const s = getStore().getState();
		const id = s.focusedTurnId;
		if (!id) return;
		const turn = vm.turns.find((t) => turnKeyOf(t) === id && t.kind === "assistant");
		if (!turn || turn.kind !== "assistant") return;
		const firstGroup = segmentBlocks(turn.blocks).find((seg) => seg.kind === "group");
		if (!firstGroup || firstGroup.kind !== "group") return;
		const cardKeys = firstGroup.steps.map((h) => `${h.entryId}:b${h.blockIndex}`);
		s.toggleActionGroup(firstGroup.key, cardKeys);
	}, [vm]);

	const handleEditFocused = useCallback(() => {
		if (isBusy) return;
		const s = getStore().getState();
		const id = s.focusedTurnId;
		if (!id) return;
		const turn = vm.turns.find((t) => turnKeyOf(t) === id && t.kind === "user");
		if (!turn || turn.kind !== "user") return;
		handleEdit(turn.entryId, turn.index, turn.text);
	}, [vm, isBusy, handleEdit]);

	const handleCopyFocused = useCallback(async () => {
		const s = getStore().getState();
		const id = s.focusedTurnId;
		if (!id) return;
		const turn = vm.turns.find((t) => turnKeyOf(t) === id);
		if (!turn) return;
		let text: string;
		if (turn.kind === "user") {
			text = turn.text;
		} else if (turn.kind === "assistant") {
			text = turn.blocks
				.filter((b): b is TextBlockVM => b.blockType === "text")
				.map((b) => b.text)
				.join("\n\n");
		} else {
			return; // system — nothing to copy
		}
		await copyToClipboard(text);
	}, [vm]);

	const handleBranchSibling = useCallback(
		(direction: "prev" | "next") => {
			if (isBusy) return;
			const s = getStore().getState();
			const id = s.focusedTurnId;
			if (!id) return;
			const turn = vm.turns.find((t) => turnKeyOf(t) === id && t.kind === "user");
			if (!turn || turn.kind !== "user") return;
			const { siblings, currentSiblingIndex: idx } = turn;
			if (!siblings || siblings.length <= 1 || idx === undefined) return;
			const target = direction === "prev" ? siblings[idx - 1] : siblings[idx + 1];
			if (!target) return;
			const leafId = newestLeafInSubtree(target, s.document.entries);
			// Repoint focus to the target sibling so the ring follows the branch
			// across the async navigate (the old sibling leaves the active path
			// and would otherwise drop focus, breaking consecutive h/l).
			s.setFocusedTurnId(target);
			handleNavigate(leafId);
		},
		[vm, isBusy, handleNavigate],
	);

	// Alt+↑/↓ — cycle the active sessions (global snapshot, newest first —
	// the sidebar's pinned order). Cyclic; from the launcher (nothing
	// attached) both directions open the newest. Live mid-stream: switching is
	// an attach (ADR 11), not a retarget of the streaming instance.
	const handleCycleActiveSession = useCallback(
		(direction: "prev" | "next") => {
			const s = getStore().getState();
			const list = s.activeSessions;
			if (list.length === 0) return;
			const idx = list.findIndex(
				(r) =>
					(r.projectId === s.currentProjectId && r.stem === s.currentStem) || r.sessionId === s.activeSessionId,
			);
			const len = list.length;
			const target = idx === -1 ? list[0] : list[direction === "next" ? (idx + 1) % len : (idx - 1 + len) % len];
			if (target.projectId === s.currentProjectId && target.stem === s.currentStem) return;
			handleOpenSession(target.projectId, target.stem, target.sessionId);
		},
		[handleOpenSession],
	);

	const handleNewSessionShortcut = useCallback(() => {
		const s = getStore().getState();
		if (s.projects.length === 1) {
			handleNewSession(s.projects[0].id);
		} else if (s.projects.length > 1) {
			// Multi-project: surface the sidebar's project picker rather than guess.
			newSessionRef.current();
		}
	}, [handleNewSession]);

	useAppKeybindings({
		onCycleModel: handleCycleModel,
		onExpandComposer: handleExpandComposer,
		onNavigateTurn: handleNavigateTurn,
		onJumpTurn: handleJumpTurn,
		onToggleFocusedGroup: handleToggleFocusedGroup,
		onEditFocused: handleEditFocused,
		onCopyFocused: handleCopyFocused,
		onBranchSibling: handleBranchSibling,
		onCycleActiveSession: handleCycleActiveSession,
		onNewSession: handleNewSessionShortcut,
		onToggleSidebar: () => sidebarToggleRef.current(),
		onToggleHistory: () => {
			const s = getStore().getState();
			s.setHistoryOpen(!s.historyOpen);
		},
	});

	return (
		<div className={styles.root}>
			<ToastBar />
			{/* TopBar */}
			<TopBar
				name={statusName}
				connection={connection}
				onSidebarToggle={() => sidebarToggleRef.current()}
				onHistory={() => setHistoryOpen(!historyOpen)}
				onRename={async (name) => {
					await rpc.renameSession(name);
				}}
				onRetry={retry}
			/>

			<div className={styles.body}>
				{/* Sidebar — Project folders with their sessions (ADR 11) */}
				<Sidebar
					projects={projects}
					currentProjectId={currentProjectId}
					currentStem={currentStem}
					activeSessions={activeSessions}
					sessionPages={sessionPages}
					onOpenSession={handleOpenSession}
					onNewSession={handleNewSession}
					onShowLauncher={handleShowLauncher}
					onLoadFolder={handleLoadFolder}
					onLoadMoreFolder={handleLoadMoreFolder}
					toggleRef={sidebarToggleRef}
					newSessionRef={newSessionRef}
				/>

				{/* Conversation or the Project home */}
				<div className={styles.conversation}>
					{hasOpenSession ? (
						<>
							<ConversationArea
								vm={vm}
								isStreaming={isStreaming}
								onToggleGroup={handleToggleGroup}
								onToggleStep={handleToggleStep}
								onNavigate={handleNavigate}
								onEdit={handleEdit}
							/>
							<Composer
								onCommit={handleCommit}
								onStop={rpc.abort}
								onDiscardSteer={rpc.discardSteer}
								isBusy={isBusy}
								connected={connection.kind === "connected"}
								model={statusModel}
								thinkingLevel={statusThinkingLevel}
								models={models}
								scopedModels={scopedModels}
								thinkingLevels={thinkingLevels}
								isStreaming={isStreaming}
								onSetModel={rpc.setModel}
								onSetThinkingLevel={rpc.setThinkingLevel}
								onCycleModel={handleCycleModel}
							/>
						</>
					) : (
						<Launcher
							connection={connection}
							projects={projects}
							activeSessions={activeSessions}
							projectId={currentProjectId}
							onOpenProject={handleOpenProject}
							onOpenSession={handleOpenSession}
							onNewSession={handleNewSession}
							retry={retry}
						/>
					)}
				</div>
			</div>
			{hasOpenSession && <HistoryPane />}
			<FileViewer />
		</div>
	);
}

// ---------------------------------------------------------------------------
// findTurnNearestCenter — when no turn is focused (or the focused entry is
// stale / off-path), j/k snap to the turn closest to the viewport's vertical
// center. Gmail-style: the first navigation after the page lands where your
// eye already is. Pure DOM read; returns the index into `turns`.
// ---------------------------------------------------------------------------

function findTurnNearestCenter(turns: TurnVM[]): number {
	let best = 0;
	let bestDist = Infinity;
	const viewCenter = window.innerHeight / 2;
	for (let i = 0; i < turns.length; i++) {
		const el = document.querySelector(`[data-turn-key="${CSS.escape(turnKeyOf(turns[i]))}"]`);
		if (!el) continue;
		const rect = el.getBoundingClientRect();
		if (rect.height === 0) continue;
		const center = rect.top + rect.height / 2;
		const dist = Math.abs(center - viewCenter);
		if (dist < bestDist) {
			bestDist = dist;
			best = i;
		}
	}
	return best;
}

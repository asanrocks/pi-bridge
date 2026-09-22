// ============================================================================
// useRpc — typed verb wrappers around the singleton BridgeClient.
// Available immediately via ref pattern (getGlobalClient), no null-on-first-
// render issue. Toasts on failure.
// ============================================================================

import { useCallback, useMemo } from "react";
import type {
	GitShowReply,
	ImageContent,
	ListActiveSessionsReply,
	ListFilesReply,
	ListSessionsReply,
	ModelRef,
	PrefixCursor,
	RpcReply,
	SessionInfo,
	SessionRef,
} from "../../../../src/core/index.ts";
import { projectPath, sessionPath, writeRoute } from "../lib/routes.ts";
import { sortByLastActivity } from "../lib/sortByLastActivity.ts";
import { rememberAddress } from "../persist/addressIndex.ts";
import { prepareSwitch } from "../persist/entryCache.ts";
import { getStore } from "../state/store.tsx";
import { selectRenderDiverged } from "../state/ui.ts";
import { getGlobalClient } from "./client.ts";
import { openSessionAddress } from "./sessionBoot.ts";
import { discardSessionCandidate, sessionCandidatePending } from "./sessionCandidate.ts";
import { projectPageFromReply, SESSION_PAGE_SIZE } from "./sessionList.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rpcErrorToast(err: unknown, fallback?: string): void {
	const message = err instanceof Error ? err.message : typeof err === "string" ? err : (fallback ?? "Unknown error");
	getStore().getState().pushToast(`rpc:${Date.now()}`, message);
}

/**
 * Run one RPC, toasting on failure and returning the reply so callers can
 * branch on success. `reply.ok === false` toasts and returns the reply;
 * a throw / missing client toasts and returns undefined.
 */
async function rpc(fn: () => Promise<RpcReply> | undefined, fallback: string): Promise<RpcReply | undefined> {
	try {
		const reply = await fn();
		if (reply && !reply.ok) rpcErrorToast(reply.error, fallback);
		return reply;
	} catch (err) {
		rpcErrorToast(err, fallback);
		return undefined;
	}
}

/** Record the address of every returned row so a later cold load can find the
 * cache cursor (ADR 09 keyed by sessionId, ADR 11 addressed by stem). */
function rememberRows(rows: SessionInfo[] | undefined): void {
	if (!rows) return;
	for (const row of rows) rememberAddress(row.projectId, row.stem, row.sessionId);
}

// ---------------------------------------------------------------------------
// useRpc
// ---------------------------------------------------------------------------

export function useRpc() {
	const prompt = useCallback(
		(text: string, images?: ImageContent[]) => rpc(() => getGlobalClient()?.prompt(text, images), "prompt failed"),
		[],
	);

	const abort = useCallback(() => rpc(() => getGlobalClient()?.abort(), "abort failed"), []);

	const discardSteer = useCallback(() => rpc(() => getGlobalClient()?.discardSteer(), "discard steer failed"), []);

	const setModel = useCallback(
		(provider: string, model: string) => rpc(() => getGlobalClient()?.setModel(provider, model), "set model failed"),
		[],
	);

	const setThinkingLevel = useCallback(
		(level: string) => rpc(() => getGlobalClient()?.setThinkingLevel(level), "set thinking level failed"),
		[],
	);

	const renameSession = useCallback(async (name: string) => {
		// The server broadcasts sessions_changed for the Project (ADR 11), so
		// no client-side refresh is needed.
		await rpc(() => getGlobalClient()?.renameSession(name), "rename session failed");
	}, []);

	const navigate = useCallback(
		(entryId: string | null) => rpc(() => getGlobalClient()?.navigate(entryId), "navigate failed"),
		[],
	);

	/** Resolve-or-activate a session by address and make it the current one. */
	const openSession = useCallback(async (projectId: string, stem: string, sessionId?: string) => {
		// Serial-switch rule (ADR 09): a second open while a candidate is
		// pending would race the first promotion.
		if (sessionCandidatePending()) return;
		const store = getStore();
		// An explicit open is a real navigation: it leaves the alias view and
		// commits a real URL (ADR 13).
		store.getState().setAddressViaAlias(false);
		const previous = { projectId: store.getState().currentProjectId, stem: store.getState().currentStem };
		// Optimistic address commit: the URL and header update before the
		// initial-sync push lands.
		store.getState().setCurrentSession(projectId, stem);
		writeRoute({ kind: "session", projectId, stem });

		let cursor: PrefixCursor | undefined;
		if (sessionId) cursor = await prepareSwitch(sessionId);
		const reply = await rpc(() => getGlobalClient()?.openSession(projectId, stem, cursor), "open session failed");
		// The initial-sync push already promoted (or the open failed).
		discardSessionCandidate();
		if (!reply?.ok) {
			// A failed open leaves the server's previous attachment untouched, so
			// restore the previous address instead of clearing to the launcher —
			// otherwise the client would show no session while the server keeps
			// the old Manager attached (uncollectable, and a UI/route mismatch).
			const { projectId: prevProjectId, stem: prevStem } = previous;
			store.getState().setCurrentSession(prevProjectId, prevStem);
			if (prevProjectId === null) writeRoute({ kind: "launcher" });
			else if (prevStem === null) writeRoute({ kind: "project", projectId: prevProjectId });
			else writeRoute({ kind: "session", projectId: prevProjectId, stem: prevStem });
		}
	}, []);

	/** Open a Project's home (compose-only) without a session attached. */
	const openProject = useCallback(async (projectId: string) => {
		const store = getStore();
		if (store.getState().currentStem !== null) {
			await rpc(() => getGlobalClient()?.detach(), "detach failed");
			discardSessionCandidate();
		}
		store.getState().setAddressViaAlias(false);
		store.getState().setCurrentSession(projectId, null);
		writeRoute({ kind: "project", projectId });
	}, []);

	/** Create a session in a Project by sending its first prompt. The prompt
	 * (with optional attachments and a pre-session model choice) is admitted
	 * server-side before the attach (ADR 12 slice) — the initial sync the
	 * client navigates into carries the in-flight turn. Returns true on
	 * success so the caller can clear (or keep) its draft. */
	const newSession = useCallback(
		async (
			projectId: string,
			text: string,
			options?: { images?: ImageContent[]; model?: ModelRef; thinkingLevel?: string },
		) => {
			const reply = await rpc(() => getGlobalClient()?.newSession(projectId, text, options), "new session failed");
			if (reply?.ok) {
				const ref = (reply as unknown as { session?: SessionRef }).session;
				if (ref) {
					rememberAddress(ref.projectId, ref.stem, ref.sessionId);
					getStore().getState().setAddressViaAlias(false);
					getStore().getState().setCurrentSession(ref.projectId, ref.stem);
					writeRoute({ kind: "session", projectId: ref.projectId, stem: ref.stem });
				}
			}
			return reply?.ok === true;
		},
		[],
	);

	/** Open the alias address `/@latest` (ADR 13): open the most recently
	 * active live session (the global snapshot) without leaving the alias URL.
	 * Any later explicit navigation rewrites the URL to the real address; a
	 * reload re-resolves the alias, possibly onto a newer session. */
	const openLatest = useCallback(async () => {
		if (sessionCandidatePending()) return;
		const target = sortByLastActivity(getStore().getState().activeSessions)[0] ?? null;
		const client = getGlobalClient();
		if (!target || !client) return;
		writeRoute({ kind: "alias", alias: "latest" });
		try {
			await openSessionAddress(client, target.projectId, target.stem, () => false, { viaAlias: true });
		} catch (err) {
			rpcErrorToast(err, "open latest failed");
		}
	}, []);

	/** Back to the Launcher: unbind server-side, then clear local state. */
	const detach = useCallback(async () => {
		const reply = await rpc(() => getGlobalClient()?.detach(), "detach failed");
		if (reply?.ok) {
			discardSessionCandidate();
			getStore().getState().clearCurrentSession();
			writeRoute({ kind: "launcher" });
		}
	}, []);

	/** Terminate a session's live instance (closeSession verb). Destructive
	 * and unconfirmed by design — the daemon disposes the activation now
	 * (aborting + flushing any in-flight turn); the history file survives, so
	 * the row simply drops from the active snapshot. */
	const closeSession = useCallback(
		async (projectId: string, stem: string) => {
			const reply = await rpc(() => getGlobalClient()?.closeSession(projectId, stem), "close session failed");
			if (!reply?.ok) return;
			const store = getStore();
			if (store.getState().currentProjectId === projectId && store.getState().currentStem === stem) {
				// The viewed session died: the server-side attachment is severed, so
				// detach the stale binding and land on the Project home with a fresh
				// history page (openProject does both).
				await openProject(projectId);
			}
		},
		[openProject],
	);

	/** Close a session, then move its file under the archive prefix
	 * (archiveSession verb). The close is unconditional and unconfirmed; the
	 * row leaves the active snapshot and the history page, and the file is no
	 * longer discovered. When the archived address is the one on screen, land
	 * on the Project home like closeSession does — the server-side binding is
	 * severed either way. */
	const archiveSession = useCallback(
		async (projectId: string, stem: string) => {
			const reply = await rpc(() => getGlobalClient()?.archiveSession(projectId, stem), "archive session failed");
			if (!reply?.ok) return;
			const store = getStore();
			if (store.getState().currentProjectId === projectId && store.getState().currentStem === stem) {
				await openProject(projectId);
			}
		},
		[openProject],
	);

	/** Refresh the global active/streaming snapshot without side effects. */
	const refreshActiveSessions = useCallback(async () => {
		const reply = await getGlobalClient()?.listActiveSessions();
		if (reply?.ok) {
			const data = reply as unknown as ListActiveSessionsReply;
			rememberRows(data.sessions);
			getStore()
				.getState()
				.setActiveSessions(data.sessions ?? []);
		}
	}, []);

	/** Fetch a sidebar folder's first session page (lazy, on expand). Also the
	 * retry path: an existing error page is re-fetched, a ready/loading one is
	 * left alone. A missing client (offline expand) lands in the error state
	 * without a toast — the folder shows Retry and heals on reconnect. */
	const loadFolderSessions = useCallback(async (projectId: string) => {
		const store = getStore();
		const existing = store.getState().sessionPages[projectId];
		if (existing && existing.kind !== "error") return;
		store.getState().beginSessionPage(projectId);
		const reply = await rpc(
			() => getGlobalClient()?.listSessions(projectId, SESSION_PAGE_SIZE),
			"load sessions failed",
		);
		// Superseded (reconnect reset or a concurrent retry re-began the load):
		// leave the newer state alone.
		if (store.getState().sessionPages[projectId]?.kind !== "loading") return;
		const page = projectPageFromReply(reply);
		if (page) {
			store.getState().setSessionPage(projectId, page.sessions, page.hasMore, page.nextCursor);
		} else {
			store.getState().setSessionPageError(projectId);
		}
	}, []);

	/** Load the next page of a sidebar folder's history. */
	const loadMoreFolderSessions = useCallback(async (projectId: string) => {
		const page = getStore().getState().sessionPages[projectId];
		if (!page || page.kind !== "ready") return;
		const reply = await rpc(
			() => getGlobalClient()?.listSessions(projectId, SESSION_PAGE_SIZE, page.nextCursor),
			"load more sessions failed",
		);
		if (reply?.ok) {
			const r = reply as unknown as ListSessionsReply;
			const sessions = (r.sessions as SessionInfo[] | undefined) ?? [];
			rememberRows(sessions);
			getStore()
				.getState()
				.appendSessionPage(projectId, sessions, r.hasMore === true, r.nextCursor ?? null);
		}
	}, []);

	return useMemo(
		() => ({
			prompt,
			abort,
			discardSteer,
			setModel,
			setThinkingLevel,
			renameSession,
			navigate,
			openSession,
			openProject,
			openLatest,
			newSession,
			detach,
			closeSession,
			archiveSession,
			refreshActiveSessions,
			loadFolderSessions,
			loadMoreFolderSessions,
		}),
		[
			prompt,
			abort,
			discardSteer,
			setModel,
			setThinkingLevel,
			renameSession,
			navigate,
			openSession,
			openProject,
			openLatest,
			newSession,
			detach,
			closeSession,
			archiveSession,
			refreshActiveSessions,
			loadFolderSessions,
			loadMoreFolderSessions,
		],
	);
}

/** Path completion (ADR 12): `prefix` resolves against the Project's cwd, so
 * the Project home completes pre-send without a session attached. */
export async function listFilesRpc(
	projectId: string,
	prefix: string,
): Promise<Array<{ path: string; isDirectory: boolean }>> {
	const client = getGlobalClient();
	if (!client) return [];
	try {
		const reply = await client.listFiles(projectId, prefix);
		if (!reply.ok) return [];
		const r = reply as unknown as ListFilesReply;
		return (r.entries as Array<{ path: string; isDirectory: boolean }>) ?? [];
	} catch {
		return [];
	}
}

/**
 * Branch-target selection matrix, shared by the conversation sibling pager
 * and the keyboard ring: when the session is idle and the rendering leaf
 * follows the live leaf, this is a real branch switch (navigate RPC); while
 * busy or peeking it degrades to a read-only rendering-leaf re-target —
 * browse never mutates. Callers pass the subtree's newest leaf
 * (`newestLeafInSubtree`); `setRenderLeaf` clamps uncommitted targets to
 * their nearest committed ancestor.
 */
export function useBranchSelect() {
	const { navigate } = useRpc();
	return useCallback(
		(targetLeaf: string | null) => {
			const s = getStore().getState();
			const busy = s.document.status.isStreaming || s.document.status.isCompacting;
			if (!busy && !selectRenderDiverged(s)) {
				void navigate(targetLeaf);
				return;
			}
			s.setRenderLeaf(targetLeaf);
		},
		[navigate],
	);
}

/** ADR 10 v2: fetch `git show --stat` output for a recorded commit. Returns
 * null on any failure (no client, ok:false, throw) — the caller renders a
 * graceful "not available" state; no toast, the failure is expected for
 * rebased-away commits. */
export async function gitShowRpc(commit: string): Promise<{ output: string; truncated: boolean } | null> {
	const client = getGlobalClient();
	if (!client) return null;
	try {
		const reply = await client.gitShow(commit);
		if (!reply.ok) return null;
		const r = reply as unknown as GitShowReply;
		return { output: r.output, truncated: r.truncated };
	} catch {
		return null;
	}
}

/** ADR 11: the Project home URL, for callers that need it without the hook. */
export { projectPath, sessionPath };

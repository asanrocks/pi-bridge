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
	PrefixCursor,
	RpcReply,
	SessionInfo,
	SessionRef,
} from "../../../src/core/index.ts";
import { rememberAddress } from "./addressIndex.ts";
import { getGlobalClient } from "./client.ts";
import { prepareSwitch } from "./entryCache.ts";
import { projectPath, sessionPath, writeRoute } from "./routes.ts";
import { discardSessionCandidate, sessionCandidatePending } from "./sessionCandidate.ts";
import { getStore } from "./store.tsx";

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

	/** Open a Project's home (session browser) without a session attached. */
	const openProject = useCallback(async (projectId: string) => {
		const store = getStore();
		if (store.getState().currentStem !== null) {
			await rpc(() => getGlobalClient()?.detach(), "detach failed");
			discardSessionCandidate();
		}
		store.getState().setCurrentSession(projectId, null);
		writeRoute({ kind: "project", projectId });
	}, []);

	const newSession = useCallback(async (projectId: string) => {
		const reply = await rpc(() => getGlobalClient()?.newSession(projectId), "new session failed");
		if (reply?.ok) {
			const ref = (reply as unknown as { session?: SessionRef }).session;
			if (ref) {
				rememberAddress(ref.projectId, ref.stem, ref.sessionId);
				getStore().getState().setCurrentSession(ref.projectId, ref.stem);
				writeRoute({ kind: "session", projectId: ref.projectId, stem: ref.stem });
			}
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

	const loadMoreSessions = useCallback(async () => {
		const state = getStore().getState();
		const projectId = state.currentProjectId;
		if (!projectId) return;
		const reply = await rpc(
			() => getGlobalClient()?.listSessions(projectId, 10, state.sessionsNextCursor),
			"load more sessions failed",
		);
		if (reply?.ok) {
			const r = reply as unknown as ListSessionsReply;
			const sessions = (r.sessions as SessionInfo[] | undefined) ?? [];
			rememberRows(sessions);
			getStore()
				.getState()
				.appendSessions(sessions, r.hasMore === true, r.nextCursor ?? null);
		}
	}, []);

	const listFiles = useCallback(async (prefix: string) => {
		return listFilesRpc(prefix);
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
			newSession,
			detach,
			refreshActiveSessions,
			loadMoreSessions,
			listFiles,
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
			newSession,
			detach,
			refreshActiveSessions,
			loadMoreSessions,
			listFiles,
		],
	);
}

export async function listFilesRpc(prefix: string): Promise<Array<{ path: string; isDirectory: boolean }>> {
	const client = getGlobalClient();
	if (!client) return [];
	try {
		const reply = await client.listFiles(prefix);
		if (!reply.ok) return [];
		const r = reply as unknown as ListFilesReply;
		return (r.entries as Array<{ path: string; isDirectory: boolean }>) ?? [];
	} catch {
		return [];
	}
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

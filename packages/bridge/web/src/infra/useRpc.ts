// ============================================================================
// useRpc — typed verb wrappers around the singleton BridgeClient.
// Available immediately via ref pattern (getGlobalClient), no null-on-first-
// render issue. Toasts on failure.
// ============================================================================

import { useCallback, useMemo } from "react";
import type {
	ImageContent,
	InstanceInfo,
	ListFilesReply,
	ListSessionsReply,
	PrefixCursor,
	RpcReply,
	SessionInfo,
} from "../../../src/core/index.ts";
import { getGlobalClient } from "./client.ts";
import { prepareSwitch } from "./entryCache.ts";
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
 * branch on success. Collapses the per-verb try/!ok/catch boilerplate:
 * - `reply.ok === false`  → toast (here), return the reply (caller does its
 *   failure-side work, e.g. rollback, without re-toasting).
 * - thrown / no client    → toast (here), return undefined.
 * Returning the reply (rather than void) is what lets the verbs with
 * success-side logic keep their branch while shedding their try/catch.
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
		const reply = await rpc(() => getGlobalClient()?.renameSession(name), "rename session failed");
		if (reply?.ok) {
			// Refresh instance list so the sidebar picks up the new name
			// (the server-side document.status.name was updated via
			// session_info_changed → applyEvent, but the client's instance
			// list is stale until re-queried).
			const instReply = await getGlobalClient()?.listInstances();
			if (instReply?.ok) {
				const mData = instReply as unknown as { ok: boolean; instances: InstanceInfo[] };
				if (mData.instances) {
					getStore().getState().syncInstances({ instances: mData.instances });
				}
			}
		}
	}, []);

	const navigate = useCallback(
		(entryId: string | null) => rpc(() => getGlobalClient()?.navigate(entryId), "navigate failed"),
		[],
	);

	const switchSession = useCallback(async (sessionPath: string, sessionId?: string) => {
		// Serial-switch rule (ADR 09): a second switch while a candidate is
		// pending would race the first promotion — ignore it.
		if (sessionCandidatePending()) return;
		let cursor: PrefixCursor | undefined;
		if (sessionId) cursor = await prepareSwitch(sessionId);
		const reply = await rpc(() => getGlobalClient()?.switchSession(sessionPath, cursor), "switch session failed");
		// The initial-sync push already promoted (or the switch failed / was a
		// no-op): any orphan candidate is dropped.
		discardSessionCandidate();
		if (reply?.ok) {
			// Refresh instances so the attached instance's current sessionId
			// (used to key draft persistence) tracks the server's new session.
			const instReply = await getGlobalClient()?.listInstances();
			if (instReply?.ok) {
				const mData = instReply as unknown as { ok: boolean; instances: InstanceInfo[] };
				if (mData.instances) getStore().getState().syncInstances({ instances: mData.instances });
			}
		}
	}, []);

	const newSession = useCallback(async () => {
		const reply = await rpc(() => getGlobalClient()?.newSession(), "new session failed");
		if (reply?.ok) {
			const instReply = await getGlobalClient()?.listInstances();
			if (instReply?.ok) {
				const mData = instReply as unknown as { ok: boolean; instances: InstanceInfo[] };
				if (mData.instances) getStore().getState().syncInstances({ instances: mData.instances });
			}
		}
	}, []);

	const switchInstance = useCallback(async (instanceId: string) => {
		if (sessionCandidatePending()) return;
		// Live instance switch: same rebind window as a session switch — seed
		// a candidate from the target instance's cache so old-instance patches
		// keep flowing to the active mirror until the target initial sync.
		const target = getStore()
			.getState()
			.instances.find((inst) => inst.instanceId === instanceId);
		const cursor = target?.sessionId ? await prepareSwitch(target.sessionId) : undefined;
		const reply = await rpc(() => getGlobalClient()?.switchInstance(instanceId, cursor), "switch instance failed");
		discardSessionCandidate();
		if (reply?.ok) {
			// The replace push from the new instance confirms attachment
			getStore().getState().syncInstances({ attachedInstanceId: instanceId });
			// Fetch sessions for the attached instance's cwd
			const sessReply = await getGlobalClient()?.listSessions(10);
			if (sessReply?.ok) {
				const sessData = sessReply as unknown as ListSessionsReply;
				if (sessData.sessions) {
					getStore()
						.getState()
						.replaceSessions(sessData.sessions as SessionInfo[], sessData.hasMore === true);
				}
			}
		} else {
			// Roll back optimistic attachedInstanceId set by handleSwitchInstance.
			// Covers both !ok (toast already fired in rpc()) and a missing
			// client / thrown call (no client ⇒ nothing is attached, null is
			// the correct state).
			getStore().getState().syncInstances({ attachedInstanceId: null });
		}
	}, []);

	const newInstance = useCallback(async (cwd: string) => {
		const reply = await rpc(() => getGlobalClient()?.newInstance(cwd), "new instance failed");
		if (reply?.ok) {
			const r = reply as unknown as { ok: boolean; instanceId: string };
			if (r.instanceId) {
				getStore().getState().syncInstances({ attachedInstanceId: r.instanceId });
			}
			// Refresh instance list
			const instReply = await getGlobalClient()?.listInstances();
			if (instReply?.ok) {
				const mData = instReply as unknown as { ok: boolean; instances: InstanceInfo[] };
				if (mData.instances) {
					getStore().getState().syncInstances({ instances: mData.instances });
				}
			}
			// Fetch sessions for the new project's cwd
			const sessReply = await getGlobalClient()?.listSessions(10);
			if (sessReply?.ok) {
				const sessData = sessReply as unknown as ListSessionsReply;
				if (sessData.sessions) {
					getStore()
						.getState()
						.replaceSessions(sessData.sessions as SessionInfo[], sessData.hasMore === true);
				}
			}
		}
	}, []);

	const killInstance = useCallback(async (instanceId: string) => {
		const reply = await rpc(() => getGlobalClient()?.killInstance(instanceId), "kill instance failed");
		if (reply?.ok) {
			// Refresh manager list — the killed project is removed
			const instReply = await getGlobalClient()?.listInstances();
			if (instReply?.ok) {
				const mData = instReply as unknown as { ok: boolean; instances: InstanceInfo[] };
				if (mData.instances) {
					getStore().getState().syncInstances({ instances: mData.instances });
				}
			}
		}
	}, []);

	/** Refresh the instance list without side effects. Used by the Launcher's
	 * liveness poll while unattached (no instances_changed push yet). */
	const refreshInstances = useCallback(async () => {
		const reply = await getGlobalClient()?.listInstances();
		if (reply?.ok) {
			const mData = reply as unknown as { instances: InstanceInfo[] };
			if (mData.instances) {
				getStore().getState().syncInstances({ instances: mData.instances });
			}
		}
	}, []);

	const loadMoreSessions = useCallback(async (ts: string) => {
		const reply = await rpc(() => getGlobalClient()?.listSessions(10, ts), "load more sessions failed");
		if (reply?.ok) {
			const r = reply as unknown as ListSessionsReply;
			const sessions = (r.sessions as SessionInfo[] | undefined) ?? [];
			const hasMore = r.hasMore === true;
			getStore().getState().appendSessions(sessions, hasMore);
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
			switchSession,
			newSession,
			switchInstance,
			newInstance,
			killInstance,
			refreshInstances,
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
			switchSession,
			newSession,
			switchInstance,
			newInstance,
			killInstance,
			refreshInstances,
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

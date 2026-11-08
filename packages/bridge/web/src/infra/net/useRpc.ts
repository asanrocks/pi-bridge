// ============================================================================
// useRpc — typed verb wrappers around the singleton BridgeClient.
// Available immediately via ref pattern (getGlobalClient), no null-on-first-
// render issue. Toasts on failure.
// ============================================================================

import { useCallback, useMemo } from "react";
import type {
	AsrCredential,
	AsrCredentialsReply,
	DirectoryListing,
	GitBaseReply,
	GitDiffReply,
	GitDiffState,
	GitShowReply,
	ImageContent,
	ListDirectoryReply,
	ListFilesReply,
	ListQueueReply,
	ListSessionsReply,
	ModelRef,
	PinnedModelSelection,
	ReadFileReply,
	RpcReply,
	SessionInfo,
	SessionLocation,
	SnapshotFile,
	SnapshotState,
	TextPolishReply,
} from "../../../../src/core/index.ts";
import { projectPath, sessionPath } from "../lib/routes.ts";
import { rememberAddress } from "../persist/addressIndex.ts";
import { getStore } from "../state/store.tsx";
import { selectRenderDiverged } from "../state/ui.ts";
import { getGlobalClient } from "./client.ts";
import {
	navigationCreate,
	navigationLatest,
	navigationLauncher,
	navigationOpen,
	navigationProject,
} from "./navigation.ts";
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
	/** Send a message. The reply is an admission acknowledgement (ADR 12 Reply
	 * semantics), so it arrives as soon as preflight accepted the prompt — never
	 * at turn settle. A reply-less rejection means the outcome is *unknown*, not
	 * failed: the turn may already be running, so the sender must not restore its
	 * draft (see useComposerCommit) and the toast must not read as a rejection. */
	const prompt = useCallback(
		async (text: string, images?: ImageContent[], model?: ModelRef, thinkingLevel?: string) => {
			const client = getGlobalClient();
			if (!client) {
				rpcErrorToast(new Error("Not connected"), "prompt failed");
				return undefined;
			}
			let reply: RpcReply;
			try {
				reply = await client.prompt(text, images, model, thinkingLevel);
			} catch (err) {
				getStore()
					.getState()
					.pushToast(
						"rpc:prompt-unknown",
						`Lost the reply to your message (${err instanceof Error ? err.message : String(err)}) — check the session`,
					);
				return undefined;
			}
			if (!reply.ok) rpcErrorToast(reply.error, "prompt failed");
			return reply;
		},
		[],
	);

	const abort = useCallback(() => rpc(() => getGlobalClient()?.abort(), "abort failed"), []);

	const discardSteer = useCallback(() => rpc(() => getGlobalClient()?.discardSteer(), "discard steer failed"), []);

	const setPinnedModels = useCallback(
		(models: PinnedModelSelection[]) => rpc(() => getGlobalClient()?.setPinnedModels(models), "pin model failed"),
		[],
	);

	const renameSession = useCallback(async (name: string) => {
		// The server broadcasts sessions_changed for the Project (ADR 11), so
		// no client-side refresh is needed.
		await rpc(() => getGlobalClient()?.renameSession(name), "rename session failed");
	}, []);

	const setLabel = useCallback(
		(entryId: string, label: string) => rpc(() => getGlobalClient()?.setLabel(entryId, label), "set label failed"),
		[],
	);

	const navigate = useCallback(
		(entryId: string | null) => rpc(() => getGlobalClient()?.navigate(entryId), "navigate failed"),
		[],
	);

	/** Recover the broken tail turn (ADR 16). The reply arrives after the
	 * recovered run settles (this verb is completion-style, unlike `prompt`); the
	 * client's in-flight treatment is the composer's own isBusy gate. */
	const recoverTurn = useCallback(() => rpc(() => getGlobalClient()?.recoverTurn(), "recover turn failed"), []);

	/** Resolve-or-activate a session by address and make it the current one.
	 * The transition — optimistic staging, the candidate switch, the rollback
	 * on failure — is the navigation reactor's; this wrapper reports the
	 * outcome the way the rpc helper did. A superseded transition is a silent
	 * no-op (a newer intent owns the view — nothing failed), so it toasts
	 * nothing. */
	const openSession = useCallback(async (projectId: string, stem: string, sessionId?: string) => {
		if (!getGlobalClient()) return;
		const result = await navigationOpen({ projectId, stem }, { sessionId });
		if (!result.ok && !result.superseded) {
			rpcErrorToast(new Error(result.error ?? "open session failed"), "open session failed");
		}
	}, []);

	/** Open a Project's home (compose-only) without a session attached. The
	 * detach-then-commit transition is the navigation reactor's. */
	const openProject = useCallback(async (projectId: string) => {
		if (!getGlobalClient()) return;
		const result = await navigationProject(projectId);
		if (!result.ok) rpcErrorToast(new Error(result.error ?? "detach failed"), "detach failed");
	}, []);

	/** Create a session in a Project by sending its first prompt. The prompt
	 * (with optional attachments and a pre-session model choice) is admitted
	 * server-side before the attach (ADR 12 slice) — the initial sync the
	 * client navigates into carries the in-flight turn, and the transition
	 * (including the operation id that attributes its initial sync) is the
	 * navigation reactor's. Returns true on success so the caller can clear
	 * (or keep) its draft. */
	const newSession = useCallback(
		async (
			projectId: string,
			text: string,
			options?: { images?: ImageContent[]; model?: ModelRef; thinkingLevel?: string },
		) => {
			if (!getGlobalClient()) return false;
			const result = await navigationCreate(projectId, text, options);
			if (!result.ok && !result.superseded) {
				rpcErrorToast(new Error(result.error ?? "new session failed"), "new session failed");
			}
			return result.ok;
		},
		[],
	);

	/** Open the alias address `/@latest` (ADR 13): the most recently active
	 * live Session, or the most recent durable Session across Projects (which
	 * the open activates), without leaving the alias URL. Any later explicit
	 * navigation rewrites the URL to the real address; a reload re-resolves
	 * the alias, possibly onto a newer session. */
	const openLatest = useCallback(async () => {
		if (!getGlobalClient()) return;
		const result = await navigationLatest();
		if (!result.ok) rpcErrorToast(new Error(result.error ?? "open latest failed"), "open latest failed");
	}, []);

	/** Back to the Launcher: unbind server-side (the commit is the
	 * navigation reactor's, on a successful detach), then clear local state. */
	const detach = useCallback(async () => {
		if (!getGlobalClient()) return;
		const result = await navigationLauncher();
		if (!result.ok) rpcErrorToast(new Error(result.error ?? "detach failed"), "detach failed");
	}, []);

	/** End a session's runtime, then move its file under the trash prefix
	 * (trashSession verb). Unconfirmed by design; the row leaves the queue and
	 * the history page, and the file is no longer discovered. When the trashed
	 * address is the one on screen, land on the Project home — the server-side
	 * binding is severed and the session is no longer addressable. */
	const trashSession = useCallback(
		async (projectId: string, stem: string) => {
			const reply = await rpc(() => getGlobalClient()?.trashSession(projectId, stem), "trash session failed");
			if (!reply?.ok) return;
			const store = getStore();
			if (store.getState().currentProjectId === projectId && store.getState().currentStem === stem) {
				await openProject(projectId);
			}
		},
		[openProject],
	);

	/** Refresh the global queue without side effects. */
	const refreshQueue = useCallback(async () => {
		const reply = await getGlobalClient()?.listQueue();
		if (reply?.ok) {
			const data = reply as unknown as ListQueueReply;
			rememberRows(data.sessions);
			getStore()
				.getState()
				.setQueue(data.sessions ?? []);
		}
	}, []);

	/** Place a session: Inbox, Later, or Archive. The resulting queue arrives
	 * from the daemon — the push converges every tab. Moving to Archive also
	 * ends the runtime, so a Session on screen is re-attached: the reader moved
	 * it to history, not away from the page. */
	const setSessionLocation = useCallback(
		async (projectId: string, stem: string, location: SessionLocation) => {
			const sessionId = getStore()
				.getState()
				.queue.find((r) => r.projectId === projectId && r.stem === stem)?.sessionId;
			const reply = await rpc(
				() => getGlobalClient()?.setSessionLocation(projectId, stem, location),
				"move session failed",
			);
			if (!reply?.ok) return;
			const store = getStore();
			if (location !== "archive" || store.getState().currentProjectId !== projectId) return;
			if (store.getState().currentStem !== stem) return;
			// The archive move disposed the runtime, so the binding this tab held is
			// severed (the daemon answers with `session_closed`, which lands on the
			// Project home). Re-open the address to keep reading it: an archived
			// Session is browsable history, and a fresh Activation resumes it.
			await openSession(projectId, stem, sessionId);
		},
		[openSession],
	);

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
			setPinnedModels,
			renameSession,
			setLabel,
			navigate,
			recoverTurn,
			openSession,
			openProject,
			openLatest,
			newSession,
			detach,
			trashSession,
			refreshQueue,
			setSessionLocation,
			loadFolderSessions,
			loadMoreFolderSessions,
		}),
		[
			prompt,
			abort,
			discardSteer,
			setPinnedModels,
			renameSession,
			setLabel,
			navigate,
			recoverTurn,
			openSession,
			openProject,
			openLatest,
			newSession,
			detach,
			trashSession,
			refreshQueue,
			setSessionLocation,
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
 * Dictation credentials (`asrCredentials`). Prefetched by the composer, not
 * toasted: the composer disables its control and shows the reason in place, so
 * a daemon that cannot register a device or mint a token is a capability
 * answer rather than an error the user has to dismiss.
 */
export async function asrCredentialsRpc(): Promise<{ auth: AsrCredential } | { error: string }> {
	const client = getGlobalClient();
	if (!client) return { error: "not connected" };
	try {
		const reply = await client.asrCredentials();
		if (!reply.ok) return { error: typeof reply.error === "string" ? reply.error : "credentials unavailable" };
		const auth = (reply as unknown as AsrCredentialsReply).auth;
		if (auth === undefined) return { error: "credentials unavailable" };
		return { auth };
	} catch (err) {
		return { error: err instanceof Error ? err.message : "credentials unavailable" };
	}
}

/**
 * Rewrite one draft (`textPolish`). Untoasted, like `asrCredentialsRpc`: the
 * composer states the answer in its dictation toolbar, and a press is the only
 * thing that can fail there. Cancellation is the caller's business — the client
 * has no request cancellation, so a caller that stops caring ignores the answer
 * while the daemon's own request finishes inside its timeout.
 */
export async function textPolishRpc(text: string): Promise<{ text: string } | { error: string }> {
	const client = getGlobalClient();
	if (!client) return { error: "Text polish needs a daemon connection" };
	try {
		const reply = await client.textPolish(text);
		if (!reply.ok) {
			return { error: typeof reply.error === "string" ? reply.error : "Text polish is unavailable" };
		}
		const polished = (reply as unknown as TextPolishReply).text;
		if (typeof polished !== "string") return { error: "Text polish returned nothing" };
		return { text: polished };
	} catch (err) {
		return { error: err instanceof Error ? err.message : "Text polish is unavailable" };
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

/** Resolve the comparison base for reviewing one commit (see GitBaseRequest):
 * its first parent, or the repository's empty-tree oid for a root commit.
 * Returns null on any failure — the same graceful contract as gitShowRpc; an
 * unreachable commit is expected after a rebase and has nothing to show. */
export async function gitBaseRpc(directory: string, commit: string): Promise<string | null> {
	const client = getGlobalClient();
	if (!client) return null;
	try {
		const reply = await client.gitBase(directory, commit);
		if (!reply.ok) return null;
		const r = reply as unknown as GitBaseReply;
		return r.baseline === "" ? null : r.baseline;
	} catch {
		return null;
	}
}

/** The browser's diff *directive* — the file list, statuses, and line counts
 * between two repository states under an absolute directory (see
 * GitDiffRequest). Content is fetched per file with `readFileRpc`. Returns
 * null on any failure — same graceful-failure contract as gitShowRpc. */
export async function gitDiffRpc(
	directory: string,
	oldState: GitDiffState,
	newState: GitDiffState,
): Promise<GitDiffReply | null> {
	const client = getGlobalClient();
	if (!client) return null;
	try {
		const reply = await client.gitDiff(directory, oldState, newState);
		if (!reply.ok) return null;
		return reply as unknown as GitDiffReply;
	} catch {
		return null;
	}
}

/** Read one absolute path at one repository state (see ReadFileRequest).
 * Serves the browser's file pane and its review sections alike — an omitted
 * or `"worktree"` state is the live file, a pinned oid / `"head"` is a
 * commit's blob, `"index"` is the staged blob. Returns null on transport
 * failure; `absent` and `binary` come back as values, not failures. */
export async function readFileRpc(path: string, state?: SnapshotState): Promise<SnapshotFile | null> {
	const client = getGlobalClient();
	if (!client) return null;
	try {
		const reply = await client.readFile(path, state);
		if (!reply.ok) return null;
		const { id: _id, ok: _ok, ...file } = reply as unknown as ReadFileReply;
		return file as SnapshotFile;
	} catch {
		return null;
	}
}

/** List one absolute directory's immediate children at one repository state
 * (see ListDirectoryRequest). Returns null on transport failure; a missing
 * directory comes back as an `absent` listing, not a failure. */
export async function listDirectoryRpc(path: string, state?: SnapshotState): Promise<DirectoryListing | null> {
	const client = getGlobalClient();
	if (!client) return null;
	try {
		const reply = await client.listDirectory(path, state);
		if (!reply.ok) return null;
		const { id: _id, ok: _ok, ...listing } = reply as unknown as ListDirectoryReply;
		return listing as DirectoryListing;
	} catch {
		return null;
	}
}

/** ADR 11: the Project home URL, for callers that need it without the hook. */
export { projectPath, sessionPath };

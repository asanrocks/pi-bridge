// ============================================================================
// sessionList — load a Project's session page into the client store (ADR 11).
//
// Both the Project home (boot/reconnect and live switch) and the sidebar render
// the same `SessionInfo` rows from the same store slice, so the fetch/decode
// lives in exactly one place: page cursor, `hasMore`, and the address→id index
// (ADR 09 cache cursors are keyed by `sessionId`, while the URL only carries
// `(projectId, stem)`).
//
// Pure enough to unit-test without a DOM: the store and the fetch are injected.
// ============================================================================

import type { ListSessionsReply, RpcReply, SessionInfo, SessionListCursor } from "../../../src/core/index.ts";
import { rememberAddress } from "./addressIndex.ts";

/** First page size for a Project's history. */
export const SESSION_PAGE_SIZE = 10;

export interface ProjectPage {
	sessions: SessionInfo[];
	hasMore: boolean;
	nextCursor: SessionListCursor | null;
}

/** The slice of the client store this module commits to. */
export interface SessionListTarget {
	replaceSessions(sessions: SessionInfo[], hasMore: boolean, nextCursor: SessionListCursor | null): void;
}

export interface ProjectHomeDeps {
	store: { getState(): SessionListTarget };
	projectId: string;
	/** Fetch one page; may resolve `undefined` on failure. */
	listSessions: (projectId: string, max: number) => Promise<RpcReply | undefined>;
	/** Re-checked after the fetch: a newer navigation may have superseded this. */
	isStillCurrent?: () => boolean;
}

/**
 * Decode a `listSessions` reply and record every row's address→sessionId.
 * Returns null for a failed reply so the caller leaves the existing list
 * untouched; an ok reply with zero rows is a real (empty) page and clears it.
 */
export function projectPageFromReply(reply: RpcReply | undefined): ProjectPage | null {
	if (!reply?.ok) return null;
	const data = reply as unknown as ListSessionsReply;
	const sessions = (data.sessions as SessionInfo[] | undefined) ?? [];
	for (const row of sessions) rememberAddress(row.projectId, row.stem, row.sessionId);
	return {
		sessions,
		hasMore: data.hasMore === true,
		nextCursor: data.nextCursor ?? null,
	};
}

/**
 * Fetch a Project's first page and commit it. The list is cleared up front so
 * the previous Project's rows never render under the new address, and a failed
 * fetch leaves it empty rather than stale. `isStillCurrent` guards a commit
 * that a newer navigation (project switch or session open) has superseded.
 */
export async function loadProjectHome(deps: ProjectHomeDeps): Promise<void> {
	deps.store.getState().replaceSessions([], false, null);
	let reply: RpcReply | undefined;
	try {
		reply = await deps.listSessions(deps.projectId, SESSION_PAGE_SIZE);
	} catch {
		return;
	}
	const page = projectPageFromReply(reply);
	if (!page) return;
	if (deps.isStillCurrent && !deps.isStillCurrent()) return;
	deps.store.getState().replaceSessions(page.sessions, page.hasMore, page.nextCursor);
}

// ============================================================================
// sessionList — decode a Project's `listSessions` page (ADR 11).
//
// The sidebar renders the `SessionInfo` rows, so the decode lives in exactly
// one place: page cursor, `hasMore`, and the address→id index (ADR 09 cache
// cursors are keyed by `sessionId`, while the URL only carries
// `(projectId, stem)`).
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

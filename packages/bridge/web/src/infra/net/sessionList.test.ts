// Unit tests for `listSessions` reply decoding (ADR 11). The sidebar's folder
// pages are the consumer; `projectPageFromReply` is the single decode path
// (rows, hasMore, cursor, and the address→sessionId index).

import { describe, expect, it } from "vitest";
import type { RpcReply, SessionInfo } from "../../../../src/core/index.ts";
import { projectPageFromReply } from "./sessionList.ts";

function row(stem: string): SessionInfo {
	return {
		projectId: "proj",
		sessionId: `sess-${stem}`,
		stem,
		active: false,
		isStreaming: false,
		timestamp: new Date(0).toISOString(),
	};
}

function pageReply(sessions: SessionInfo[], hasMore = false): RpcReply {
	return {
		id: "1",
		ok: true,
		sessions,
		hasMore,
		...(hasMore ? { nextCursor: { sortTimeMs: 5, stem: "a" } } : {}),
	} as unknown as RpcReply;
}

describe("projectPageFromReply", () => {
	it("returns null for a failed reply", () => {
		expect(projectPageFromReply({ id: "1", ok: false, error: "nope" })).toBeNull();
		expect(projectPageFromReply(undefined)).toBeNull();
	});

	it("decodes an ok reply, including an empty page", () => {
		expect(projectPageFromReply(pageReply([], false))).toEqual({
			sessions: [],
			hasMore: false,
			nextCursor: null,
		});
	});

	it("decodes rows, hasMore, and the cursor", () => {
		expect(projectPageFromReply(pageReply([row("a"), row("b")], true))).toEqual({
			sessions: [row("a"), row("b")],
			hasMore: true,
			nextCursor: { sortTimeMs: 5, stem: "a" },
		});
	});
});

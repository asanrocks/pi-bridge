// Unit tests for Project-history loading (ADR 11). The regression this guards:
// a live Project switch must actually fetch the Project's first page — the
// boot/reconnect path used to be the only caller of `listSessions`, so
// `/chat/<projectId>` rendered an empty history after an in-app switch.

import { describe, expect, it } from "vitest";
import type { RpcReply, SessionInfo } from "../../../src/core/index.ts";
import { loadProjectHome, projectPageFromReply, SESSION_PAGE_SIZE } from "./sessionList.ts";
import { createClientStore } from "./store.ts";

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
});

describe("loadProjectHome", () => {
	it("fetches the first page and commits it with the cursor", async () => {
		const store = createClientStore();
		const calls: Array<[string, number]> = [];
		await loadProjectHome({
			store,
			projectId: "proj",
			listSessions: async (projectId, max) => {
				calls.push([projectId, max]);
				return pageReply([row("a"), row("b")], true);
			},
		});

		expect(calls).toEqual([["proj", SESSION_PAGE_SIZE]]);
		const s = store.getState();
		expect(s.sessions.map((x) => x.stem)).toEqual(["a", "b"]);
		expect(s.sessionsHasMore).toBe(true);
		expect(s.sessionsNextCursor).toEqual({ sortTimeMs: 5, stem: "a" });
	});

	it("clears the previous Project's rows before committing the new page", async () => {
		const store = createClientStore();
		store.getState().replaceSessions([row("stale")], true, { sortTimeMs: 9, stem: "stale" });

		await loadProjectHome({ store, projectId: "proj", listSessions: async () => pageReply([], false) });

		const s = store.getState();
		expect(s.sessions).toEqual([]);
		expect(s.sessionsHasMore).toBe(false);
		expect(s.sessionsNextCursor).toBeNull();
	});

	it("leaves the list empty when the fetch fails", async () => {
		const store = createClientStore();
		store.getState().replaceSessions([row("stale")], true, null);

		await loadProjectHome({
			store,
			projectId: "proj",
			listSessions: async () => ({ id: "1", ok: false, error: "boom" }),
		});

		expect(store.getState().sessions).toEqual([]);
	});

	it("does not commit a page superseded by a newer navigation", async () => {
		const store = createClientStore();
		await loadProjectHome({
			store,
			projectId: "proj",
			listSessions: async () => pageReply([row("late")], false),
			// A newer navigation wins while the fetch is in flight.
			isStillCurrent: () => false,
		});

		expect(store.getState().sessions).toEqual([]);
	});
});

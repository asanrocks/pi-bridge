// resolveLatestSession — the `/@latest` target (ADR 13, revised by the session
// locations): the most recently active Session in the Inbox, else the most
// recent durable Session across Projects. Fake client, hand-built rows.

import { describe, expect, it, vi } from "vitest";
import type { BridgeClient, ProjectInfo, RpcReply, SessionInfo } from "../../../../src/core/index.ts";
import { resolveLatestSession } from "./latestSession.ts";

function row(
	projectId: string,
	stem: string,
	timestamp: string,
	opts: { location?: SessionInfo["location"]; lastActivityAt?: string } = {},
): SessionInfo {
	return {
		projectId,
		sessionId: `sess-${stem}`,
		stem,
		location: opts.location ?? "archive",
		timestamp,
		...(opts.lastActivityAt ? { lastActivityAt: opts.lastActivityAt } : {}),
	};
}

function project(id: string): ProjectInfo {
	return { id, cwd: `/x/${id}`, defaultModel: null, defaultThinkingLevel: null };
}

function fakeClient(pages: Record<string, SessionInfo[]>, ok = true) {
	const listSessions = vi.fn(
		async (projectId: string) => ({ id: "1", ok, sessions: pages[projectId] ?? [] }) as unknown as RpcReply,
	);
	return { client: { listSessions } as unknown as BridgeClient, listSessions };
}

describe("resolveLatestSession", () => {
	it("prefers the most recently active Inbox session without scanning", async () => {
		const { client, listSessions } = fakeClient({ p1: [row("p1", "durable", "2030-01-01T00:00:00.000Z")] });
		const queue = [
			row("p2", "older", "2025-01-01T00:00:00.000Z", {
				location: "inbox",
				lastActivityAt: "2025-01-01T00:00:00.000Z",
			}),
			row("p2", "newer", "2026-01-01T00:00:00.000Z", {
				location: "inbox",
				lastActivityAt: "2026-01-01T00:00:00.000Z",
			}),
		];
		const target = await resolveLatestSession(client, [project("p1"), project("p2")], queue);
		expect(target?.stem).toBe("newer");
		expect(listSessions).not.toHaveBeenCalled();
	});

	it("excludes Later rows: a Later-only queue falls back to history", async () => {
		const { client, listSessions } = fakeClient({ p1: [row("p1", "durable", "2025-06-01T00:00:00.000Z")] });
		const queue = [
			row("p2", "parked", "2030-01-01T00:00:00.000Z", {
				location: "later",
				lastActivityAt: "2030-01-01T00:00:00.000Z",
			}),
		];
		const target = await resolveLatestSession(client, [project("p1"), project("p2")], queue);
		// Later is "not next": the durable fallback applies.
		expect(target).toMatchObject({ projectId: "p1", stem: "durable" });
		expect(listSessions).toHaveBeenCalled();
	});

	it("falls back to the most recent durable session across projects", async () => {
		const { client, listSessions } = fakeClient({
			p1: [row("p1", "a", "2025-06-01T00:00:00.000Z")],
			p2: [row("p2", "b", "2025-07-01T00:00:00.000Z")],
			p3: [],
		});
		const target = await resolveLatestSession(client, [project("p1"), project("p2"), project("p3")], []);
		expect(target?.projectId).toBe("p2");
		expect(target?.stem).toBe("b");
		expect(listSessions).toHaveBeenCalledTimes(3);
	});

	it("returns null when nothing exists", async () => {
		const { client } = fakeClient({ p1: [] });
		expect(await resolveLatestSession(client, [project("p1")], [])).toBeNull();
	});

	it("scopes the queue preference to the alias's Project", async () => {
		const { client } = fakeClient({ p1: [row("p1", "durable", "2025-06-01T00:00:00.000Z")] });
		const queue = [row("p2", "elsewhere", "2026-01-01T00:00:00.000Z", { location: "inbox" })];
		expect(await resolveLatestSession(client, [project("p1"), project("p2")], queue, "p1")).toMatchObject({
			projectId: "p1",
			stem: "durable",
		});
	});

	it("scopes the durable fallback to the alias's Project", async () => {
		const { client, listSessions } = fakeClient({
			p1: [row("p1", "a", "2025-06-01T00:00:00.000Z")],
			p2: [row("p2", "newer", "2030-01-01T00:00:00.000Z")],
		});
		const target = await resolveLatestSession(client, [project("p1"), project("p2")], [], "p1");
		expect(target?.stem).toBe("a");
		// A scoped alias reads its own Project, not every Project.
		expect(listSessions).toHaveBeenCalledTimes(1);
		expect(listSessions).toHaveBeenCalledWith("p1", 1);
	});

	it("scopes an emptied Project to null", async () => {
		const { client } = fakeClient({ p1: [row("p1", "a", "2025-06-01T00:00:00.000Z")], p2: [] });
		expect(await resolveLatestSession(client, [project("p1"), project("p2")], [], "p2")).toBeNull();
	});

	it("ignores failed project replies", async () => {
		const { client } = fakeClient({ p1: [row("p1", "a", "2025-01-01T00:00:00.000Z")] }, false);
		expect(await resolveLatestSession(client, [project("p1")], [])).toBeNull();
	});
});

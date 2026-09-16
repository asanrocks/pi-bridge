// Unit tests for the store's address/detach semantics (ADR 11). A session
// address is `(projectId, stem)`; `clearCurrentSession` is the single teardown
// used by detach, a Project switch, and an open failure. There is no pin flag:
// the URL is the navigation source of truth, so `/launcher` is simply an
// address with no Project.

import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../../src/core/index.ts";
import { createClientStore } from "./store.ts";

function session(stem: string): SessionInfo {
	return {
		projectId: "proj",
		sessionId: `sess-${stem}`,
		stem,
		active: false,
		isStreaming: false,
		timestamp: new Date(0).toISOString(),
	};
}

function openAndDirty(store: ReturnType<typeof createClientStore>) {
	store.getState().setCurrentSession("proj", "2024-01-01_x");
	store.getState().setActiveSessionId("sess-a");
	store.getState().setFocusedTurnId("turn-1");
	store.getState().setDraft({ kind: "compose", text: "unsent" });
}

describe("clearCurrentSession", () => {
	it("clears the address and all session state", () => {
		const store = createClientStore();
		openAndDirty(store);
		expect(store.getState().currentStem).toBe("2024-01-01_x");

		store.getState().clearCurrentSession();

		const s = store.getState();
		expect(s.currentProjectId).toBeNull();
		expect(s.currentStem).toBeNull();
		expect(s.activeSessionId).toBeNull();
		expect(s.sessions).toEqual([]);
		expect(s.sessionsNextCursor).toBeNull();
		expect(s.focusedTurnId).toBeNull();
		expect(s.draft).toEqual({ kind: "idle" });
		expect(s.document.entries).toEqual({});
	});

	it("keeps the static Project list and the global active snapshot", () => {
		const store = createClientStore();
		store.getState().setProjects([{ id: "proj", cwd: "/proj" }]);
		store.getState().setActiveSessions([session("a")]);
		openAndDirty(store);

		store.getState().clearCurrentSession();

		expect(store.getState().projects).toEqual([{ id: "proj", cwd: "/proj" }]);
		expect(store.getState().activeSessions).toHaveLength(1);
	});

	it("lands on the given Project's home when a Project is passed", () => {
		const store = createClientStore();
		openAndDirty(store);

		// Failed-open fallback: drop the session but stay in the Project.
		store.getState().clearCurrentSession("proj");

		const s = store.getState();
		expect(s.currentProjectId).toBe("proj");
		expect(s.currentStem).toBeNull();
		expect(s.activeSessionId).toBeNull();
		expect(s.document.entries).toEqual({});
	});
});

describe("session pages", () => {
	it("appendSessions upserts by sessionId and keeps the cursor when omitted", () => {
		const store = createClientStore();
		store.getState().replaceSessions([session("a")], true, { sortTimeMs: 10, stem: "a" });
		store.getState().appendSessions([session("b")], false);

		const s = store.getState();
		expect(s.sessions.map((x) => x.stem).sort()).toEqual(["a", "b"]);
		expect(s.sessionsHasMore).toBe(false);
		expect(s.sessionsNextCursor).toEqual({ sortTimeMs: 10, stem: "a" });
	});

	it("replaceSessions resets the cursor (page-1 refresh)", () => {
		const store = createClientStore();
		store.getState().replaceSessions([session("a")], true, { sortTimeMs: 10, stem: "a" });
		store.getState().replaceSessions([session("b")], true, { sortTimeMs: 20, stem: "b" });

		const s = store.getState();
		expect(s.sessions.map((x) => x.stem)).toEqual(["b"]);
		expect(s.sessionsNextCursor).toEqual({ sortTimeMs: 20, stem: "b" });
	});
});

describe("sidebar folder pages", () => {
	it("begin/set cycle commits a ready page and error marks failure", () => {
		const store = createClientStore();
		store.getState().beginSessionPage("proj");
		expect(store.getState().sessionPages.proj).toEqual({ kind: "loading" });

		store.getState().setSessionPageError("proj");
		expect(store.getState().sessionPages.proj).toEqual({ kind: "error" });

		store.getState().setSessionPage("proj", [session("a")], true, { sortTimeMs: 10, stem: "a" });
		expect(store.getState().sessionPages.proj).toEqual({
			kind: "ready",
			sessions: [session("a")],
			hasMore: true,
			nextCursor: { sortTimeMs: 10, stem: "a" },
		});
	});

	it("appendSessionPage upserts by sessionId and keeps the cursor when omitted", () => {
		const store = createClientStore();
		store.getState().setSessionPage("proj", [session("a")], true, { sortTimeMs: 10, stem: "a" });
		store.getState().appendSessionPage("proj", [session("b")], false);

		const page = store.getState().sessionPages.proj;
		expect(page?.kind).toBe("ready");
		if (page?.kind !== "ready") return;
		expect(page.sessions.map((x) => x.stem).sort()).toEqual(["a", "b"]);
		expect(page.hasMore).toBe(false);
		expect(page.nextCursor).toEqual({ sortTimeMs: 10, stem: "a" });
	});

	it("appendSessionPage is a no-op without a ready page", () => {
		const store = createClientStore();
		store.getState().beginSessionPage("proj");
		store.getState().appendSessionPage("proj", [session("a")], false);
		expect(store.getState().sessionPages.proj).toEqual({ kind: "loading" });
	});

	it("folder pages are per-Project and reset only wholesale", () => {
		const store = createClientStore();
		store.getState().setSessionPage("proj", [session("a")], false, null);
		store.getState().setSessionPage("other", [], false, null);
		expect(Object.keys(store.getState().sessionPages).sort()).toEqual(["other", "proj"]);

		store.getState().resetSessionPages();
		expect(store.getState().sessionPages).toEqual({});
	});

	it("survives clearCurrentSession (pure UI cache, not session state)", () => {
		const store = createClientStore();
		store.getState().setSessionPage("proj", [session("a")], false, null);
		openAndDirty(store);
		store.getState().clearCurrentSession("proj");
		expect(store.getState().sessionPages.proj?.kind).toBe("ready");
	});
});

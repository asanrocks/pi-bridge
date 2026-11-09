// Unit tests for the store's address/detach semantics (ADR 11). A session
// address is `(projectId, stem)`; `clearCurrentSession` is the single teardown
// used by detach, a Project switch, and an open failure. There is no pin flag:
// the URL is the navigation source of truth, so `/launcher` is simply an
// address with no Project.

import { describe, expect, it } from "vitest";
import type { Entry, SessionInfo } from "../../../../src/core/index.ts";
import { addressKeyOf } from "./protocol.ts";
import { createClientStore } from "./store.ts";
import { resolveRenderLeafTarget } from "./ui.ts";

function session(stem: string): SessionInfo {
	return {
		projectId: "proj",
		sessionId: `sess-${stem}`,
		stem,
		location: "archive" as const,
		timestamp: new Date(0).toISOString(),
	};
}

function openAndDirty(store: ReturnType<typeof createClientStore>) {
	store.getState().setCurrentSession("proj", "2024-01-01_x");
	store.getState().setActiveSessionId("sess-a");
	store.getState().setFocusedTurnId("turn-1");
	store.getState().setDraft({ kind: "compose", text: "unsent" });
}

function seedEntry(store: ReturnType<typeof createClientStore>, id: string, parentId: string | null, ord?: number) {
	const doc = store.getState().document;
	store.getState().applyReplace({
		...doc,
		entries: {
			...doc.entries,
			[id]: {
				id,
				parentId,
				timestamp: "2024-01-01T00:00:00Z",
				kind: "message",
				role: "user",
				content: [],
				...(ord !== undefined ? { ord } : {}),
			},
		},
	});
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
		expect(s.focusedTurnId).toBeNull();
		expect(s.draft).toEqual({ kind: "idle" });
		expect(s.document.entries).toEqual({});
	});

	it("keeps the static Project list and the global queue", () => {
		const store = createClientStore();
		store.getState().setProjects([{ id: "proj", cwd: "/proj", defaultModel: null, defaultThinkingLevel: null }]);
		store.getState().applyQueueSnapshot([session("a")], 1);
		openAndDirty(store);

		store.getState().clearCurrentSession();

		expect(store.getState().projects).toEqual([
			{ id: "proj", cwd: "/proj", defaultModel: null, defaultThinkingLevel: null },
		]);
		expect(store.getState().queue).toHaveLength(1);
	});

	it("resets the alias view (ADR 13)", () => {
		const store = createClientStore();
		store.getState().setAddressViaAlias(true);
		openAndDirty(store);
		expect(store.getState().addressViaAlias).toBe(true);

		store.getState().clearCurrentSession();

		expect(store.getState().addressViaAlias).toBe(false);
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

	it("clears the rendered-leaf override (peek is session-scoped)", () => {
		const store = createClientStore();
		seedEntry(store, "c1", null, 0);
		store.getState().setRenderLeaf("c1");
		expect(store.getState().renderLeafId).toBe("c1");

		store.getState().clearCurrentSession();
		expect(store.getState().renderLeafId).toBeNull();
	});
});

describe("setRenderLeaf (peek pin)", () => {
	it("pins a committed entry and returns to live with null", () => {
		const store = createClientStore();
		seedEntry(store, "c1", null, 0);
		seedEntry(store, "c2", "c1", 1);

		store.getState().setRenderLeaf("c1");
		expect(store.getState().renderLeafId).toBe("c1");
		store.getState().setRenderLeaf(null);
		expect(store.getState().renderLeafId).toBeNull();
	});

	it("clamps an uncommitted (pending) target to its nearest committed ancestor", () => {
		const store = createClientStore();
		seedEntry(store, "c1", null, 0);
		seedEntry(store, "p1", "c1"); // provisional — no ord

		store.getState().setRenderLeaf("p1");
		expect(store.getState().renderLeafId).toBe("c1");
	});

	it("normalizes pinning the live leaf to follow-live", () => {
		const store = createClientStore();
		seedEntry(store, "c1", null, 0);
		store.getState().applyReplace({
			...store.getState().document,
			status: { ...store.getState().document.status, leafId: "c1" },
		});

		store.getState().setRenderLeaf("c1");
		expect(store.getState().renderLeafId).toBeNull();
	});

	it("is a no-op when no committed entry exists in the chain", () => {
		const store = createClientStore();
		seedEntry(store, "p1", null); // provisional root — nothing committed

		store.getState().setRenderLeaf("p1");
		expect(store.getState().renderLeafId).toBeNull();
	});
});

describe("applyReplace × document revision", () => {
	it("advances the revision when the publisher supplies none", () => {
		// Cache restore and cache seeding replace the document outside the
		// mirror; without an advancing revision, a same-shape replacement (a
		// changed label, a changed tool name) would hit a stale ViewModel cache
		// entry — the structural key cannot see it.
		const store = createClientStore();
		const before = store.getState().docRevision;
		store.getState().applyReplace(store.getState().document);
		expect(store.getState().docRevision).toBe(before + 1);
	});

	it("publishes the publisher's revision when supplied", () => {
		// The wire pipeline owns the mirror's revision counter and publishes
		// it with the document it describes — one store write, both values.
		const store = createClientStore();
		store.getState().applyReplace(store.getState().document, 42);
		expect(store.getState().docRevision).toBe(42);
	});
});

describe("setActiveSessionId × peek pin", () => {
	it("clears the rendered-leaf override when a different session activates", () => {
		const store = createClientStore();
		store.getState().setActiveSessionId("sess-a");
		seedEntry(store, "c1", null, 0);
		store.getState().setRenderLeaf("c1");
		expect(store.getState().renderLeafId).toBe("c1");

		// The pinned id belongs to sess-a's tree; carrying it into sess-b would
		// leave that session diverged (mutation-locked) on a dangling pin.
		store.getState().setActiveSessionId("sess-b");
		expect(store.getState().renderLeafId).toBeNull();
	});

	it("keeps the override when the same session re-activates (reconnect replace)", () => {
		const store = createClientStore();
		store.getState().setActiveSessionId("sess-a");
		seedEntry(store, "c1", null, 0);
		store.getState().setRenderLeaf("c1");

		store.getState().setActiveSessionId("sess-a");
		expect(store.getState().renderLeafId).toBe("c1");
	});
});

describe("docAuthority — the loading tri-state's source", () => {
	const REF = { projectId: "proj", stem: "2024-01-01_x", sessionId: "sess-a" } as const;

	it("starts staged and is confirmed by an address-bearing initial sync", () => {
		const store = createClientStore();
		expect(store.getState().docAuthority).toBe("staged");

		seedEntry(store, "u1", null, 0);
		store.getState().commitObservation(REF, store.getState().document, 3);

		expect(store.getState().docAuthority).toBe("authoritative");
		expect(store.getState().activeSessionId).toBe("sess-a");
	});

	it("a local cache paint seeds; a wire flush extends the committed document", () => {
		const store = createClientStore();
		store.getState().commitObservation(REF, store.getState().document, 3);
		expect(store.getState().docAuthority).toBe("authoritative");

		// Cache seed (ADR 09): this address's own last-known state, not yet
		// confirmed — the syncing tail renders on it.
		store.getState().paintLocalDocument(store.getState().document);
		expect(store.getState().docAuthority).toBe("seeded");

		// A mirror flush (pipeline coalescing, lazy pulls) is not a claim about
		// the address — it keeps the state it found.
		store.getState().commitObservation(REF, store.getState().document, 4);
		store.getState().applyReplace(store.getState().document, 5);
		expect(store.getState().docAuthority).toBe("authoritative");
	});

	it("an optimistic address change stages the previous view's document; a rollback commit restores", () => {
		const store = createClientStore();
		store.getState().commitObservation(REF, store.getState().document, 3);

		// A staged navigate keeps the previous session's document published
		// under the new address — staged content: rendered untouched, no
		// syncing tail (the tail would mis-attribute the new session's sync
		// to the conversation on screen).
		store.getState().setCurrentSession("proj", "2024-01-02_y");
		expect(store.getState().docAuthority).toBe("staged");
		expect(store.getState().activeSessionId).toBeNull();

		// The failed open's rollback re-publishes the previously committed
		// view: its document is still the published one, so authority returns
		// with the address pair.
		store.getState().commitAddress("proj", "2024-01-01_x", "sess-a");
		expect(store.getState().docAuthority).toBe("authoritative");
		expect(store.getState().activeSessionId).toBe("sess-a");
	});

	it("a rollback commit repaints the view's document in the same write", () => {
		const store = createClientStore();
		seedEntry(store, "u1", null, 0);
		const docA = store.getState().document;
		store.getState().commitObservation(REF, docA, 3);

		// The instant-switch paint published another document under the
		// staged address.
		const seedB = { ...docA, status: { ...docA.status, name: "b" } };
		store.getState().paintLocalDocument(seedB);
		expect(store.getState().docAuthority).toBe("seeded");

		// The rollback commits the restored pair together with its document.
		store.getState().commitAddress("proj", "2024-01-01_x", "sess-a", docA);
		const s = store.getState();
		expect(s.document).toBe(docA);
		expect(s.docAuthority).toBe("authoritative");
		expect(s.docRevision).toBeGreaterThan(3);
	});
});

describe("resolveRenderLeafTarget", () => {
	function entriesOf(...specs: [id: string, parentId: string | null, ord?: number][]) {
		return Object.fromEntries(
			specs.map(([id, parentId, ord]) => [
				id,
				{
					id,
					parentId,
					timestamp: "2024-01-01T00:00:00Z",
					kind: "message",
					role: "user",
					content: [],
					...(ord !== undefined ? { ord } : {}),
				},
			]),
		) as unknown as Record<string, Entry>;
	}

	it("returns a committed target as-is", () => {
		const entries = entriesOf(["c1", null, 0], ["c2", "c1", 1]);
		expect(resolveRenderLeafTarget(entries, "c2", null)).toBe("c2");
	});

	it("clamps an uncommitted target to its nearest committed ancestor", () => {
		const entries = entriesOf(["c1", null, 0], ["p1", "c1"], ["p2", "p1"]);
		expect(resolveRenderLeafTarget(entries, "p2", null)).toBe("c1");
	});

	it("returns null when the walk reaches the live leaf first", () => {
		const entries = entriesOf(["c1", null, 0], ["p1", "c1"]);
		expect(resolveRenderLeafTarget(entries, "p1", "p1")).toBeNull();
	});

	it("returns undefined when nothing committed exists beneath", () => {
		const entries = entriesOf(["p1", null]);
		expect(resolveRenderLeafTarget(entries, "p1", null)).toBeUndefined();
	});

	it("returns undefined for an unknown id", () => {
		const entries = entriesOf(["c1", null, 0]);
		expect(resolveRenderLeafTarget(entries, "gone", null)).toBeUndefined();
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

describe("setCurrentSession", () => {
	// The browser holds content read from the session being left, so an address
	// change closes it; a same-address re-assert (the initial-sync push after an
	// optimistic open, a reconnect replace) leaves it alone.
	function withOpenBrowser(store: ReturnType<typeof createClientStore>) {
		store.getState().setProjects([{ id: "proj", cwd: "/repo", defaultModel: null, defaultThinkingLevel: null }]);
		store.getState().setCurrentSession("proj", "2024-01-01_x");
		store.getState().openFileViewer("src/a.ts");
	}

	it("closes the browser when the address changes", () => {
		const store = createClientStore();
		withOpenBrowser(store);

		store.getState().setCurrentSession("proj", "2024-01-02_y");

		expect(store.getState().browser).toBeNull();
		expect(store.getState().currentStem).toBe("2024-01-02_y");
	});

	it("closes it when the stem is dropped for the Project home", () => {
		const store = createClientStore();
		withOpenBrowser(store);

		store.getState().setCurrentSession("proj", null);

		expect(store.getState().browser).toBeNull();
	});

	it("keeps it open when the same address is re-asserted", () => {
		const store = createClientStore();
		withOpenBrowser(store);

		store.getState().setCurrentSession("proj", "2024-01-01_x");

		// A relative entry-point path is absolute-ized against the Project cwd
		// (ADR 14), and the tree is rooted at that cwd.
		expect(store.getState().browser).toEqual({
			root: "/repo",
			state: "worktree",
			path: "/repo/src/a.ts",
			tree: "all",
			presentation: "file",
		});
	});

	it("opens a review target from a git-stamp window", () => {
		const store = createClientStore();
		withOpenBrowser(store);

		store.getState().openDiffView({ old: "head", new: "worktree" }, "Implement parser");

		expect(store.getState().browser).toEqual({
			root: "/repo",
			state: "worktree",
			baseline: "head",
			tree: "changed",
			presentation: "review",
			origin: "transition",
			label: "Implement parser",
		});
	});
});

describe("adoptBrowserPath", () => {
	function withHomeTarget(store: ReturnType<typeof createClientStore>) {
		store.getState().setProjects([{ id: "proj", cwd: "/repo", defaultModel: null, defaultThinkingLevel: null }]);
		store.getState().setCurrentSession("proj", "2024-01-01_x");
		store.getState().openFileViewer("~/notes/todo.md");
	}

	it("rewrites a `~`-rooted target with the absolute path the host resolved", () => {
		const store = createClientStore();
		withHomeTarget(store);
		// The client cannot expand `~` (the host owns HOME), so the target keeps
		// the `~` form and the root stays the requested directory.
		expect(store.getState().browser).toMatchObject({ path: "~/notes/todo.md", root: "~/notes" });

		store.getState().adoptBrowserPath("~/notes/todo.md", "/home/u/notes/todo.md");

		expect(store.getState().browser).toMatchObject({ path: "/home/u/notes/todo.md", root: "~/notes" });
	});

	it("ignores a resolution for a path the target no longer holds", () => {
		const store = createClientStore();
		withHomeTarget(store);

		store.getState().adoptBrowserPath("~/other.md", "/home/u/other.md");

		expect(store.getState().browser).toMatchObject({ path: "~/notes/todo.md" });
	});
});

describe("queue deltas (ADR 24)", () => {
	function row(stem: string, location: SessionInfo["location"], placedAt?: string): SessionInfo {
		return {
			projectId: "proj",
			sessionId: `sess-${stem}`,
			stem,
			location,
			timestamp: new Date(0).toISOString(),
			...(placedAt !== undefined ? { placedAt } : {}),
		};
	}

	it("a delta replaces the complete row at its address, clearing omitted fields", () => {
		const store = createClientStore();
		store.getState().applyQueueSnapshot([{ ...row("a", "inbox"), activity: { kind: "responding" } }], 1);

		// The running fact ended: the complete row omits `activity`, so the
		// stored copy must not keep the stale one.
		store.getState().applyQueueDelta([row("a", "inbox")], [], [], 2);

		expect(store.getState().queue).toEqual([row("a", "inbox")]);
		expect(store.getState().queueRevision).toBe(2);
	});

	it("removals drop rows and leaves the rest in the shared queue order", () => {
		const store = createClientStore();
		store
			.getState()
			.applyQueueSnapshot([row("later", "later"), row("inbox-old", "inbox", "2024-01-01T00:00:00Z")], 1);

		store
			.getState()
			.applyQueueDelta(
				[row("inbox-new", "inbox", "2024-06-01T00:00:00Z")],
				[{ projectId: "proj", stem: "later" }],
				[],
				2,
			);

		// Inbox leads Later, and within a group the most recent placement leads.
		expect(store.getState().queue.map((entry) => entry.stem)).toEqual(["inbox-new", "inbox-old"]);
	});

	it("a row that only ran keeps its position: activity is not an ordering input", () => {
		const store = createClientStore();
		store
			.getState()
			.applyQueueSnapshot(
				[row("first", "inbox", "2024-01-01T00:00:00Z"), row("second", "inbox", "2024-02-01T00:00:00Z")],
				1,
			);

		// The older placement streams a turn: its activity is now the newest of the
		// two, and a complete row arrives through the delta. The order must not
		// move, because the user placed neither row again.
		store
			.getState()
			.applyQueueDelta(
				[{ ...row("first", "inbox", "2024-01-01T00:00:00Z"), lastActivityAt: "2024-03-01T00:00:00Z" }],
				[],
				[],
				2,
			);

		expect(store.getState().queue.map((entry) => entry.stem)).toEqual(["second", "first"]);
	});

	it("invalidation drops the cached history pages it names", () => {
		const store = createClientStore();
		store.getState().setSessionPage("proj", [row("a", "archive")], false, null);
		store.getState().setSessionPage("other", [row("b", "archive")], false, null);

		store.getState().applyQueueDelta([], [], ["proj"], 1);

		expect(store.getState().sessionPages.proj).toBeUndefined();
		expect(store.getState().sessionPages.other).toBeDefined();
	});

	it("files completion notices in sequence order for the notification hook", () => {
		const store = createClientStore();
		store.getState().noteCompletion({
			session: { projectId: "proj", stem: "a", sessionId: "sess-a" },
			name: "A",
		});
		store.getState().noteCompletion({
			session: { projectId: "proj", stem: "b", sessionId: "sess-b" },
			lastMessageText: "done",
		});

		expect(store.getState().completions.map((notice) => notice.seq)).toEqual([1, 2]);
		expect(store.getState().completionsSeq).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Unread completions — the badge's novelty channel (per page, in memory)
// ---------------------------------------------------------------------------

describe("unread completions", () => {
	const notice = (stem: string) => ({ session: { projectId: "proj", stem, sessionId: `sess-${stem}` } });

	it("a completion this page is not reading becomes unread", () => {
		const store = createClientStore();
		store.getState().noteCompletion(notice("a"));
		store.getState().noteCompletion(notice("b"));
		expect(store.getState().unreadCompletions).toEqual([
			addressKeyOf({ projectId: "proj", stem: "a" }),
			addressKeyOf({ projectId: "proj", stem: "b" }),
		]);
	});

	it("the attached Session's own completion is not news", () => {
		const store = createClientStore();
		store.getState().commitAddress("proj", "a", "sess-a");
		store.getState().noteCompletion(notice("a"));
		expect(store.getState().unreadCompletions).toEqual([]);
	});

	it("one address is unread once, however many turns it finishes", () => {
		const store = createClientStore();
		store.getState().noteCompletion(notice("a"));
		store.getState().noteCompletion(notice("a"));
		expect(store.getState().unreadCompletions).toHaveLength(1);
	});

	it("attaching the Session reads it: the optimistic commit clears it, not the sync", () => {
		const store = createClientStore();
		store.getState().noteCompletion(notice("a"));
		store.getState().setCurrentSession("proj", "a");
		expect(store.getState().unreadCompletions).toEqual([]);
	});

	it("a confirmed attach clears it too, and reading one leaves the other", () => {
		const store = createClientStore();
		store.getState().noteCompletion(notice("a"));
		store.getState().noteCompletion(notice("b"));
		store
			.getState()
			.commitObservation({ projectId: "proj", stem: "b", sessionId: "sess-b" }, store.getState().document);
		expect(store.getState().unreadCompletions).toEqual([addressKeyOf({ projectId: "proj", stem: "a" })]);
	});

	it("an attach with nothing to clear keeps the same array", () => {
		const store = createClientStore();
		store.getState().commitAddress("proj", "a", "sess-a");
		const before = store.getState().unreadCompletions;
		store.getState().commitAddress("proj", "a", "sess-a");
		expect(store.getState().unreadCompletions).toBe(before);
	});
});

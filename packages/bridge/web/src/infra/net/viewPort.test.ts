// viewPort — the adapter behind the browser view actor's decisions (ADR 19).
// These tests pin the adapter's publication semantics: an observation commit
// is one store write (a subscriber never sees a new address paired with the
// previous document or session id), a restore republishes the trio together,
// a clear retains the Project it lands on, and a null-stem stage is the
// Project home.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Document, SessionRef } from "../../../../src/core/index.ts";
import { initFromEntries } from "../../../../src/core/index.ts";
import { getStore } from "../state/store.tsx";
import { createNavigationViewPort, type NavigationViewPort } from "./viewPort.ts";

const REF: SessionRef = { projectId: "proj", sessionId: "s1", stem: "a" };

const g = globalThis as unknown as { window?: unknown };
let replaceState: ReturnType<typeof vi.fn>;

function emptyDocument(): Document {
	return initFromEntries([]);
}

/** Snapshot of everything an observation publication touches. */
function publication(): {
	projectId: string | null;
	stem: string | null;
	sessionId: string | null;
	entryCount: number;
} {
	const s = getStore().getState();
	return {
		projectId: s.currentProjectId,
		stem: s.currentStem,
		sessionId: s.activeSessionId,
		entryCount: Object.keys(s.document.entries).length,
	};
}

beforeEach(() => {
	replaceState = vi.fn();
	g.window = { location: { pathname: "/" }, history: { replaceState } };
	getStore().setState({
		currentProjectId: null,
		currentStem: null,
		activeSessionId: null,
		document: emptyDocument(),
		renderLeafId: null,
		addressViaAlias: false,
	});
});

afterEach(() => {
	delete g.window;
});

describe("viewPort", () => {
	it("an observation commit publishes address, id, and document in one store write", () => {
		const port = createNavigationViewPort();
		const doc = initFromEntries([]);
		doc.entries.e1 = {
			kind: "message",
			id: "e1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			role: "user",
			content: [{ type: "text", text: "hello" }],
		} as Document["entries"][string];

		const seen: ReturnType<typeof publication>[] = [];
		const unsub = getStore().subscribe((s) => {
			seen.push({
				projectId: s.currentProjectId,
				stem: s.currentStem,
				sessionId: s.activeSessionId,
				entryCount: Object.keys(s.document.entries).length,
			});
		});

		port.commitObservation(REF, doc, 7);

		unsub();
		// One notification, carrying the whole observation: a subscriber never
		// observes the new address under the old document or session id.
		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual({ projectId: "proj", stem: "a", sessionId: "s1", entryCount: 1 });
		expect(publication()).toEqual({ projectId: "proj", stem: "a", sessionId: "s1", entryCount: 1 });
		expect(replaceState).toHaveBeenCalledWith(null, "", "/proj/a");
	});

	it("a restore republishes the view's address, id, and route together", () => {
		const port = createNavigationViewPort();
		port.stageAddress("proj", "next");
		port.publishSessionId("s2");

		port.restoreView({ kind: "session", projectId: "proj", stem: "a" }, "s1");

		expect(publication()).toEqual({ projectId: "proj", stem: "a", sessionId: "s1", entryCount: 0 });
		expect(replaceState).toHaveBeenLastCalledWith(null, "", "/proj/a");

		port.restoreView({ kind: "project", projectId: "other" }, null);
		expect(publication()).toEqual({ projectId: "other", stem: null, sessionId: null, entryCount: 0 });
		expect(replaceState).toHaveBeenLastCalledWith(null, "", "/other");
	});

	it("a clear retains the Project it lands on, and drops the session state", () => {
		const port: NavigationViewPort = createNavigationViewPort();
		port.commitAddress(REF.projectId, REF.stem, REF.sessionId);

		port.clearSession("proj");

		expect(publication()).toEqual({ projectId: "proj", stem: null, sessionId: null, entryCount: 0 });
		expect(getStore().getState().renderLeafId).toBeNull();
	});

	it("a null-stem stage is the Project home", () => {
		const port = createNavigationViewPort();
		port.stageAddress("proj", null);
		expect(publication()).toEqual({ projectId: "proj", stem: null, sessionId: null, entryCount: 0 });
	});

	it("the alias flag keeps the URL in alias form across an observation commit", () => {
		const port = createNavigationViewPort();
		port.setAddressViaAlias(true);
		port.commitAddress(REF.projectId, REF.stem, REF.sessionId);
		expect(publication()).toEqual({ projectId: "proj", stem: "a", sessionId: "s1", entryCount: 0 });
		// The URL keeps the alias form (ADR 13): no route write happened.
		expect(replaceState).not.toHaveBeenCalled();
	});
});

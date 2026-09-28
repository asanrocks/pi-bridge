// ============================================================================
// sessionBoot unit tests — the local restore half of boot (`restoreLocalSession`).
// The wire half (`openSessionAddress`) needs a client/transport and is covered
// by the integration suites. The store is the module singleton from store.tsx;
// each test resets the fields the restore reads and writes.
// ============================================================================

import { beforeEach, describe, expect, it } from "vitest";
import type { CacheEntryRecord, Document, Entry, SessionStatusHint } from "../../../../src/core/index.ts";
import { seedDocument } from "../../../../src/core/index.ts";
import { getStore } from "../state/store.tsx";
import { type LocalRestoreDeps, restoreLocalSession } from "./sessionBoot.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function emptyDocument(): Document {
	return {
		status: {
			leafId: null,
			name: "",
			model: { provider: "", modelId: "" },
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			stats: {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: { total: 0 },
				messages: 0,
			},
			contextUsage: null,
			pendingSteer: [],
		},
		entries: {},
	};
}

function msgRecord(sessionId: string, ord: number, entryId: string): CacheEntryRecord {
	const entry: Entry = {
		kind: "message",
		id: entryId,
		parentId: null,
		timestamp: "2024-01-01T00:00:00Z",
		ord,
		role: "user",
		content: [{ type: "text", text: `text of ${entryId}` }],
	};
	return { sessionId, ord, entryId, entry };
}

function resetStore(): void {
	getStore().setState({
		currentProjectId: null,
		currentStem: null,
		activeSessionId: null,
		document: emptyDocument(),
		renderLeafId: null,
	});
}

function deps(
	records: CacheEntryRecord[],
	hint: SessionStatusHint | null = null,
	opts: { knownAddress?: boolean; failRead?: boolean } = {},
): LocalRestoreDeps {
	return {
		lookupSessionId: opts.knownAddress === false ? () => undefined : () => "s1",
		loadSession: async () => {
			if (opts.failRead) throw new Error("cache read failed");
			return { records, hint };
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
	resetStore();
});

describe("restoreLocalSession", () => {
	it("seeds the store from the cache, claiming address and session id", async () => {
		const records = [msgRecord("s1", 0, "a"), msgRecord("s1", 1, "b")];
		await restoreLocalSession("proj", "stem", deps(records));

		const s = getStore().getState();
		expect(s.currentProjectId).toBe("proj");
		expect(s.currentStem).toBe("stem");
		expect(s.activeSessionId).toBe("s1");
		expect(Object.keys(s.document.entries).sort()).toEqual(["a", "b"]);
	});

	it("quiesces volatile status flags from the cached hint", async () => {
		const records = [msgRecord("s1", 0, "a")];
		const hint: SessionStatusHint = { isStreaming: true, isCompacting: true, pendingSteer: ["queued"] };
		await restoreLocalSession("proj", "stem", deps(records, hint));

		const status = getStore().getState().document.status;
		expect(status.isStreaming).toBe(false);
		expect(status.isCompacting).toBe(false);
		expect(status.pendingSteer).toEqual([]);
	});

	it("keeps the cached hint's non-volatile fields", async () => {
		const records = [msgRecord("s1", 0, "a")];
		await restoreLocalSession("proj", "stem", deps(records, { name: "my session" }));

		expect(getStore().getState().document.status.name).toBe("my session");
	});

	it("is a no-op when the address has no remembered session id", async () => {
		await restoreLocalSession("proj", "stem", deps([msgRecord("s1", 0, "a")], null, { knownAddress: false }));

		const s = getStore().getState();
		expect(s.currentProjectId).toBeNull();
		expect(s.currentStem).toBeNull();
		expect(s.activeSessionId).toBeNull();
		expect(Object.keys(s.document.entries)).toHaveLength(0);
	});

	it("is a no-op on a cache read failure", async () => {
		await restoreLocalSession("proj", "stem", deps([msgRecord("s1", 0, "a")], null, { failRead: true }));

		expect(getStore().getState().currentStem).toBeNull();
	});

	it("is a no-op when the cache holds no records", async () => {
		await restoreLocalSession("proj", "stem", deps([]));

		expect(getStore().getState().currentStem).toBeNull();
	});

	it("never overwrites wire data: address claimed by another address", async () => {
		getStore().setState({ currentProjectId: "other", currentStem: "other-stem" });
		await restoreLocalSession("proj", "stem", deps([msgRecord("s1", 0, "a")]));

		const s = getStore().getState();
		expect(s.currentProjectId).toBe("other");
		expect(s.activeSessionId).toBeNull();
	});

	it("never overwrites wire data: same address already has entries", async () => {
		const wireDoc = seedDocument([msgRecord("s1", 0, "wire")]);
		getStore().setState({
			currentProjectId: "proj",
			currentStem: "stem",
			activeSessionId: "s1",
			document: wireDoc,
		});
		await restoreLocalSession("proj", "stem", deps([msgRecord("s1", 0, "cache")]));

		const s = getStore().getState();
		expect(s.document).toBe(wireDoc);
		expect(s.activeSessionId).toBe("s1");
	});

	it("never overwrites wire data: an empty session already synced (activeSessionId set)", async () => {
		getStore().setState({ currentProjectId: "proj", currentStem: "stem", activeSessionId: "s1" });
		await restoreLocalSession("proj", "stem", deps([msgRecord("s1", 0, "a")]));

		const s = getStore().getState();
		expect(s.activeSessionId).toBe("s1");
		expect(Object.keys(s.document.entries)).toHaveLength(0);
	});

	it("applies when the wire half staged the address but nothing rendered yet", async () => {
		// openSessionAddress commits the address before its RPC resolves; the
		// local restore may land in that window and must still paint.
		getStore().setState({ currentProjectId: "proj", currentStem: "stem" });
		await restoreLocalSession("proj", "stem", deps([msgRecord("s1", 0, "a")]));

		const s = getStore().getState();
		expect(s.activeSessionId).toBe("s1");
		expect(Object.keys(s.document.entries)).toEqual(["a"]);
	});
});

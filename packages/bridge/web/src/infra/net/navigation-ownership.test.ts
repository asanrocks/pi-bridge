// Ownership gates in navigation: only the owning intent may admit a command or
// commit a view. A superseded open sends no RPC (so a slow cache read cannot
// reorder the wire), a no-target alias settles its caller, the Project-home
// transition reads the staged intent instead of the committed one, and a
// newSession initial sync needs an operation id before it can select: an
// unattributed frame may only re-assert, an attributed one only while its
// creation is the newest intent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient, CacheEntryRecord, Document, RpcReply } from "../../../../src/core/index.ts";
import { initFromEntries } from "../../../../src/core/index.ts";
import { getStore } from "../state/store.tsx";
import {
	navigationInitialSync,
	navigationLatest,
	navigationOpen,
	navigationProject,
	resetNavigationForTests,
} from "./navigation.ts";

function emptyDocument(): Document {
	return initFromEntries([]);
}

function gate<T>(): { promise: Promise<T>; open: (value: T) => void } {
	let open!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordsFor(sessionId: string): CacheEntryRecord[] {
	return [
		{
			sessionId,
			ord: 0,
			entryId: "e0",
			entry: {
				kind: "message",
				id: "e0",
				parentId: null,
				timestamp: "2024-01-01T00:00:00Z",
				ord: 0,
				role: "user",
				content: [{ type: "text", text: "seed" }],
			} as unknown as CacheEntryRecord["entry"],
		},
	];
}

/** A client stand-in that records the wire calls it receives, in order. */
interface RecordingClient {
	client: BridgeClient;
	/** Wire calls in arrival order. */
	calls: string[];
	/** Cache read for one session id; `setLoad` gates a specific one. */
	loadSession(sessionId: string): Promise<{ records: CacheEntryRecord[]; hint: null }>;
	setLoad(sessionId: string, load: () => Promise<{ records: CacheEntryRecord[]; hint: null }>): void;
}

/** A client stand-in that records the wire calls it receives, in order. */
function recordingClient(): RecordingClient {
	const calls: string[] = [];
	const loads = new Map<string, () => Promise<{ records: CacheEntryRecord[]; hint: null }>>();
	const client = {
		mirror: { applyReplace: () => {} },
		openSession: async (projectId: string, stem: string) => {
			calls.push(`open:${stem}`);
			return { ok: true, session: { projectId, stem, sessionId: `id-${stem}` } } as unknown as RpcReply;
		},
		detach: async () => {
			calls.push("detach");
			return { ok: true } as RpcReply;
		},
	} as unknown as BridgeClient;
	return {
		client,
		calls,
		loadSession: (sessionId) =>
			loads.get(sessionId)?.() ?? Promise.resolve({ records: recordsFor(sessionId), hint: null }),
		setLoad: (sessionId, load) => loads.set(sessionId, load),
	};
}

const g = globalThis as unknown as { window?: unknown };
let replaceState: ReturnType<typeof vi.fn>;

beforeEach(() => {
	replaceState = vi.fn();
	g.window = { location: { pathname: "/" }, history: { replaceState } };
	getStore().setState({
		currentProjectId: null,
		currentStem: null,
		activeSessionId: null,
		addressViaAlias: false,
		document: emptyDocument(),
		renderLeafId: null,
	});
});

afterEach(() => {
	delete g.window;
});

describe("command emission follows intent order", () => {
	it("a slower cache read cannot reorder the opens on the wire", async () => {
		const fake = recordingClient();
		const slow = gate<{ records: CacheEntryRecord[]; hint: null }>();
		fake.setLoad("id-a", () => slow.promise);
		resetNavigationForTests({
			getClient: () => fake.client,
			lookupSessionId: (_projectId, stem) => `id-${stem}`,
			loadSession: (sessionId) => fake.loadSession(sessionId),
		});

		// A is opened first and superseded by B before its cache read lands.
		const openA = navigationOpen({ projectId: "proj", stem: "a" });
		const openB = navigationOpen({ projectId: "proj", stem: "b" });
		await vi.waitFor(() => expect(fake.calls).toEqual(["open:b"]));
		slow.open({ records: recordsFor("id-a"), hint: null });
		await Promise.all([openA, openB]);

		// The server serializes in arrival order, so a late A would leave the
		// connection attached to A while the view shows B.
		expect(fake.calls).toEqual(["open:b"]);
	});
});

describe("caller settlement", () => {
	it("/@latest with no target settles its caller", async () => {
		const fake = recordingClient();
		resetNavigationForTests({ getClient: () => fake.client, resolveLatest: async () => null });
		const result = await Promise.race([navigationLatest(), delay(100).then(() => "hung" as const)]);
		expect(result).not.toBe("hung");
	});
});

describe("view commits require an owner", () => {
	it("Project home leaves a pending open detached on the server", async () => {
		const fake = recordingClient();
		const slow = gate<{ records: CacheEntryRecord[]; hint: null }>();
		fake.setLoad("id-a", () => slow.promise);
		resetNavigationForTests({
			getClient: () => fake.client,
			lookupSessionId: () => "id-a",
			loadSession: (sessionId) => fake.loadSession(sessionId),
		});

		const opening = navigationOpen({ projectId: "proj", stem: "a" });
		const home = navigationProject("proj");
		await home;
		slow.open({ records: recordsFor("id-a"), hint: null });
		await Promise.all([opening, home]);

		// The superseded open must not leave the Session attached with the UI
		// showing the Project home.
		expect(fake.calls.at(-1)).toBe("detach");
	});

	it("an unattributed newSession sync cannot override a newer Project home", async () => {
		const fake = recordingClient();
		resetNavigationForTests({ getClient: () => fake.client });
		await navigationProject("proj", "boot");
		await navigationProject("proj");

		// A newSession initial sync has no transition identity: it must not
		// commit over the newer intent that owns the view.
		navigationInitialSync({ projectId: "proj", sessionId: "id-a", stem: "a" }, null);
		expect(getStore().getState().currentStem).toBeNull();
	});
});

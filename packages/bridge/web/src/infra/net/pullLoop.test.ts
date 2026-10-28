// Pull loop — the stale-reply guards. A pull can outlive the state it was
// issued against: a reconnect replaces the global client, and a session
// switch on the same socket replaces the mirror. A reply that arrives after
// either must write nothing — not into the successor mirror (setAtPath would
// fabricate the old session's entries), and not into the store (a dead
// socket's mirror is not a publication source).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BridgeClient,
	type BridgeTransport,
	type Document,
	type JsonValue,
	type PullRequestItem,
} from "../../../../src/core/index.ts";
import { getStore } from "../state/store.tsx";
import { setGlobalClient } from "./client.ts";
import { flushPullQueue } from "./pullLoop.ts";
import { drainPullQueue, enqueuePulls } from "./pullQueue.ts";

/** Transport that holds every pull instead of answering, so the test decides
 * when the reply arrives — the interleaving the guards exist for. */
class DeferredTransport implements BridgeTransport {
	sent: unknown[] = [];
	onMessage: ((data: string) => void) | null = null;
	private pendingPulls: Array<{ id: string; requests: PullRequestItem[] }> = [];

	send(data: string): void {
		const frame = JSON.parse(data) as Record<string, unknown>;
		this.sent.push(frame);
		if (frame.verb === "pull") {
			this.pendingPulls.push({
				id: frame.id as string,
				requests: frame.requests as PullRequestItem[],
			});
		}
	}

	/** Deliver one reply for every held pull. */
	reply(values: Array<{ entryId: string; fieldPath: string; value: unknown }>): void {
		const held = this.pendingPulls.splice(0, this.pendingPulls.length);
		for (const pull of held) {
			this.onMessage?.(JSON.stringify({ id: pull.id, ok: true, values }));
		}
	}
}

function emptyStatus(): Document["status"] {
	return {
		leafId: null,
		name: "",
		model: { provider: "", modelId: "" },
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
		contextUsage: null,
		pendingSteer: [],
	};
}

/** One assistant entry whose thinking field is lazy (null — pullable). */
function docOf(entryId: string): Document {
	return {
		status: { ...emptyStatus(), leafId: entryId },
		entries: {
			[entryId]: {
				kind: "message",
				id: entryId,
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				role: "assistant",
				content: [{ type: "thinking", thinking: null }],
			},
		},
	};
}

/** The persisted form of the same entry: sealing keeps the id and installs
 * authoritative content. */
function sealedEntryOf(entryId: string, thinking: string): Document["entries"][string] {
	return {
		kind: "message",
		id: entryId,
		parentId: null,
		timestamp: "2026-01-01T00:00:01Z",
		role: "assistant",
		isSealed: true,
		ord: 0,
		content: [{ type: "thinking", thinking }],
	} as Document["entries"][string];
}

function thinkingOf(doc: Document, entryId: string): string | null | undefined {
	const entry = doc.entries[entryId];
	if (entry === undefined || entry.kind !== "message") return undefined;
	const block = entry.content[0];
	return block !== undefined && block.type === "thinking" ? block.thinking : undefined;
}

const THINKING = (id: string) => `/entries/${id}/content/0/thinking`;

function makeClient(): { client: BridgeClient; transport: DeferredTransport } {
	const transport = new DeferredTransport();
	return { client: new BridgeClient(transport), transport };
}

/** Seed the global client's mirror and the store with `doc`. */
function seed(client: BridgeClient, doc: Document): void {
	client.mirror.applyReplace(doc);
	getStore().getState().applyReplace(doc);
}

describe("pull loop stale-reply guards", () => {
	beforeEach(() => {
		drainPullQueue();
		getStore().getState().setLoadingPaths(new Set());
	});

	afterEach(() => {
		setGlobalClient(null);
	});

	it("ingests an in-scope reply and re-projects", async () => {
		const { client, transport } = makeClient();
		setGlobalClient(client);
		seed(client, docOf("a1"));
		enqueuePulls([{ entryId: "a1", fieldPath: THINKING("a1") }]);

		const pullTickBefore = getStore().getState().pullTick;
		const flushing = flushPullQueue();
		transport.reply([{ entryId: "a1", fieldPath: THINKING("a1"), value: "the thought" }]);
		await flushing;

		expect(client.mirror.document.entries.a1).toMatchObject({ kind: "message" });
		expect(
			(client.mirror.document.entries.a1 as { content: Array<{ thinking: string | null }> }).content[0].thinking,
		).toBe("the thought");
		expect(getStore().getState().document.entries.a1).toBeDefined();
		expect(getStore().getState().pullTick).toBe(pullTickBefore + 1);
	});

	it("drops a reply from a client a reconnect replaced", async () => {
		const old = makeClient();
		setGlobalClient(old.client);
		seed(old.client, docOf("a1"));
		enqueuePulls([{ entryId: "a1", fieldPath: THINKING("a1") }]);

		const flushing = flushPullQueue();
		// The reconnect happens while the pull is in flight: the global client
		// is replaced, and the reply still arrives on the old socket.
		const successor = makeClient();
		const successorDoc = docOf("b1");
		seed(successor.client, successorDoc);
		setGlobalClient(successor.client);
		old.transport.reply([{ entryId: "a1", fieldPath: THINKING("a1"), value: "stale" }]);
		await flushing;

		// The dead socket's mirror is not a publication source: the store keeps
		// the successor's document, and no old-session content reached it.
		expect(getStore().getState().document).toBe(successorDoc);
		expect(successor.client.mirror.document.entries.b1).toBeDefined();
	});

	it("does not fabricate replaced entries in the successor mirror", async () => {
		const { client, transport } = makeClient();
		setGlobalClient(client);
		const before = docOf("a1");
		seed(client, before);
		enqueuePulls([{ entryId: "a1", fieldPath: THINKING("a1") }]);

		const flushing = flushPullQueue();
		// The session switches while the pull is in flight: the mirror is
		// replaced wholesale, so entry a1 is gone.
		const after = docOf("b1");
		client.mirror.applyReplace(after);
		transport.reply([{ entryId: "a1", fieldPath: THINKING("a1"), value: "stale" }]);
		await flushing;

		// The reply addressed the previous session's entry. Writing it would
		// auto-create the path and fabricate a1 inside the successor document.
		expect(client.mirror.document.entries.a1).toBeUndefined();
		expect(client.mirror.document.entries.b1).toBeDefined();
		// The store was not republished from a partially-ingested mirror, and
		// the successor's own content is untouched.
		expect(getStore().getState().document.entries.a1).toBeDefined();
		expect(
			(getStore().getState().document.entries.a1 as { content: Array<{ thinking: string | null }> }).content[0]
				.thinking,
		).toBeNull();
	});

	it("drops a reply for an entry that sealed while the pull was in flight", async () => {
		// The reply describes the streamed form the request left. The entry then
		// seals under the same id with persisted content, so the older read must
		// not be filled over it: nothing later would repair a value the seal has
		// already superseded.
		const { client, transport } = makeClient();
		setGlobalClient(client);
		seed(client, docOf("a1"));
		enqueuePulls([{ entryId: "a1", fieldPath: THINKING("a1") }]);

		const flushing = flushPullQueue();
		client.mirror.applyPatch([
			{ op: "replace", path: "/entries/a1", value: sealedEntryOf("a1", "persisted") as unknown as JsonValue },
		]);
		transport.reply([{ entryId: "a1", fieldPath: THINKING("a1"), value: "streamed, read before the seal" }]);
		await flushing;

		expect(thinkingOf(client.mirror.document, "a1")).toBe("persisted");
		expect(thinkingOf(getStore().getState().document, "a1")).toBeNull();
	});

	it("does not overwrite a field a later patch already filled", async () => {
		// A live patch can deliver newer content than the read the reply carries
		// (streamed appends). Only still-unfetched fields may be filled.
		const { client, transport } = makeClient();
		setGlobalClient(client);
		seed(client, docOf("a1"));
		enqueuePulls([{ entryId: "a1", fieldPath: THINKING("a1") }]);

		const flushing = flushPullQueue();
		client.mirror.applyPatch([{ op: "replace", path: THINKING("a1"), value: "newer" }]);
		transport.reply([{ entryId: "a1", fieldPath: THINKING("a1"), value: "older" }]);
		await flushing;

		expect(thinkingOf(client.mirror.document, "a1")).toBe("newer");
	});
});

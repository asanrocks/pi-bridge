import { describe, expect, it } from "vitest";
import { BridgeClient, type BridgeTransport, getAtPath, type ServerPushMessage } from "../../src/core/index.ts";

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

class MockTransport implements BridgeTransport {
	sent: string[] = [];
	onMessage: ((data: string) => void) | null = null;

	send(data: string): void {
		this.sent.push(data);
	}

	inject(msg: unknown): void {
		if (this.onMessage) this.onMessage(JSON.stringify(msg));
	}
}

function makeClient(): { client: BridgeClient; transport: MockTransport } {
	const transport = new MockTransport();
	const client = new BridgeClient(transport);
	return { client, transport };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BridgeClient", () => {
	// ── RPC demux ────────────────────────────────────────────────────────

	it("resolves RPC reply with matching id", async () => {
		const { client, transport } = makeClient();

		const promise = client.prompt("hello");
		expect(transport.sent.length).toBe(1);

		const sent = JSON.parse(transport.sent[0]);
		expect(sent.verb).toBe("prompt");
		expect(sent.text).toBe("hello");
		expect(sent.id).toBe("1");

		transport.inject({ id: sent.id, ok: true });
		const reply = await promise;
		expect(reply.ok).toBe(true);
	});

	it("ignores RPC reply with mismatched id", async () => {
		const { client, transport } = makeClient();

		const promise = client.prompt("hello");
		// Inject a reply with wrong id — should not resolve
		transport.inject({ id: "999", ok: true });

		// Now inject the correct one
		transport.inject({ id: "1", ok: true });
		const reply = await promise;
		expect(reply.ok).toBe(true);
	});

	it("keeps the reply of a transport that answers inside send", async () => {
		// Correlation must be installed before transmission: an in-process
		// transport can deliver the reply synchronously inside `send`, and a
		// record installed after would miss it — the caller then awaits a
		// promise no later event can settle.
		const transport = new MockTransport();
		transport.send = (data: string) => {
			const { id } = JSON.parse(data) as { id: string };
			transport.onMessage?.(JSON.stringify({ id, ok: true, answered: "inside-send" }));
		};
		const client = new BridgeClient(transport);

		const reply = await client.prompt("hello");
		expect(reply.ok).toBe(true);
		expect((reply as unknown as { answered?: string }).answered).toBe("inside-send");
	});

	it("rejects with the transport's error instead of throwing synchronously", async () => {
		// A closed socket throws from `send`. The caller used the documented
		// Promise shape, so the failure must arrive as a rejection — and the
		// failed request must leave nothing pending for a later disconnect to
		// reject twice.
		const transport = new MockTransport();
		transport.send = () => {
			throw new Error("socket closed");
		};
		const client = new BridgeClient(transport);

		let promise: Promise<unknown>;
		try {
			promise = client.prompt("hello");
		} catch {
			throw new Error("call must not throw synchronously");
		}
		await expect(promise).rejects.toThrow("socket closed");

		// Nothing stays pending: a late reply for the failed id resolves no one,
		// and disconnect does not double-reject.
		transport.send = () => {};
		client.disconnect();
		await expect(promise).rejects.toThrow("socket closed");
	});

	it("rejects all pending RPCs on disconnect", async () => {
		const { client } = makeClient();

		const p1 = client.prompt("a");
		const p2 = client.prompt("b");

		client.disconnect();

		await expect(p1).rejects.toThrow("Disconnected");
		await expect(p2).rejects.toThrow("Disconnected");
	});

	it("sequences RPC ids correctly", () => {
		const { client, transport } = makeClient();

		client.prompt("a");
		client.prompt("b");
		client.abort();

		const ids = transport.sent.map((s) => JSON.parse(s).id);
		expect(ids).toEqual(["1", "2", "3"]);
	});

	// ── Push frames ──────────────────────────────────────────────────────

	it("applyReplace on replace push", () => {
		const { client, transport } = makeClient();

		transport.inject({
			kind: "replace",
			document: {
				status: {
					leafId: "e1",
					name: "test",
					model: { provider: "openai", modelId: "gpt-5" },
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
				},
				entries: {
					e1: {
						kind: "message",
						role: "user",
						id: "e1",
						parentId: null,
						timestamp: "2024-01-01T00:00:00Z",
						content: [{ type: "text", text: "hello" }],
					},
				},
			},
		});

		expect(client.mirror.document.status.leafId).toBe("e1");
		expect(client.mirror.document.status.name).toBe("test");
		expect(client.mirror.document.entries.e1).toBeDefined();
	});

	it("applyPatch on patch push", () => {
		const { client, transport } = makeClient();

		transport.inject({
			kind: "replace",
			document: {
				status: {
					leafId: null,
					name: "",
					model: { provider: "", modelId: "" },
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
				},
				entries: {},
			},
		});

		transport.inject({
			kind: "patch",
			ops: [{ op: "replace", path: "/status/model", value: { provider: "anthropic", modelId: "claude" } }],
		});

		expect(client.mirror.document.status.model).toEqual({ provider: "anthropic", modelId: "claude" });
	});

	it("advances the revision on wholesale replaces and entry-root replacements", () => {
		// A `replace` push and an `add` on `/entries/<id>` for an id the mirror
		// already held are authoritative content changes: structural identity
		// (paths, lengths) cannot see them, so consumers gate re-projection on
		// the mirror's revision.
		const { client, transport } = makeClient();

		const emptyStatus = {
			leafId: null,
			name: "",
			model: { provider: "", modelId: "" },
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
		};
		const entry = (text: string): Record<string, unknown> => ({
			kind: "message",
			id: "e1",
			parentId: null,
			timestamp: "t",
			role: "assistant",
			content: [{ type: "text", text }],
		});

		// A wholesale replace is a revision of everything the mirror holds.
		transport.inject({ kind: "replace", document: { status: emptyStatus, entries: { e1: entry("streamed") } } });
		expect(client.mirror.revision).toBe(1);

		// A block-level update inside the entry is not a replacement.
		transport.inject({
			kind: "patch",
			ops: [{ op: "replace", path: "/entries/e1/content/0/text", value: "more" }],
		});
		expect(client.mirror.revision).toBe(1);

		// Sealing in place — an entry-root add on an existing id — is one.
		transport.inject({ kind: "patch", ops: [{ op: "add", path: "/entries/e1", value: entry("final") }] });
		expect(client.mirror.revision).toBe(2);

		// A genuinely new entry is not.
		transport.inject({ kind: "patch", ops: [{ op: "add", path: "/entries/e2", value: entry("new") }] });
		expect(client.mirror.revision).toBe(2);
	});

	it("fires onPush callback for push frames", () => {
		const { client, transport } = makeClient();

		const pushes: string[] = [];
		client.onPush = (msg) => pushes.push(msg.kind);

		transport.inject({
			kind: "replace",
			document: {
				status: {
					leafId: null,
					name: "",
					model: { provider: "", modelId: "" },
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
				},
				entries: {},
			},
		});
		transport.inject({
			kind: "patch",
			ops: [{ op: "replace", path: "/status/model", value: { provider: "x", modelId: "m" } }],
		});

		expect(pushes).toEqual(["replace", "patch"]);
	});

	it("does not fire onPush for RPC replies", () => {
		const { client, transport } = makeClient();

		const pushes: string[] = [];
		client.onPush = () => pushes.push("push");

		// Send an RPC and reply
		client.prompt("hello");
		transport.inject({ id: "1", ok: true });

		expect(pushes).toEqual([]);
	});

	// ── Compact wire form (bare-string append) ─────────────────────────────

	it("decodes a compact bare-string frame as an append to the remembered path", () => {
		const { client, transport } = makeClient();

		const path = "/entries/pending:message/content/0/thinking";

		// Prime the client's remembered path with a full append-patch frame.
		transport.inject({ kind: "patch", ops: [{ op: "append", path, value: "Hello" }] });
		expect(getAtPath(client.mirror.document, path)).toBe("Hello");

		// A bare JSON string on the wire = compact append to the remembered path.
		if (transport.onMessage) transport.onMessage(JSON.stringify(" world"));

		expect(getAtPath(client.mirror.document, path)).toBe("Hello world");
	});

	it("fires onPush with the restored patch for a compact frame", () => {
		const { client, transport } = makeClient();

		const pushes: ServerPushMessage[] = [];
		client.onPush = (msg) => pushes.push(msg);

		const path = "/entries/pending:message/content/0/thinking";
		transport.inject({ kind: "patch", ops: [{ op: "append", path, value: "a" }] });
		transport.inject({ kind: "patch", ops: [{ op: "append", path, value: "b" }] }); // also compact

		if (transport.onMessage) transport.onMessage(JSON.stringify("c")); // bare string

		expect(pushes.length).toBe(3);
		expect(pushes[2]).toEqual({ kind: "patch", ops: [{ op: "append", path, value: "c" }] });
	});

	// ── Typed verb wire frames ───────────────────────────────────────────

	it("prompt sends correct wire frame", () => {
		const { client, transport } = makeClient();
		client.prompt("fix the bug");
		const frame = JSON.parse(transport.sent[0]);
		expect(frame.verb).toBe("prompt");
		expect(frame.text).toBe("fix the bug");
		expect(frame.id).toBe("1");
	});

	it("setModel sends provider and model", () => {
		const { client, transport } = makeClient();
		client.setModel("openai", "gpt-5");
		const frame = JSON.parse(transport.sent[0]);
		expect(frame.verb).toBe("setModel");
		expect(frame.provider).toBe("openai");
		expect(frame.model).toBe("gpt-5");
	});

	it("setThinkingLevel sends level", () => {
		const { client, transport } = makeClient();
		client.setThinkingLevel("high");
		const frame = JSON.parse(transport.sent[0]);
		expect(frame.verb).toBe("setThinkingLevel");
		expect(frame.level).toBe("high");
	});

	it("renameSession sends name", () => {
		const { client, transport } = makeClient();
		client.renameSession("my-session");
		const frame = JSON.parse(transport.sent[0]);
		expect(frame.verb).toBe("renameSession");
		expect(frame.name).toBe("my-session");
	});

	it("navigate sends entryId", () => {
		const { client, transport } = makeClient();
		client.navigate("entry-42");
		const frame = JSON.parse(transport.sent[0]);
		expect(frame.verb).toBe("navigate");
		expect(frame.entryId).toBe("entry-42");
	});

	it("openSession sends projectId, stem, and optional cursor", () => {
		const { client, transport } = makeClient();
		client.openSession("proj", "2024-01-01_abc");
		const frame = JSON.parse(transport.sent[0]);
		expect(frame.verb).toBe("openSession");
		expect(frame.projectId).toBe("proj");
		expect(frame.stem).toBe("2024-01-01_abc");
		expect(frame.cursor).toBeUndefined();

		client.openSession("proj", "other", { sessionId: "s", lastKnownId: "e2", entryCount: 3 });
		const withCursor = JSON.parse(transport.sent[1]);
		expect(withCursor.stem).toBe("other");
		expect(withCursor.cursor).toEqual({ sessionId: "s", lastKnownId: "e2", entryCount: 3 });
	});

	it("abort, newSession, listSessions, listActiveSessions, getDaemonInfo send correct verbs", () => {
		const { client, transport } = makeClient();

		client.abort();
		expect(JSON.parse(transport.sent[0]).verb).toBe("abort");

		client.newSession("proj", "hello");
		const newSessionFrame = JSON.parse(transport.sent[1]);
		expect(newSessionFrame.verb).toBe("newSession");
		expect(newSessionFrame.projectId).toBe("proj");
		expect(newSessionFrame.text).toBe("hello");
		expect("images" in newSessionFrame).toBe(false);
		expect("model" in newSessionFrame).toBe(false);

		client.newSession("proj", "hello", {
			images: [{ type: "image", mimeType: "image/png", data: "aGk=" }],
			model: { provider: "p", modelId: "m" },
			thinkingLevel: "high",
		});
		const fullFrame = JSON.parse(transport.sent[2]);
		expect(fullFrame.images).toEqual([{ type: "image", mimeType: "image/png", data: "aGk=" }]);
		expect(fullFrame.model).toEqual({ provider: "p", modelId: "m" });
		expect(fullFrame.thinkingLevel).toBe("high");

		client.listSessions("proj", 10, { sortTimeMs: 42, stem: "a" });
		const listFrame = JSON.parse(transport.sent[3]);
		expect(listFrame.verb).toBe("listSessions");
		expect(listFrame.projectId).toBe("proj");
		expect(listFrame.cursor).toEqual({ sortTimeMs: 42, stem: "a" });

		client.listActiveSessions();
		expect(JSON.parse(transport.sent[4]).verb).toBe("listActiveSessions");

		client.getDaemonInfo();
		expect(JSON.parse(transport.sent[5]).verb).toBe("getDaemonInfo");
	});

	it("pull sends requests array", () => {
		const { client, transport } = makeClient();
		client.pull([{ entryId: "e1", fieldPath: "/entries/e1/content/0/text" }]);
		const frame = JSON.parse(transport.sent[0]);
		expect(frame.verb).toBe("pull");
		expect(frame.requests).toEqual([{ entryId: "e1", fieldPath: "/entries/e1/content/0/text" }]);
	});
});

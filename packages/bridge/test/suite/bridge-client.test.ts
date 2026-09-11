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

	it("switchSession sends sessionPath and optional cursor", () => {
		const { client, transport } = makeClient();
		client.switchSession("/tmp/session.jsonl");
		const frame = JSON.parse(transport.sent[0]);
		expect(frame.verb).toBe("switchSession");
		expect(frame.sessionPath).toBe("/tmp/session.jsonl");
		expect(frame.cursor).toBeUndefined();

		client.switchSession("/tmp/other.jsonl", { sessionId: "s", lastKnownId: "e2", entryCount: 3 });
		const withCursor = JSON.parse(transport.sent[1]);
		expect(withCursor.sessionPath).toBe("/tmp/other.jsonl");
		expect(withCursor.cursor).toEqual({ sessionId: "s", lastKnownId: "e2", entryCount: 3 });
	});

	it("abort, newSession, listSessions, getDaemonInfo send correct verbs", () => {
		const { client, transport } = makeClient();

		client.abort();
		expect(JSON.parse(transport.sent[0]).verb).toBe("abort");

		client.newSession();
		expect(JSON.parse(transport.sent[1]).verb).toBe("newSession");

		client.listSessions();
		expect(JSON.parse(transport.sent[2]).verb).toBe("listSessions");

		client.getDaemonInfo();
		expect(JSON.parse(transport.sent[3]).verb).toBe("getDaemonInfo");
	});

	it("pull sends requests array", () => {
		const { client, transport } = makeClient();
		client.pull([{ entryId: "e1", fieldPath: "/entries/e1/content/0/text" }]);
		const frame = JSON.parse(transport.sent[0]);
		expect(frame.verb).toBe("pull");
		expect(frame.requests).toEqual([{ entryId: "e1", fieldPath: "/entries/e1/content/0/text" }]);
	});
});

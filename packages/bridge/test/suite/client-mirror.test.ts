import { describe, expect, it } from "vitest";
import {
	type Document,
	DocumentMirror,
	type PatchOp,
	type PullRequestItem,
	type PullResponseItem,
} from "../../src/core/index.ts";

function emptyDoc(): Document {
	return new DocumentMirror().document;
}

function docWithStatus(overrides: Partial<Document["status"]>): Document {
	const d = emptyDoc();
	Object.assign(d.status, overrides);
	return d;
}

describe("DocumentMirror", () => {
	describe("applyReplace", () => {
		it("replaces the document entirely", () => {
			const mirror = new DocumentMirror();
			mirror.document.status.leafId = "old";
			const e1Key = "e1";
			mirror.document.entries[e1Key] = {
				kind: "message",
				role: "user",
				id: "e1",
				parentId: null,
				timestamp: "",
				content: [],
			};

			const snapshot: Document = {
				status: {
					leafId: "e2",
					name: "test-session",
					model: { provider: "anthropic", modelId: "claude" },
					thinkingLevel: "high",
					isStreaming: false,
					isCompacting: false,
					stats: { tokens: { input: 10, output: 5, total: 15 }, cost: { total: 0.01 }, messages: 1 },
					contextUsage: null,
					pendingSteer: [],
				},
				entries: {
					e2: {
						kind: "message",
						role: "assistant",
						id: "e2",
						parentId: "e1",
						timestamp: "2024-01-01T00:00:00Z",
						content: [],
					},
				},
				scopedModels: [],
			};

			mirror.applyReplace(snapshot);

			expect(mirror.document.status.leafId).toBe("e2");
			expect(mirror.document.status.model).toEqual({ provider: "anthropic", modelId: "claude" });
			expect(mirror.document.entries.e1).toBeUndefined();
			expect(mirror.document.entries.e2).toBeDefined();
			expect(mirror.document.entries.e2.kind).toBe("message");
		});
	});

	describe("applyPatch", () => {
		it("adds, replaces, and removes entries", () => {
			const mirror = new DocumentMirror(docWithStatus({ leafId: null }));

			// Add an entry
			mirror.applyPatch([
				{
					op: "add",
					path: "/entries/e1",
					value: { kind: "message", role: "user", id: "e1", parentId: null, timestamp: "", content: [] },
				},
			]);
			expect(mirror.document.entries.e1).toBeDefined();

			// Replace status
			mirror.applyPatch([{ op: "replace", path: "/status/leafId", value: "e1" }]);
			expect(mirror.document.status.leafId).toBe("e1");

			// Append text
			mirror.applyPatch([{ op: "append", path: "/status/name", value: "opus" }]);
			expect(mirror.document.status.name).toBe("opus");

			// Remove entry
			mirror.applyPatch([{ op: "remove", path: "/entries/e1" }]);
			expect(mirror.document.entries.e1).toBeUndefined();
		});

		it("moves entries (provisional rename)", () => {
			const mirror = new DocumentMirror(docWithStatus({ leafId: "pending:msg" }));
			mirror.applyPatch([
				{
					op: "add",
					path: "/entries/pending:msg",
					value: {
						kind: "message",
						role: "assistant",
						id: "pending:msg",
						parentId: null,
						timestamp: "",
						content: [],
					},
				},
			]);

			// Simulate seal rename
			mirror.applyPatch([
				{ op: "move", from: "/entries/pending:msg", path: "/entries/real-id" },
				{ op: "replace", path: "/entries/real-id/id", value: "real-id" },
				{ op: "add", path: "/entries/real-id/parentId", value: "parent1" },
				{ op: "add", path: "/entries/real-id/timestamp", value: "2024-01-01T00:00:00Z" },
			]);

			expect(mirror.document.entries["pending:msg"]).toBeUndefined();
			expect(mirror.document.entries["real-id"]).toBeDefined();
			expect(mirror.document.entries["real-id"].id).toBe("real-id");
			expect(mirror.document.entries["real-id"].parentId).toBe("parent1");
		});
	});

	describe("needsPull", () => {
		it("returns fields that are null or undefined", () => {
			const mirror = new DocumentMirror();
			mirror.applyReplace({
				status: {
					leafId: null,
					name: "",
					model: { provider: "", modelId: "" },
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
					contextUsage: null,
					pendingSteer: [],
				},
				entries: {
					e1: {
						kind: "message",
						role: "assistant",
						id: "e1",
						parentId: "p1",
						timestamp: "",
						content: [
							{ type: "thinking", thinking: null },
							{ type: "thinking", thinking: "already fetched" },
						],
					},
					e2: {
						kind: "tool_result",
						id: "e2",
						parentId: "p1",
						timestamp: "",
						toolCallId: "tc1",
						toolName: "read",
						content: null,
						details: null,
						isError: false,
					},
				},
				scopedModels: [],
			});

			const wants: PullRequestItem[] = [
				{ entryId: "e1", fieldPath: "/entries/e1/content/0/thinking" },
				{ entryId: "e1", fieldPath: "/entries/e1/content/1/thinking" },
				{ entryId: "e2", fieldPath: "/entries/e2/content" },
				{ entryId: "e2", fieldPath: "/entries/e2/details" },
			];

			const needed = mirror.needsPull(wants);

			// thinking is null → needed
			expect(needed).toContainEqual(wants[0]);
			// thinking is "already fetched" → not needed
			expect(needed).not.toContainEqual(wants[1]);
			// content is null → needed
			expect(needed).toContainEqual(wants[2]);
			// details is null → needed
			expect(needed).toContainEqual(wants[3]);
			expect(needed.length).toBe(3);
		});

		it("returns empty array when all fields are populated", () => {
			const mirror = new DocumentMirror();
			mirror.applyReplace({
				status: {
					leafId: null,
					name: "",
					model: { provider: "", modelId: "" },
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
					contextUsage: null,
					pendingSteer: [],
				},
				entries: {
					e1: {
						kind: "message",
						role: "assistant",
						id: "e1",
						parentId: null,
						timestamp: "",
						content: [{ type: "text", text: "Hello" }],
					},
				},
				scopedModels: [],
			});

			const needed = mirror.needsPull([{ entryId: "e1", fieldPath: "/entries/e1/content/0/text" }]);

			expect(needed).toEqual([]);
		});
	});

	describe("ingestPullResponse", () => {
		it("sets lazy field values from pull responses", () => {
			const mirror = new DocumentMirror();
			mirror.applyReplace({
				status: {
					leafId: null,
					name: "",
					model: { provider: "", modelId: "" },
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
					contextUsage: null,
					pendingSteer: [],
				},
				entries: {
					e1: {
						kind: "message",
						role: "assistant",
						id: "e1",
						parentId: null,
						timestamp: "",
						content: [{ type: "thinking", thinking: null }],
					},
				},
				scopedModels: [],
			});

			const values: PullResponseItem[] = [
				{ entryId: "e1", fieldPath: "/entries/e1/content/0/text", value: "Hello World" },
			];

			mirror.ingestPullResponse(values);

			expect((mirror.document.entries.e1 as { content: { text: string | null }[] }).content[0].text).toBe(
				"Hello World",
			);
		});
	});

	describe("full sync flow", () => {
		it("init → pull → streaming patch → seal rename", () => {
			const mirror = new DocumentMirror();

			// 1. Init snapshot — lazy fields null
			mirror.applyReplace({
				status: {
					leafId: null,
					name: "",
					model: { provider: "", modelId: "" },
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
					contextUsage: null,
					pendingSteer: [],
				},
				entries: {
					e1: {
						kind: "message",
						role: "user",
						id: "e1",
						parentId: null,
						timestamp: "2024-01-01T00:00:00Z",
						content: [{ type: "text", text: "Hello" }],
					},
				},
				scopedModels: [],
			});

			// 2. Text is already present — no pull needed
			expect((mirror.document.entries.e1 as { content: { text: string }[] }).content[0].text).toBe("Hello");

			// 3. Streaming: add provisional assistant message
			const ops: PatchOp[] = [];
			ops.push({
				op: "add",
				path: "/entries/pending:message",
				value: {
					kind: "message",
					role: "assistant",
					id: "pending:message",
					parentId: null,
					timestamp: "",
					content: [],
					api: "anthropic",
					provider: "anthropic",
					model: "claude",
					stopReason: null,
					errorMessage: null,
				},
			});
			ops.push({ op: "add", path: "/entries/pending:message/content/0", value: { type: "text", text: "" } });
			ops.push({ op: "append", path: "/entries/pending:message/content/0/text", value: "Hi" });
			ops.push({ op: "append", path: "/entries/pending:message/content/0/text", value: " there" });
			ops.push({ op: "replace", path: "/status/isStreaming", value: true });
			ops.push({ op: "replace", path: "/status/leafId", value: "pending:message" });
			mirror.applyPatch(ops);

			const pending = mirror.document.entries["pending:message"] as {
				content: { type: string; text: string | null }[];
			};
			expect(pending).toBeDefined();
			const content = pending.content;
			expect(content[0].type).toBe("text");
			expect((content[0] as { text: string }).text).toBe("Hi there");

			// 4. Seal: rename provisional → real id
			mirror.applyPatch([
				{ op: "move", from: "/entries/pending:message", path: "/entries/msg-2" },
				{ op: "replace", path: "/entries/msg-2/id", value: "msg-2" },
				{ op: "add", path: "/entries/msg-2/parentId", value: "e1" },
				{ op: "add", path: "/entries/msg-2/timestamp", value: "2024-01-01T00:00:01Z" },
				{ op: "replace", path: "/entries/msg-2/stopReason", value: "stop" },
				{ op: "replace", path: "/status/leafId", value: "msg-2" },
				{ op: "replace", path: "/status/isStreaming", value: false },
			]);

			expect(mirror.document.entries["pending:message"]).toBeUndefined();
			expect(mirror.document.entries["msg-2"]).toBeDefined();
			expect(mirror.document.entries["msg-2"].id).toBe("msg-2");
			expect(mirror.document.entries["msg-2"].parentId).toBe("e1");
			expect((mirror.document.entries["msg-2"] as { stopReason?: string | null }).stopReason).toBe("stop");
			expect(mirror.document.status.leafId).toBe("msg-2");
			expect(mirror.document.status.isStreaming).toBe(false);
		});
	});
});

import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	applyEvent,
	applyPatch,
	type Content,
	computeObjectDiff,
	type Document,
	type Entry,
	filterPatchForSocket,
	initFromEntries,
	type PatchOp,
	reconcile,
	resolveFieldPath,
	setAtPath,
	snapshotForWire,
} from "../../src/core/index.ts";

// For tests: cast Entry to a loose shape for property access.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lo(e: Entry) {
	return e as Record<string, any>;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function emptyDoc(): Document {
	return {
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
		scopedModels: [],
		entries: {},
	};
}

function msg(role: "user" | "assistant", text: string) {
	return role === "user"
		? { role: "user", content: text, timestamp: 0 }
		: {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "anthropic",
				provider: "anthropic",
				model: "claude",
				stopReason: "stop",
				usage: {
					input: 0,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 0,
			};
}

function se(type: string, overrides: Record<string, unknown> = {}): SessionEntry {
	if (type === "message") {
		return {
			type: "message",
			id: (overrides.id as string) ?? "m1",
			parentId: (overrides.parentId as string) ?? null,
			timestamp: (overrides.timestamp as string) ?? "2024-01-01T00:00:00Z",
			message: {
				role: (overrides.role as string) ?? "user",
				content: (overrides.content as string) ?? "hello",
				timestamp: 0,
			},
		} as SessionEntry;
	}
	return {
		type,
		id: (overrides.id as string) ?? "e1",
		parentId: (overrides.parentId as string) ?? null,
		timestamp: (overrides.timestamp as string) ?? "2024-01-01T00:00:00Z",
		...overrides,
	} as unknown as SessionEntry;
}

// ---------------------------------------------------------------------------
// bash_execution projection (user-initiated shell runs)
// ---------------------------------------------------------------------------

describe("bash_execution entries", () => {
	function bashMsg(overrides: Record<string, unknown>) {
		return {
			role: "bashExecution",
			command: "npm test",
			output: "ok\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 0,
			...overrides,
		};
	}
	const bashEntry = se("message", { id: "b1" });
	(bashEntry as unknown as Record<string, unknown>).message = bashMsg({});

	it("initFromEntries projects a bashExecution message to a bash_execution entry", () => {
		const doc = initFromEntries([bashEntry]);
		const e = lo(doc.entries.b1);
		expect(e.kind).toBe("bash_execution");
		expect(e.command).toBe("npm test");
		expect(e.output).toBe("ok\n");
		expect(e.exitCode).toBe(0);
		expect(e.excludeFromContext).toBe(false);
		expect(doc.status.leafId).toBe("b1");
	});

	it("reconcile picks up a bashExecution message", () => {
		let doc = emptyDoc();
		const patch = reconcile(doc, [bashEntry]);
		expect(patch).not.toBeNull();
		doc = applyPatch(doc, patch!.ops);
		expect(lo(doc.entries.b1).kind).toBe("bash_execution");
	});

	it("entry_appended projects live user bash (exit code, cancel, truncation, context exclusion)", () => {
		const failing = se("message", { id: "b2" });
		(failing as unknown as Record<string, unknown>).message = bashMsg({
			command: "false",
			output: "",
			exitCode: 1,
			truncated: true,
			fullOutputPath: "/tmp/pi-bash1.log",
			excludeFromContext: true,
		});
		let doc = emptyDoc();
		const patch = applyEvent(doc, { type: "entry_appended", entry: failing });
		expect(patch).not.toBeNull();
		doc = applyPatch(doc, patch!.ops);
		const e = lo(doc.entries.b2);
		expect(e.kind).toBe("bash_execution");
		expect(e.exitCode).toBe(1);
		expect(e.cancelled).toBe(false);
		expect(e.truncated).toBe(true);
		expect(e.fullOutputPath).toBe("/tmp/pi-bash1.log");
		expect(e.excludeFromContext).toBe(true);
		expect(doc.status.leafId).toBe("b2");
	});
});

// ---------------------------------------------------------------------------
// initFromEntries
// ---------------------------------------------------------------------------

describe("initFromEntries", () => {
	it("returns empty document for empty entries", () => {
		const doc = initFromEntries([]);
		expect(Object.keys(doc.entries)).toEqual([]);
		expect(doc.status.leafId).toBeNull();
		expect(doc.status.model).toEqual({ provider: "", modelId: "" });
		expect(doc.status.thinkingLevel).toBe("off");
		expect(doc.status.isStreaming).toBe(false);
	});

	it("projects user and assistant messages", () => {
		const entries: SessionEntry[] = [
			se("message", { id: "u1", role: "user", content: "hello" }),
			se("message", { id: "a1", role: "assistant", content: "hi" }),
		];
		const doc = initFromEntries(entries);
		expect(doc.entries.u1.kind).toBe("message");
		expect(lo(doc.entries.u1).role).toBe("user");
		expect(doc.entries.a1.kind).toBe("message");
		expect(lo(doc.entries.a1).role).toBe("assistant");
		expect(doc.status.leafId).toBe("a1");
	});

	it("projects all session entry types", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "t",
				message: { role: "user", content: "x", timestamp: 0 },
			} as SessionEntry,
			{
				type: "compaction",
				id: "c1",
				parentId: null,
				timestamp: "t",
				summary: "summary",
				firstKeptEntryId: "m1",
				tokensBefore: 100,
				fromHook: true,
			} as SessionEntry,
			{
				type: "branch_summary",
				id: "b1",
				parentId: null,
				timestamp: "t",
				fromId: "c1",
				summary: "branch",
			} as SessionEntry,
			{
				type: "model_change",
				id: "mc1",
				parentId: null,
				timestamp: "t",
				provider: "anthropic",
				modelId: "claude",
			} as SessionEntry,
			{
				type: "thinking_level_change",
				id: "t1",
				parentId: null,
				timestamp: "t",
				thinkingLevel: "high",
			} as SessionEntry,
			{
				type: "label",
				id: "l1",
				parentId: null,
				timestamp: "t",
				targetId: "m1",
				label: "important",
			} as SessionEntry,
			{ type: "session_info", id: "s1", parentId: null, timestamp: "t", name: "My Session" } as SessionEntry,
			{
				type: "custom",
				id: "cu1",
				parentId: null,
				timestamp: "t",
				customType: "test",
				data: { foo: "bar" },
			} as SessionEntry,
			{
				type: "custom_message",
				id: "cm1",
				parentId: null,
				timestamp: "t",
				customType: "note",
				content: "a note",
				details: {},
				display: true,
			} as SessionEntry,
		];
		const doc = initFromEntries(entries);
		expect(doc.entries.m1.kind).toBe("message");
		expect(doc.entries.c1.kind).toBe("compaction");
		expect(doc.entries.b1.kind).toBe("branch_summary");
		expect(doc.entries.mc1.kind).toBe("model_change");
		expect(doc.entries.t1.kind).toBe("thinking_level_change");
		expect(doc.entries.l1.kind).toBe("label");
		expect(doc.entries.s1.kind).toBe("session_info");
		expect(doc.entries.cu1.kind).toBe("custom");
		expect(doc.entries.cm1.kind).toBe("custom_message");
	});

	it("derives status from entries", () => {
		const entries: SessionEntry[] = [
			se("model_change", { id: "mc1", provider: "anthropic", modelId: "claude" }),
			se("thinking_level_change", { id: "t1", thinkingLevel: "high" }),
		];
		const doc = initFromEntries(entries);
		expect(doc.status.model).toEqual({ provider: "anthropic", modelId: "claude" });
		expect(doc.status.thinkingLevel).toBe("high");
		expect(doc.status.leafId).toBe("t1");
	});

	it("handles unknown entry types as custom", () => {
		const entry = {
			type: "future_type",
			id: "f1",
			parentId: null,
			timestamp: "t",
			data: {},
		} as unknown as SessionEntry;
		const doc = initFromEntries([entry]);
		expect(doc.entries.f1.kind).toBe("custom");
		expect((doc.entries.f1 as Extract<Entry, { kind: "custom" }>).customType).toBe("future_type");
	});
});

// ---------------------------------------------------------------------------
// applyEvent — individual event types in isolation
// ---------------------------------------------------------------------------

describe("applyEvent", () => {
	describe("agent lifecycle", () => {
		it("agent_start sets isStreaming", () => {
			let doc = emptyDoc();
			const patch = applyEvent(doc, { type: "agent_start" } as AgentSessionEvent);
			expect(patch).not.toBeNull();
			doc = applyPatch(doc, patch!.ops);
			expect(doc.status.isStreaming).toBe(true);
		});

		it("agent_settled clears isStreaming", () => {
			let doc = emptyDoc();
			doc = applyPatch(doc, applyEvent(doc, { type: "agent_start" } as AgentSessionEvent)!.ops);
			const patch = applyEvent(doc, { type: "agent_settled" } as AgentSessionEvent);
			doc = applyPatch(doc, patch!.ops);
			expect(doc.status.isStreaming).toBe(false);
		});
	});

	describe("compaction lifecycle", () => {
		it("compaction_start sets isCompacting", () => {
			let doc = emptyDoc();
			const patch = applyEvent(doc, { type: "compaction_start", reason: "manual" } as AgentSessionEvent);
			doc = applyPatch(doc, patch!.ops);
			expect(doc.status.isCompacting).toBe(true);
		});

		it("compaction_end clears isCompacting", () => {
			let doc = emptyDoc();
			doc = applyPatch(
				doc,
				applyEvent(doc, { type: "compaction_start", reason: "manual" } as AgentSessionEvent)!.ops,
			);
			const patch = applyEvent(doc, {
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted: false,
				willRetry: false,
			} as AgentSessionEvent);
			doc = applyPatch(doc, patch!.ops);
			expect(doc.status.isCompacting).toBe(false);
		});
	});

	describe("thinking_level_changed", () => {
		it("updates status.thinkingLevel", () => {
			let doc = emptyDoc();
			const patch = applyEvent(doc, { type: "thinking_level_changed", level: "high" } as AgentSessionEvent);
			doc = applyPatch(doc, patch!.ops);
			expect(doc.status.thinkingLevel).toBe("high");
		});
	});

	describe("message_start (user)", () => {
		it("adds a pending:user entry", () => {
			let doc = emptyDoc();
			const patch = applyEvent(doc, {
				type: "message_start",
				message: msg("user", "hello"),
			} as unknown as AgentSessionEvent);
			doc = applyPatch(doc, patch!.ops);

			expect(doc.entries["pending:user:1"]).toBeDefined();
			expect(lo(doc.entries["pending:user:1"]).kind).toBe("message");
			expect(lo(doc.entries["pending:user:1"]).role).toBe("user");
		});

		it("increments ordinal for multiple user messages", () => {
			let doc = emptyDoc();
			doc = applyPatch(
				doc,
				applyEvent(doc, { type: "message_start", message: msg("user", "first") } as unknown as AgentSessionEvent)!
					.ops,
			);
			doc = applyPatch(
				doc,
				applyEvent(doc, { type: "message_start", message: msg("user", "second") } as unknown as AgentSessionEvent)!
					.ops,
			);

			expect(doc.entries["pending:user:1"]).toBeDefined();
			expect(doc.entries["pending:user:2"]).toBeDefined();
		});
	});

	describe("message_start (assistant)", () => {
		it("adds a pending:message skeleton", () => {
			let doc = emptyDoc();
			const patch = applyEvent(doc, {
				type: "message_start",
				message: msg("assistant", ""),
			} as unknown as AgentSessionEvent);
			doc = applyPatch(doc, patch!.ops);

			const entry = lo(doc.entries["pending:message"]);
			expect(entry).toBeDefined();
			expect(entry.kind).toBe("message");
			expect(entry.role).toBe("assistant");
			// Content is empty array in the skeleton
			expect(lo(doc.entries["pending:message"]).content).toEqual([]);
		});
	});

	describe("message_update (streaming deltas)", () => {
		it("text_start → text_delta → text_end", () => {
			let doc = emptyDoc();
			// Setup pending:message
			doc = applyPatch(
				doc,
				applyEvent(doc, { type: "message_start", message: msg("assistant", "") } as unknown as AgentSessionEvent)!
					.ops,
			);

			// text_start
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_update",
					assistantMessageEvent: {
						type: "text_start",
						contentIndex: 0,
						partial: msg("assistant", ""),
					},
				} as unknown as AgentSessionEvent)!.ops,
			);

			const content0 = lo(doc.entries["pending:message"]).content[0];
			expect(content0.type).toBe("text");
			expect((content0 as { text: string }).text).toBe("");

			// text_delta
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_update",
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: "Hello",
						partial: msg("assistant", ""),
					},
				} as unknown as AgentSessionEvent)!.ops,
			);
			expect((lo(doc.entries["pending:message"]).content[0] as { text: string | null }).text).toBe("Hello");

			// More delta
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_update",
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: " World",
						partial: msg("assistant", ""),
					},
				} as unknown as AgentSessionEvent)!.ops,
			);
			expect((lo(doc.entries["pending:message"]).content[0] as { text: string | null }).text).toBe("Hello World");

			// text_end (authoritative final)
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_update",
					assistantMessageEvent: {
						type: "text_end",
						contentIndex: 0,
						content: "Hello World!",
						partial: msg("assistant", ""),
					},
				} as unknown as AgentSessionEvent)!.ops,
			);
			expect((lo(doc.entries["pending:message"]).content[0] as { text: string | null }).text).toBe("Hello World!");
		});

		it("thinking_start → thinking_delta → thinking_end", () => {
			let doc = emptyDoc();
			doc = applyPatch(
				doc,
				applyEvent(doc, { type: "message_start", message: msg("assistant", "") } as unknown as AgentSessionEvent)!
					.ops,
			);

			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_update",
					assistantMessageEvent: {
						type: "thinking_start",
						contentIndex: 0,
						partial: msg("assistant", ""),
					},
				} as unknown as AgentSessionEvent)!.ops,
			);

			expect(lo(doc.entries["pending:message"]).content[0].type).toBe("thinking");
			expect((lo(doc.entries["pending:message"]).content[0] as { thinking: string | null }).thinking).toBeNull();

			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_update",
					assistantMessageEvent: {
						type: "thinking_delta",
						contentIndex: 0,
						delta: "Hmm",
						partial: msg("assistant", ""),
					},
				} as unknown as AgentSessionEvent)!.ops,
			);
			expect((lo(doc.entries["pending:message"]).content[0] as { thinking: string | null }).thinking).toBe("Hmm");
		});

		it("toolcall_start → toolcall_delta → toolcall_end", () => {
			let doc = emptyDoc();
			doc = applyPatch(
				doc,
				applyEvent(doc, { type: "message_start", message: msg("assistant", "") } as unknown as AgentSessionEvent)!
					.ops,
			);

			// toolcall_start with a partial message that has the tool call block.
			// The skeleton must carry name and id from the partial.
			const partialWithToolCall = {
				role: "assistant",
				content: [{ type: "toolCall" as const, id: "tc1", name: "read", arguments: {} }],
				api: "anthropic",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse" as const,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 0,
			};
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_update",
					assistantMessageEvent: {
						type: "toolcall_start",
						contentIndex: 0,
						partial: partialWithToolCall,
					},
				} as unknown as AgentSessionEvent)!.ops,
			);

			const tc = lo(doc.entries["pending:message"]).content[0];
			expect(tc.type).toBe("toolCall");
			expect((tc as { id: string }).id).toBe("tc1");
			expect((tc as { name: string }).name).toBe("read");
			// toolcall_start stores the partial arguments object directly
			expect((tc as { arguments: unknown }).arguments).toEqual({});

			// toolcall_delta produces granular ops (add /path) from the diff
			const deltaPartialWithToolCall = {
				...partialWithToolCall,
				content: [{ type: "toolCall" as const, id: "tc1", name: "read", arguments: { path: "/x" } }],
			};
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_update",
					assistantMessageEvent: {
						type: "toolcall_delta",
						contentIndex: 0,
						delta: '{"path":"/',
						partial: deltaPartialWithToolCall,
					},
				} as unknown as AgentSessionEvent)!.ops,
			);
			expect((lo(doc.entries["pending:message"]).content[0] as { arguments: unknown }).arguments).toEqual({
				path: "/x",
			});

			// toolcall_end replaces the whole block with the parsed ToolCall
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_update",
					assistantMessageEvent: {
						type: "toolcall_end",
						contentIndex: 0,
						toolCall: { id: "tc1", name: "read", arguments: { path: "/x" } },
						partial: msg("assistant", ""),
					},
				} as unknown as AgentSessionEvent)!.ops,
			);

			const finalTc = lo(doc.entries["pending:message"]).content[0];
			expect(finalTc.type).toBe("toolCall");
			expect((finalTc as { id: string }).id).toBe("tc1");
			expect((finalTc as { name: string }).name).toBe("read");
			expect((finalTc as { arguments: unknown }).arguments).toEqual({ path: "/x" });
		});

		it("toolcall_delta produces granular ops: add new key, append string, replace non-prefix", () => {
			// Diff from {} → {path: "/a"} → add /path
			const ops1 = computeObjectDiff({}, { path: "/a" }, "/args");
			expect(ops1).toEqual([{ op: "add", path: "/args/path", value: "/a" }]);

			// Diff from {path: "/a"} → {path: "/a/b"} → append /b
			const ops2 = computeObjectDiff({ path: "/a" }, { path: "/a/b" }, "/args");
			expect(ops2).toEqual([{ op: "append", path: "/args/path", value: "/b" }]);

			// Diff from {path: "/a"} → {path: "/other"} → replace (not a prefix)
			const ops3 = computeObjectDiff({ path: "/a" }, { path: "/other" }, "/args");
			expect(ops3).toEqual([{ op: "replace", path: "/args/path", value: "/other" }]);

			// Diff from {path: "/a"} → {path: "/a", content: "hello"} → add content
			const ops4 = computeObjectDiff({ path: "/a" }, { path: "/a", content: "hello" }, "/args");
			expect(ops4).toEqual([{ op: "add", path: "/args/content", value: "hello" }]);

			// Key removed (edge case)
			const ops5 = computeObjectDiff({ path: "/a", extra: "x" }, { path: "/a" }, "/args");
			expect(ops5).toEqual([{ op: "remove", path: "/args/extra" }]);

			// Nested object with an array: diff recurses into array elements.
			const ops6 = computeObjectDiff(
				{ edits: [{ oldText: "a" }] },
				{ edits: [{ oldText: "a", newText: "b" }] },
				"/args",
			);
			// Array recurses: element 0 gained `newText` → add, not whole-array replace.
			expect(ops6).toEqual([{ op: "add", path: "/args/edits/0/newText", value: "b" }]);

			// Array element string grows by suffix → append on the element sub-path.
			const ops6b = computeObjectDiff({ edits: [{ newText: "ab" }] }, { edits: [{ newText: "abc" }] }, "/args");
			expect(ops6b).toEqual([{ op: "append", path: "/args/edits/0/newText", value: "c" }]);

			// Array grows by appending a trailing element → add at the new last index.
			const ops6c = computeObjectDiff(
				{ edits: [{ newText: "a" }] },
				{ edits: [{ newText: "a" }, { newText: "b" }] },
				"/args",
			);
			expect(ops6c).toEqual([{ op: "add", path: "/args/edits/1", value: { newText: "b" } }]);

			// Array shrinks → remove from the tail (high index first so splice
			// shifts don't corrupt lower indices).
			const ops6d = computeObjectDiff(
				{ edits: [{ newText: "a" }, { newText: "b" }, { newText: "c" }] },
				{ edits: [{ newText: "a" }] },
				"/args",
			);
			expect(ops6d).toEqual([
				{ op: "remove", path: "/args/edits/2" },
				{ op: "remove", path: "/args/edits/1" },
			]);

			// Nested arrays: recurse two levels deep.
			const ops6e = computeObjectDiff({ matrix: [["a", "b"]] }, { matrix: [["a", "b", "c"]] }, "/args");
			expect(ops6e).toEqual([{ op: "add", path: "/args/matrix/0/2", value: "c" }]);

			// Nested objects: diff recurses into sub-keys
			const ops7 = computeObjectDiff(
				{ metadata: { lines: 10, author: "alice" } },
				{ metadata: { lines: 12, author: "alice" } },
				"/args",
			);
			expect(ops7).toEqual([{ op: "replace", path: "/args/metadata/lines", value: 12 }]);

			// New key inside nested object
			const ops8 = computeObjectDiff(
				{ metadata: { lines: 10 } },
				{ metadata: { lines: 10, author: "bob" } },
				"/args",
			);
			expect(ops8).toEqual([{ op: "add", path: "/args/metadata/author", value: "bob" }]);

			// Number change (not string, not object) → replace
			const ops9 = computeObjectDiff({ offset: 10 }, { offset: 20 }, "/args");
			expect(ops9).toEqual([{ op: "replace", path: "/args/offset", value: 20 }]);

			// Boolean change → replace
			const ops10 = computeObjectDiff({ enabled: false }, { enabled: true }, "/args");
			expect(ops10).toEqual([{ op: "replace", path: "/args/enabled", value: true }]);

			// null value → replace
			const ops11 = computeObjectDiff({ flag: "set" }, { flag: null }, "/args");
			expect(ops11).toEqual([{ op: "replace", path: "/args/flag", value: null }]);

			// Deeply nested object — recurses two+ levels, not just one
			const ops12 = computeObjectDiff(
				{ metadata: { info: { lines: 10 } } },
				{ metadata: { info: { lines: 12 } } },
				"/args",
			);
			expect(ops12).toEqual([{ op: "replace", path: "/args/metadata/info/lines", value: 12 }]);
		});

		it("toolcall_delta with proper partial updates arguments incrementally", () => {
			let doc = emptyDoc();
			doc = applyPatch(
				doc,
				applyEvent(doc, { type: "message_start", message: msg("assistant", "") } as unknown as AgentSessionEvent)!
					.ops,
			);

			const partialBase = {
				role: "assistant" as const,
				api: "anthropic",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse" as const,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 0,
			};

			// toolcall_start: arguments = {} (empty object)
			const partialStart = {
				...partialBase,
				content: [{ type: "toolCall" as const, id: "tc1", name: "edit", arguments: {} }],
			};
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_update",
					assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: partialStart },
				} as unknown as AgentSessionEvent)!.ops,
			);
			const args1 = (lo(doc.entries["pending:message"]).content[0] as { arguments: unknown }).arguments;
			expect(args1).toEqual({});

			// toolcall_delta 1: arguments.path = "/src" (add new key)
			const partialDelta1 = {
				...partialBase,
				content: [{ type: "toolCall" as const, id: "tc1", name: "edit", arguments: { path: "/src" } }],
			};
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_update",
					assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "", partial: partialDelta1 },
				} as unknown as AgentSessionEvent)!.ops,
			);
			const args2 = (lo(doc.entries["pending:message"]).content[0] as { arguments: unknown }).arguments;
			expect(args2).toEqual({ path: "/src" });

			// toolcall_delta 2: arguments.path appends "/main.ts"
			const partialDelta2 = {
				...partialBase,
				content: [{ type: "toolCall" as const, id: "tc1", name: "edit", arguments: { path: "/src/main.ts" } }],
			};
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_update",
					assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "", partial: partialDelta2 },
				} as unknown as AgentSessionEvent)!.ops,
			);
			const args3 = (lo(doc.entries["pending:message"]).content[0] as { arguments: unknown }).arguments;
			expect(args3).toEqual({ path: "/src/main.ts" });

			// toolcall_delta 3: arguments.content starts streaming
			const partialDelta3 = {
				...partialBase,
				content: [
					{
						type: "toolCall" as const,
						id: "tc1",
						name: "edit",
						arguments: { path: "/src/main.ts", content: "The qui" },
					},
				],
			};
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_update",
					assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "", partial: partialDelta3 },
				} as unknown as AgentSessionEvent)!.ops,
			);
			const args4 = (lo(doc.entries["pending:message"]).content[0] as { arguments: unknown }).arguments;
			expect(args4).toEqual({ path: "/src/main.ts", content: "The qui" });

			// toolcall_delta 4: content appends
			const partialDelta4 = {
				...partialBase,
				content: [
					{
						type: "toolCall" as const,
						id: "tc1",
						name: "edit",
						arguments: { path: "/src/main.ts", content: "The quick brown" },
					},
				],
			};
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_update",
					assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "", partial: partialDelta4 },
				} as unknown as AgentSessionEvent)!.ops,
			);
			const args5 = (lo(doc.entries["pending:message"]).content[0] as { arguments: unknown }).arguments;
			expect(args5).toEqual({ path: "/src/main.ts", content: "The quick brown" });
		});
	});

	describe("message_end", () => {
		it("updates assistant metadata and leafId", () => {
			let doc = emptyDoc();
			doc = applyPatch(
				doc,
				applyEvent(doc, { type: "message_start", message: msg("assistant", "") } as unknown as AgentSessionEvent)!
					.ops,
			);

			const patch = applyEvent(doc, {
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hi" }],
					api: "anthropic",
					provider: "anthropic",
					model: "claude",
					stopReason: "stop",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
					},
					timestamp: 0,
				},
			} as unknown as AgentSessionEvent);
			doc = applyPatch(doc, patch!.ops);

			const e = lo(doc.entries["pending:message"]) as Extract<Entry, { kind: "message" }>;
			expect(e.api).toBe("anthropic");
			expect(e.stopReason).toBe("stop");
			expect(e.usage).toBeDefined();
			expect(e.usage!.totalTokens).toBe(15);
			expect(doc.status.leafId).toBe("pending:message");
		});

		it("returns null for no-op events", () => {
			const doc = emptyDoc();
			const patch = applyEvent(doc, {
				type: "turn_end",
				message: msg("assistant", "x"),
				toolResults: [],
			} as unknown as AgentSessionEvent);
			expect(patch).toBeNull();
		});

		it("updates leafId to tool result provisional for toolResult role", () => {
			let doc = emptyDoc();
			// Add a tool result provisional
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "tool_execution_start",
					toolCallId: "tc1",
					toolName: "read",
					args: {},
				} as AgentSessionEvent)!.ops,
			);

			const patch = applyEvent(doc, {
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: 0,
				},
			} as unknown as AgentSessionEvent);
			doc = applyPatch(doc, patch!.ops);

			expect(doc.status.leafId).toBe("pending:tc1");
		});

		it("updates leafId to user provisional for user role", () => {
			let doc = emptyDoc();
			// Add user message provisonal
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_start",
					message: msg("user", "hello"),
				} as unknown as AgentSessionEvent)!.ops,
			);

			const patch = applyEvent(doc, {
				type: "message_end",
				message: {
					role: "user",
					content: "hello",
					timestamp: 0,
				},
			} as unknown as AgentSessionEvent);
			doc = applyPatch(doc, patch!.ops);

			expect(doc.status.leafId).toBe("pending:user:1");
		});
	});

	describe("tool_execution events", () => {
		it("tool_execution_start adds pending entry", () => {
			let doc = emptyDoc();
			const patch = applyEvent(doc, {
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "read",
				args: { path: "/x" },
			} as AgentSessionEvent);
			doc = applyPatch(doc, patch!.ops);

			const e = lo(doc.entries["pending:tc1"]) as Extract<Entry, { kind: "tool_result" }>;
			expect(e.kind).toBe("tool_result");
			expect(e.toolCallId).toBe("tc1");
			expect(e.toolName).toBe("read");
			expect(e.content).toBeNull();
			expect(e.details).toBeNull();
			expect(e.isError).toBe(false);
		});

		it("tool_execution_update replaces content and details", () => {
			let doc = emptyDoc();
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "tool_execution_start",
					toolCallId: "tc1",
					toolName: "read",
					args: {},
				} as AgentSessionEvent)!.ops,
			);

			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "tool_execution_update",
					toolCallId: "tc1",
					toolName: "read",
					args: {},
					partialResult: { content: [{ type: "text", text: "partial" }], details: { lines: 10 } },
				} as unknown as AgentSessionEvent)!.ops,
			);

			const e = lo(doc.entries["pending:tc1"]) as Extract<Entry, { kind: "tool_result" }>;
			expect(e.content).toBeDefined();
			expect(e.details).toBeDefined();
		});

		it("tool_execution_end finalizes content and isError", () => {
			let doc = emptyDoc();
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "tool_execution_start",
					toolCallId: "tc1",
					toolName: "read",
					args: {},
				} as AgentSessionEvent)!.ops,
			);

			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "tool_execution_end",
					toolCallId: "tc1",
					toolName: "read",
					result: { content: [{ type: "text", text: "final" }], details: {} },
					isError: true,
				} as AgentSessionEvent)!.ops,
			);

			const e = lo(doc.entries["pending:tc1"]) as Extract<Entry, { kind: "tool_result" }>;
			expect(e.isError).toBe(true);
		});
	});

	describe("entry_appended (custom entries)", () => {
		it("adds the projected entry with real id", () => {
			let doc = emptyDoc();
			const patch = applyEvent(doc, {
				type: "entry_appended",
				entry: {
					type: "custom",
					id: "cu1",
					parentId: null,
					timestamp: "t",
					customType: "my-plugin",
					data: { key: 1 },
				},
			} as AgentSessionEvent);
			doc = applyPatch(doc, patch!.ops);

			expect(doc.entries.cu1).toBeDefined();
			expect(doc.entries.cu1.kind).toBe("custom");
			expect((doc.entries.cu1 as Extract<Entry, { kind: "custom" }>).customType).toBe("my-plugin");
			expect(doc.status.leafId).toBe("cu1");
		});
	});

	describe("queue_update", () => {
		it("surfaces steering as a /status/pendingSteer replace patch", () => {
			let doc = emptyDoc();
			const patch = applyEvent(doc, {
				type: "queue_update",
				steering: ["actually use Python"],
				followUp: [],
			});
			expect(patch).not.toBeNull();
			expect(patch!.ops).toEqual([{ op: "replace", path: "/status/pendingSteer", value: ["actually use Python"] }]);
			doc = applyPatch(doc, patch!.ops);
			expect(doc.status.pendingSteer).toEqual(["actually use Python"]);
		});

		it("clears pendingSteer when the queue drains to empty", () => {
			let doc: Document = setAtPath(emptyDoc(), "/status/pendingSteer", ["stale"]);
			const patch = applyEvent(doc, { type: "queue_update", steering: [], followUp: [] });
			expect(patch).not.toBeNull();
			doc = applyPatch(doc, patch!.ops);
			expect(doc.status.pendingSteer).toEqual([]);
		});

		it("does not surface followUp (steer-only MVP)", () => {
			let doc = emptyDoc();
			const patch = applyEvent(doc, {
				type: "queue_update",
				steering: ["do X"],
				followUp: ["then do Y"],
			});
			doc = applyPatch(doc, patch!.ops);
			expect(doc.status.pendingSteer).toEqual(["do X"]);
		});

		it("preserves order across sequential queue_update events (native FIFO)", () => {
			let doc = emptyDoc();
			doc = applyPatch(doc, applyEvent(doc, { type: "queue_update", steering: ["first"], followUp: [] })!.ops);
			doc = applyPatch(
				doc,
				applyEvent(doc, { type: "queue_update", steering: ["first", "second"], followUp: [] })!.ops,
			);
			expect(doc.status.pendingSteer).toEqual(["first", "second"]);
		});
	});
});

// ---------------------------------------------------------------------------
// reconcile — provisional rename, silent entries, status drift
// ---------------------------------------------------------------------------

describe("reconcile", () => {
	it("renames provisional assistant message to real id", () => {
		let doc = emptyDoc();
		// Simulate streaming: add pending:message
		doc = applyPatch(doc, [
			{
				op: "add",
				path: "/entries/pending:message",
				value: {
					kind: "message",
					role: "assistant",
					id: "pending:message",
					parentId: null,
					timestamp: "",
					content: [],
				},
			},
		]);

		const piEntries: SessionEntry[] = [
			se("message", { id: "real-msg-1", role: "assistant", parentId: "parent1", timestamp: "2024-01-01T00:00:00Z" }),
		];

		const patch = reconcile(doc, piEntries);
		doc = applyPatch(doc, patch!.ops);

		expect(doc.entries["pending:message"]).toBeUndefined();
		expect(doc.entries["real-msg-1"]).toBeDefined();
		expect(lo(doc.entries["real-msg-1"]).id).toBe("real-msg-1");
		expect(lo(doc.entries["real-msg-1"]).parentId).toBe("parent1");
		expect(lo(doc.entries["real-msg-1"]).timestamp).toBe("2024-01-01T00:00:00Z");
	});

	it("renames provisional tool result by toolCallId", () => {
		let doc = emptyDoc();
		doc = applyPatch(doc, [
			{
				op: "add",
				path: "/entries/pending:tc1",
				value: {
					kind: "tool_result",
					id: "pending:tc1",
					parentId: null,
					timestamp: "",
					toolCallId: "tc1",
					toolName: "read",
					content: null,
					details: null,
					isError: false,
				},
			},
		]);

		const piEntries: SessionEntry[] = [
			{
				type: "message",
				id: "tr1",
				parentId: "p1",
				timestamp: "t",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 0,
				},
			},
		] as SessionEntry[];

		const patch = reconcile(doc, piEntries);
		doc = applyPatch(doc, patch!.ops);

		expect(doc.entries["pending:tc1"]).toBeUndefined();
		expect(doc.entries.tr1).toBeDefined();
		expect(doc.entries.tr1.kind).toBe("tool_result");
		// Invariant 7: seal backfills lazy fields the stream left null from the
		// durable entry — content from pi, absent details normalized to {}.
		expect(lo(doc.entries.tr1).content).toEqual([{ type: "text", text: "ok" }]);
		expect(lo(doc.entries.tr1).details).toEqual({});
	});

	it("backfills null thinking and arguments on sealed assistant message (abort before *_end)", () => {
		let doc = emptyDoc();
		doc = applyPatch(doc, [
			{
				op: "add",
				path: "/entries/pending:message",
				value: {
					kind: "message",
					role: "assistant",
					id: "pending:message",
					parentId: null,
					timestamp: "",
					content: [
						{ type: "thinking", thinking: null },
						{ type: "toolCall", id: "", name: "", arguments: null },
					],
				},
			},
		]);

		const piEntries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: "p1",
				timestamp: "t",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "partial thought" },
						{ type: "toolCall", id: "tc9", name: "bash", arguments: { command: "ls" } },
					],
					timestamp: 0,
				},
			},
		] as unknown as SessionEntry[];

		const patch = reconcile(doc, piEntries);
		doc = applyPatch(doc, patch!.ops);

		const content = lo(doc.entries.m1).content as Array<Record<string, unknown>>;
		expect(content[0].thinking).toBe("partial thought");
		expect(content[1].arguments).toEqual({ command: "ls" });
	});

	it("discovers silent entries (model_change)", () => {
		let doc = emptyDoc();
		const piEntries: SessionEntry[] = [se("model_change", { id: "mc1", provider: "anthropic", modelId: "claude" })];

		const patch = reconcile(doc, piEntries);
		doc = applyPatch(doc, patch!.ops);

		expect(doc.entries.mc1).toBeDefined();
		expect(doc.entries.mc1.kind).toBe("model_change");
		// Lazy fields are null in the added entry
	});

	it("discovers silent entries (thinking_level_change)", () => {
		let doc = emptyDoc();
		const piEntries: SessionEntry[] = [se("thinking_level_change", { id: "t1", thinkingLevel: "high" })];

		const patch = reconcile(doc, piEntries);
		doc = applyPatch(doc, patch!.ops);

		expect(doc.entries.t1).toBeDefined();
		expect(doc.entries.t1.kind).toBe("thinking_level_change");
	});

	it("discovers silent entries (compaction)", () => {
		let doc = emptyDoc();
		const piEntries: SessionEntry[] = [
			{
				type: "compaction",
				id: "c1",
				parentId: null,
				timestamp: "t",
				summary: "s",
				firstKeptEntryId: "a",
				tokensBefore: 50,
			},
		] as SessionEntry[];

		const patch = reconcile(doc, piEntries);
		doc = applyPatch(doc, patch!.ops);

		expect(doc.entries.c1).toBeDefined();
		expect(doc.entries.c1.kind).toBe("compaction");
	});

	it("discovers silent entries (label)", () => {
		let doc = emptyDoc();
		const piEntries: SessionEntry[] = [
			{ type: "label", id: "l1", parentId: null, timestamp: "t", targetId: "m1", label: "star" },
		] as SessionEntry[];

		const patch = reconcile(doc, piEntries);
		doc = applyPatch(doc, patch!.ops);

		expect(doc.entries.l1).toBeDefined();
		expect(doc.entries.l1.kind).toBe("label");
	});

	it("discovers silent entries (session_info)", () => {
		let doc = emptyDoc();
		const piEntries: SessionEntry[] = [
			{ type: "session_info", id: "s1", parentId: null, timestamp: "t", name: "My Session" },
		] as SessionEntry[];

		const patch = reconcile(doc, piEntries);
		doc = applyPatch(doc, patch!.ops);

		expect(doc.entries.s1).toBeDefined();
		expect(doc.entries.s1.kind).toBe("session_info");
	});

	it("skips entries already in document (custom via entry_appended)", () => {
		let doc = emptyDoc();
		// entry_appended already added it
		doc = setAtPath(doc, "/entries/cu1", {
			kind: "custom",
			id: "cu1",
			parentId: null,
			timestamp: "t",
			customType: "my-plugin",
			data: null,
		});

		const piEntries: SessionEntry[] = [
			{ type: "custom", id: "cu1", parentId: null, timestamp: "t", customType: "my-plugin", data: {} },
		] as SessionEntry[];

		const patch = reconcile(doc, piEntries);
		expect(patch).not.toBeNull();
		// ADR 09: the known entry is ord-less (entry_appended path), so
		// reconcile assigns its file position, plus the leafId update.
		const ops = patch!.ops;
		expect(ops.length).toBe(2);
		expect(ops[0]).toEqual({ op: "replace", path: "/entries/cu1/ord", value: 0 });
		expect(ops[1]).toEqual({ op: "replace", path: "/status/leafId", value: "cu1" });
	});

	it("repairs status drift (model, thinkingLevel)", () => {
		let doc = emptyDoc();
		doc = setAtPath(doc, "/status/model", { provider: "x", modelId: "old-model" });
		doc = setAtPath(doc, "/status/thinkingLevel", "low");

		const patch = reconcile(doc, [], { model: { provider: "x", modelId: "new-model" }, thinkingLevel: "high" });
		doc = applyPatch(doc, patch!.ops);

		expect(doc.status.model).toEqual({ provider: "x", modelId: "new-model" });
		expect(doc.status.thinkingLevel).toBe("high");
	});

	it("updates leafId from pi entries", () => {
		let doc = emptyDoc();
		doc = setAtPath(doc, "/status/leafId", "old");

		const piEntries: SessionEntry[] = [
			se("message", { id: "m1", role: "user" }),
			se("message", { id: "m2", role: "assistant" }),
		];

		const patch = reconcile(doc, piEntries);
		doc = applyPatch(doc, patch!.ops);

		expect(doc.status.leafId).toBe("m2");
	});

	it("returns null when nothing changed", () => {
		const doc = emptyDoc();
		const patch = reconcile(doc, []);
		expect(patch).toBeNull();
	});

	// ADR 09 invariant 2: the canonical document holds real values —
	// reconcile must NOT strip lazy fields from discovered entries.
	it("discovered entries keep real lazy values (canonical invariant)", () => {
		let doc = emptyDoc();

		const piEntries: SessionEntry[] = [
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "t",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "deep thought" },
						{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/x" } },
					],
					api: "anthropic",
					provider: "anthropic",
					model: "claude",
					stopReason: "toolUse",
					timestamp: 0,
				},
			} as unknown as SessionEntry,
			{
				type: "message",
				id: "tr1",
				parentId: "a1",
				timestamp: "t",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					details: { lines: 3 },
					isError: false,
					timestamp: 0,
				},
			} as unknown as SessionEntry,
		];

		const patch = reconcile(doc, piEntries);
		doc = applyPatch(doc, patch!.ops);

		const a1 = lo(doc.entries.a1);
		expect(a1.content[0].thinking).toBe("deep thought");
		expect(a1.content[1].arguments).toEqual({ path: "/x" });

		const tr1 = lo(doc.entries.tr1);
		expect(tr1.content).toEqual([{ type: "text", text: "file contents" }]);
		expect(tr1.details).toEqual({ lines: 3 });
	});

	// ADR 09 invariant 4: wire `null` has exactly one meaning ("not pulled") —
	// genuinely-absent values are normalized at projection (details → {},
	// redacted thinking → "").
	it("normalizes genuinely-absent lazy values at projection", () => {
		const piEntries: SessionEntry[] = [
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "t",
				message: {
					role: "assistant",
					content: [{ type: "thinking", redacted: true }],
					api: "anthropic",
					provider: "anthropic",
					model: "claude",
					stopReason: "stop",
					timestamp: 0,
				},
			} as unknown as SessionEntry,
			{
				type: "message",
				id: "tr1",
				parentId: "a1",
				timestamp: "t",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "read",
					content: [],
					isError: false,
					timestamp: 0,
				},
			} as unknown as SessionEntry,
		];

		const doc = initFromEntries(piEntries);

		// Redacted thinking with no text → "" (not null)
		expect(lo(doc.entries.a1).content[0].thinking).toBe("");
		// Absent tool result details → {} (not null)
		expect(lo(doc.entries.tr1).details).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// filterPatchForSocket
// ---------------------------------------------------------------------------

describe("filterPatchForSocket", () => {
	it("passes through non-lazy ops", () => {
		const ops: PatchOp[] = [
			{ op: "replace", path: "/status/isStreaming", value: true },
			{ op: "add", path: "/entries/e1", value: {} },
			{ op: "move", from: "/entries/old", path: "/entries/new" },
		];
		const filtered = filterPatchForSocket(ops, new Set());
		expect(filtered).toEqual(ops);
	});

	it("drops lazy-field ops when not subscribed (text is non-lazy, always passes)", () => {
		const ops: PatchOp[] = [
			{ op: "append", path: "/entries/e1/content/0/thinking", value: "hmm" },
			{ op: "replace", path: "/entries/e1/content/2/arguments", value: "{}" },
			{ op: "replace", path: "/entries/e2/content", value: [] },
			{ op: "replace", path: "/entries/e2/details", value: {} },
		];
		const filtered = filterPatchForSocket(ops, new Set());
		expect(filtered).toEqual([]);
	});

	it("passes lazy-field ops that have exact subscriptions", () => {
		const ops: PatchOp[] = [
			{ op: "append", path: "/entries/e1/content/0/thinking", value: "hmm" },
			{ op: "replace", path: "/entries/e2/details", value: {} },
		];
		const subs = new Set(["/entries/e1/content/0/thinking", "/entries/e2/details"]);
		const filtered = filterPatchForSocket(ops, subs);
		expect(filtered).toEqual(ops);
	});

	it("passes lazy-field ops covered by parent subscription (entry content)", () => {
		const ops: PatchOp[] = [
			{ op: "append", path: "/entries/e1/content/0/thinking", value: "hm" },
			{ op: "replace", path: "/entries/e1/content/1/thinking", value: "hmm" },
		];
		// Subscribed to the parent path /entries/e1/content
		const subs = new Set(["/entries/e1/content"]);
		const filtered = filterPatchForSocket(ops, subs);
		expect(filtered).toEqual(ops);
	});

	it("handles move ops on lazy paths correctly", () => {
		const ops: PatchOp[] = [{ op: "move", from: "/entries/pending:msg/content", path: "/entries/real-msg/content" }];
		const subs = new Set(["/entries/pending:msg/content"]);
		const filtered = filterPatchForSocket(ops, subs);
		expect(filtered).toEqual(ops);
	});
});

// ---------------------------------------------------------------------------
// snapshotForWire
// ---------------------------------------------------------------------------

describe("snapshotForWire", () => {
	it("strips lazy content fields (thinking, arguments) but not text", () => {
		const doc = emptyDoc();
		doc.entries.e1 = {
			kind: "message",
			role: "assistant",
			id: "e1",
			parentId: "p1",
			timestamp: "t",
			content: [
				{ type: "text", text: "visible text" },
				{ type: "thinking", thinking: "secret reasoning" },
				{ type: "toolCall", id: "tc1", name: "read", arguments: '{"path":"/x"}' },
			],
		};

		const snapshot = snapshotForWire(doc);
		const content = (snapshot.entries.e1 as { content: Content[] }).content;
		expect(content[0].type).toBe("text");
		expect((content[0] as { text: string }).text).toBe("visible text");
		expect(content[1].type).toBe("thinking");
		expect((content[1] as { thinking: string | null }).thinking).toBeNull();
		expect(content[2].type).toBe("toolCall");
		expect((content[2] as { arguments: string | null }).arguments).toBeNull();
	});

	it("preserves non-lazy fields in content blocks", () => {
		const doc = emptyDoc();
		doc.entries.e1 = {
			kind: "message",
			role: "assistant",
			id: "e1",
			parentId: "p1",
			timestamp: "t",
			content: [
				{ type: "text", text: "x", textSignature: "sig1" },
				{ type: "thinking", thinking: "y", thinkingSignature: "sig2", redacted: true },
				{ type: "toolCall", id: "tc1", name: "read", arguments: "{}", thoughtSignature: "sig3" },
			],
		};

		const snapshot = snapshotForWire(doc);
		const c = (snapshot.entries.e1 as { content: Content[] }).content;
		expect((c[0] as { textSignature?: string }).textSignature).toBe("sig1");
		expect((c[1] as { thinkingSignature?: string }).thinkingSignature).toBe("sig2");
		expect((c[1] as { redacted?: boolean }).redacted).toBe(true);
		expect((c[2] as { id: string }).id).toBe("tc1");
		expect((c[2] as { thoughtSignature?: string }).thoughtSignature).toBe("sig3");
	});

	it("strips tool result content and details", () => {
		const doc = emptyDoc();
		doc.entries.e1 = {
			kind: "tool_result",
			id: "e1",
			parentId: "p1",
			timestamp: "t",
			toolCallId: "tc1",
			toolName: "read",
			content: [{ type: "text", text: "output" }],
			details: { lines: 10 },
			isError: false,
		};

		const snapshot = snapshotForWire(doc);
		const entry = snapshot.entries.e1 as Extract<Entry, { kind: "tool_result" }>;
		expect(entry.content).toBeNull();
		expect(entry.details).toBeNull();
	});

	it("preserves non-lazy entry fields", () => {
		const doc = emptyDoc();
		doc.entries.e1 = {
			kind: "message",
			role: "assistant",
			id: "e1",
			parentId: "p1",
			timestamp: "t",
			api: "anthropic",
			provider: "anthropic",
			model: "claude",
			stopReason: "stop",
			content: [],
		};

		const snapshot = snapshotForWire(doc);
		const entry = snapshot.entries.e1 as Extract<Entry, { kind: "message" }>;
		expect(entry.id).toBe("e1");
		expect(entry.api).toBe("anthropic");
		expect(entry.stopReason).toBe("stop");
	});

	it("preserves status unchanged", () => {
		const doc = emptyDoc();
		doc.status.leafId = "e1";
		doc.status.isStreaming = true;
		const snapshot = snapshotForWire(doc);
		expect(snapshot.status.leafId).toBe("e1");
		expect(snapshot.status.isStreaming).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// applyPatch — edge cases
// ---------------------------------------------------------------------------

describe("applyPatch (edge cases)", () => {
	it("append to non-existing string initializes to the value", () => {
		let doc = emptyDoc();
		doc = applyPatch(doc, [{ op: "append", path: "/status/name", value: "claude" }]);
		expect(doc.status.name).toBe("claude");
	});

	it("append to existing string concatenates", () => {
		let doc = emptyDoc();
		doc = setAtPath(doc, "/status/name", "claude-");
		doc = applyPatch(doc, [{ op: "append", path: "/status/name", value: "opus" }]);
		expect(doc.status.name).toBe("claude-opus");
	});

	it("remove on array index shifts elements", () => {
		let doc = emptyDoc();
		doc = setAtPath(doc, "/entries/e1", {
			kind: "message",
			role: "user",
			id: "e1",
			parentId: null,
			timestamp: "",
			content: [
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
				{ type: "text", text: "c" },
			],
		});
		doc = applyPatch(doc, [{ op: "remove", path: "/entries/e1/content/1" }]);
		expect(lo(doc.entries.e1).content.length).toBe(2);
		expect((lo(doc.entries.e1).content[0] as { text: string }).text).toBe("a");
		expect((lo(doc.entries.e1).content[1] as { text: string }).text).toBe("c");
	});

	it("add at nested path creates intermediate objects", () => {
		let doc = emptyDoc();
		doc = applyPatch(doc, [{ op: "add", path: "/entries/e1/content/0/text", value: "nested" }]);
		expect(doc.entries.e1).toBeDefined();
		expect((doc.entries.e1 as { content?: unknown[] }).content).toBeDefined();
	});

	it("move preserves value at new path", () => {
		let doc = emptyDoc();
		doc = applyPatch(doc, [
			{
				op: "add",
				path: "/entries/e1",
				value: { kind: "message", id: "e1", parentId: null, timestamp: "", content: [], role: "user" },
			},
		]);
		doc = applyPatch(doc, [{ op: "move", from: "/entries/e1", path: "/entries/e2" }]);
		expect(doc.entries.e1).toBeUndefined();
		expect(doc.entries.e2).toBeDefined();
		expect(doc.entries.e2.id).toBe("e1"); // id field wasn't updated
	});

	it("replace on non-existing path creates it", () => {
		let doc = emptyDoc();
		doc = applyPatch(doc, [{ op: "replace", path: "/status/model", value: { provider: "openai", modelId: "gpt4" } }]);
		expect(doc.status.model).toEqual({ provider: "openai", modelId: "gpt4" });
	});
});

// ---------------------------------------------------------------------------
// applyPatch — immutability contract (ADR 08)
// ---------------------------------------------------------------------------

describe("applyPatch (ADR 08 immutability)", () => {
	it("returns a new root reference on any change", () => {
		let doc = emptyDoc();
		doc = setAtPath(doc, "/entries/a", {
			kind: "message",
			role: "user",
			id: "a",
			parentId: null,
			timestamp: "t",
			content: [{ type: "text", text: "hello" }],
		});
		doc = setAtPath(doc, "/entries/b", {
			kind: "message",
			role: "assistant",
			id: "b",
			parentId: null,
			timestamp: "t",
			content: [{ type: "text", text: "world" }],
		});

		const oldRoot = doc;
		const newRoot = applyPatch(doc, [{ op: "append", path: "/entries/a/content/0/text", value: "!" }]);

		// Root is a new reference
		expect(newRoot).not.toBe(oldRoot);
		// Touched entry is a new reference
		expect(newRoot.entries.a).not.toBe(oldRoot.entries.a);
		// Untouched entry keeps its reference
		expect(newRoot.entries.b).toBe(oldRoot.entries.b);
		// Untouched status keeps its reference
		expect(newRoot.status).toBe(oldRoot.status);
		// Old root is untouched
		expect((oldRoot.entries.a as { content: { text: string }[] }).content[0].text).toBe("hello");
		// New root has the append applied
		expect((newRoot.entries.a as { content: { text: string }[] }).content[0].text).toBe("hello!");
	});

	it("structural sharing: entries object is a new reference but other untouched entries are stable", () => {
		let doc = emptyDoc();
		doc = setAtPath(doc, "/entries/a", {
			kind: "message",
			role: "user",
			id: "a",
			parentId: null,
			timestamp: "t",
			content: [],
		});
		doc = setAtPath(doc, "/entries/b", {
			kind: "message",
			role: "assistant",
			id: "b",
			parentId: null,
			timestamp: "t",
			content: [],
		});
		doc = setAtPath(doc, "/entries/c", {
			kind: "custom",
			id: "c",
			parentId: null,
			timestamp: "t",
			customType: "x",
			data: null,
		});

		const oldRoot = doc;
		const newRoot = applyPatch(doc, [{ op: "replace", path: "/status/thinkingLevel", value: "high" }]);

		// entries is a new object (ancestor of /status)
		expect(newRoot.entries).toBe(oldRoot.entries);
		// status is a new object (the touched path)
		expect(newRoot.status).not.toBe(oldRoot.status);
		// All entry references are stable
		expect(newRoot.entries.a).toBe(oldRoot.entries.a);
		expect(newRoot.entries.b).toBe(oldRoot.entries.b);
		expect(newRoot.entries.c).toBe(oldRoot.entries.c);
	});

	it("empty ops return same root", () => {
		const doc = emptyDoc();
		const result = applyPatch(doc, []);
		expect(result).toBe(doc);
	});

	it("no half-applied Patch: thrown op leaves pre-Patch root untouched", () => {
		const doc = emptyDoc();
		expect(() => {
			// Attempt to replace a field on a non-existent entry — auto-creation works,
			// so we need an op that actually throws. Use an invalid op type.
			applyPatch(doc, [
				{ op: "replace", path: "/status/thinkingLevel", value: "high" },
				// @ts-expect-error: intentional invalid op to test error path
				{ op: "nonexistent" as const, path: "/x" },
			]);
		}).toThrow();
		// doc is untouched — rollback to pre-Patch state
		expect(doc.status.thinkingLevel).toBe("off");
	});
});

// ---------------------------------------------------------------------------
// resolveFieldPath
// ---------------------------------------------------------------------------

describe("resolveFieldPath", () => {
	it("resolves a simple text field path", () => {
		const entry = { kind: "message", content: [{ type: "text", text: "hello" }] };
		expect(resolveFieldPath(entry, "/entries/e1/content/0/text")).toBe("hello");
	});

	it("resolves nested content array elements", () => {
		const entry = {
			kind: "message",
			content: [
				{ type: "text", text: "a" },
				{ type: "thinking", thinking: "hmm" },
			],
		};
		expect(resolveFieldPath(entry, "/entries/e1/content/1/thinking")).toBe("hmm");
	});

	it("returns undefined for too-short path", () => {
		expect(resolveFieldPath({}, "/entries/e1")).toBeUndefined();
	});

	it("returns undefined for array index out of bounds", () => {
		const entry = { content: [{ type: "text", text: "a" }] };
		expect(resolveFieldPath(entry, "/entries/e1/content/5/text")).toBeUndefined();
	});

	it("returns undefined for non-numeric array index", () => {
		const entry = { content: [{ type: "text", text: "a" }] };
		expect(resolveFieldPath(entry, "/entries/e1/content/abc/text")).toBeUndefined();
	});

	it("returns undefined when intermediate value is primitive", () => {
		const entry = { content: "string" };
		expect(resolveFieldPath(entry, "/entries/e1/content/0/text")).toBeUndefined();
	});
});

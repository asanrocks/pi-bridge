/**
 * Integration tests for logic paths: user-ordinal matching via applyEvent+reconcile,
 * and filterPatchForSocket via realistic op sequences.
 */

import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	applyEvent,
	applyPatch,
	type Document,
	filterPatchForSocket,
	isLazyFieldPath,
	type PatchOp,
	reconcile,
} from "../../src/core/index.ts";

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

describe("user ordinal matching (production applyEvent + reconcile)", () => {
	it("sequential ordinals for concurrent steered user messages", () => {
		let doc = emptyDoc();

		doc = applyPatch(
			doc,
			applyEvent(doc, {
				type: "message_start",
				message: { role: "user", content: "msg 1", timestamp: 0 },
			} as unknown as AgentSessionEvent)!.ops,
		);
		doc = applyPatch(
			doc,
			applyEvent(doc, {
				type: "message_start",
				message: { role: "user", content: "msg 2", timestamp: 0 },
			} as unknown as AgentSessionEvent)!.ops,
		);
		doc = applyPatch(
			doc,
			applyEvent(doc, {
				type: "message_end",
				message: { role: "user", content: "msg 1", timestamp: 0 },
			} as unknown as AgentSessionEvent)!.ops,
		);
		doc = applyPatch(
			doc,
			applyEvent(doc, {
				type: "message_end",
				message: { role: "user", content: "msg 2", timestamp: 0 },
			} as unknown as AgentSessionEvent)!.ops,
		);

		expect(doc.entries["pending:user:1"]).toBeDefined();
		expect(doc.entries["pending:user:2"]).toBeDefined();

		const piEntries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "t",
				message: { role: "user", content: "msg 1", timestamp: 0 },
			} as SessionEntry,
			{
				type: "message",
				id: "u2",
				parentId: null,
				timestamp: "t",
				message: { role: "user", content: "msg 2", timestamp: 0 },
			} as SessionEntry,
		];
		doc = applyPatch(doc, reconcile(doc, piEntries)!.ops);

		expect(doc.entries["pending:user:1"]).toBeUndefined();
		expect(doc.entries["pending:user:2"]).toBeUndefined();
		expect(doc.entries.u1).toBeDefined();
		expect(doc.entries.u2).toBeDefined();
	});

	it("ordinals reset between turns", () => {
		let doc = emptyDoc();

		doc = applyPatch(
			doc,
			applyEvent(doc, {
				type: "message_start",
				message: { role: "user", content: "t1-1", timestamp: 0 },
			} as unknown as AgentSessionEvent)!.ops,
		);
		doc = applyPatch(
			doc,
			applyEvent(doc, {
				type: "message_start",
				message: { role: "user", content: "t1-2", timestamp: 0 },
			} as unknown as AgentSessionEvent)!.ops,
		);

		const t1Entries: SessionEntry[] = [
			{
				type: "message",
				id: "t1-u1",
				parentId: null,
				timestamp: "t",
				message: { role: "user", content: "t1-1", timestamp: 0 },
			} as SessionEntry,
			{
				type: "message",
				id: "t1-u2",
				parentId: null,
				timestamp: "t",
				message: { role: "user", content: "t1-2", timestamp: 0 },
			} as SessionEntry,
		];
		doc = applyPatch(doc, reconcile(doc, t1Entries)!.ops);
		expect(doc.entries["pending:user:1"]).toBeUndefined();
		expect(doc.entries["pending:user:2"]).toBeUndefined();

		// Turn 2: ordinal resets
		doc = applyPatch(
			doc,
			applyEvent(doc, {
				type: "message_start",
				message: { role: "user", content: "t2-1", timestamp: 0 },
			} as unknown as AgentSessionEvent)!.ops,
		);
		expect(doc.entries["pending:user:1"]).toBeDefined();
		expect(doc.entries["pending:user:2"]).toBeUndefined();
	});
});

describe("filterPatchForSocket (realistic op sequences)", () => {
	it("drops all lazy ops with empty subscriptions", () => {
		const ops = [
			{ op: "add" as const, path: "/entries/pending:message/content/0", value: {} },
			{ op: "append" as const, path: "/entries/pending:message/content/0/text", value: "hello" },
			{ op: "replace" as const, path: "/entries/pending:message/content/1/thinking", value: "hmm" },
			{ op: "replace" as const, path: "/entries/pending:tc-x/content", value: [] },
			{ op: "replace" as const, path: "/entries/pending:tc-x/details", value: {} },
			{ op: "replace" as const, path: "/status/isStreaming", value: true },
			{ op: "add" as const, path: "/entries/e1", value: {} },
		];

		const filtered = filterPatchForSocket(ops, new Set());
		expect(filtered.some((o) => o.path === "/status/isStreaming")).toBe(true);
		expect(filtered.some((o) => o.path === "/entries/e1")).toBe(true);

		const lazyOps = filtered.filter((o) => isLazyFieldPath(o.op === "move" ? o.from : o.path));
		expect(lazyOps).toEqual([]);
	});

	it("keeps lazy ops with exact-path subscriptions", () => {
		const ops = [
			{ op: "append" as const, path: "/entries/pending:message/content/0/text", value: "hello" },
			{ op: "replace" as const, path: "/entries/pending:tc-x/details", value: {} },
		];
		const subs = new Set(["/entries/pending:message/content/0/text", "/entries/pending:tc-x/details"]);
		expect(filterPatchForSocket(ops, subs)).toEqual(ops);
	});

	it("parent /content subscription covers children", () => {
		const ops = [
			{ op: "append" as const, path: "/entries/pending:message/content/0/text", value: "hello" },
			{ op: "replace" as const, path: "/entries/pending:message/content/2/thinking", value: "hmm" },
			{ op: "replace" as const, path: "/entries/pending:message/content/1/arguments", value: "{}" },
		];
		const subs = new Set(["/entries/pending:message/content"]);
		expect(filterPatchForSocket(ops, subs)).toEqual(ops);
	});

	// ADR 09: parent-path op values must not smuggle lazy content past the filter.
	it("sanitizes lazy content embedded in block-level replace values (toolcall_end shape)", () => {
		const ops = [
			{
				op: "replace" as const,
				path: "/entries/pending:message/content/1",
				value: { type: "toolCall", id: "tc1", name: "write", arguments: { path: "/x", content: "BIG" } },
			},
		];

		// Unsubscribed: op passes but arguments is nulled
		const unsub = filterPatchForSocket(ops, new Set());
		expect(unsub).toHaveLength(1);
		const unsubValue = (unsub[0] as unknown as { value: { arguments: unknown; name: string } }).value;
		expect(unsubValue.arguments).toBeNull();
		expect(unsubValue.name).toBe("write");

		// Subscribed to the arguments path: value passes intact
		const subs2 = new Set(["/entries/pending:message/content/1/arguments"]);
		const sub = filterPatchForSocket(ops, subs2);
		expect(sub).toEqual(ops);
	});

	it("sanitizes lazy content embedded in entry-root add values (reconcile/entry_appended shape)", () => {
		const messageAdd = {
			op: "add" as const,
			path: "/entries/a1",
			value: {
				kind: "message",
				id: "a1",
				parentId: null,
				timestamp: "t",
				role: "assistant",
				content: [
					{ type: "text", text: "visible" },
					{ type: "thinking", thinking: "secret" },
					{ type: "toolCall", id: "tc1", name: "read", arguments: '{"path":"/x"}' },
				],
			},
		};
		const toolResultAdd = {
			op: "add" as const,
			path: "/entries/tr1",
			value: {
				kind: "tool_result",
				id: "tr1",
				parentId: "a1",
				timestamp: "t",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: "output" }],
				details: { lines: 5 },
				isError: false,
			},
		};

		const filtered = filterPatchForSocket(
			[messageAdd, toolResultAdd] as unknown as Parameters<typeof filterPatchForSocket>[0],
			new Set(),
		);
		expect(filtered).toHaveLength(2);

		const msgValue = (filtered[0] as unknown as { value: { content: Array<Record<string, unknown>> } }).value;
		expect(msgValue.content[0].text).toBe("visible");
		expect(msgValue.content[1].thinking).toBeNull();
		expect(msgValue.content[2].arguments).toBeNull();

		const trValue = (filtered[1] as unknown as { value: { content: unknown; details: unknown; toolName: string } })
			.value;
		expect(trValue.content).toBeNull();
		expect(trValue.details).toBeNull();
		expect(trValue.toolName).toBe("read");
	});

	it("does not mutate the original op values when sanitizing", () => {
		const op = {
			op: "replace" as const,
			path: "/entries/pending:message/content/0",
			value: { type: "thinking", thinking: "secret" },
		};
		filterPatchForSocket([op], new Set());
		expect(op.value.thinking).toBe("secret");
	});

	it("filters sub-paths of lazy object fields (arguments/path)", () => {
		// A replace on /arguments/path (sub-path of lazy /arguments)
		// should be dropped for unsubscribed sockets.
		const ops: PatchOp[] = [{ op: "add", path: "/entries/pending:message/content/1/arguments/path", value: "/x" }];

		const unsub = filterPatchForSocket(ops, new Set());
		expect(unsub).toHaveLength(0);

		// Subscribed to the arguments root: sub-path passes through
		const sub = filterPatchForSocket(ops, new Set(["/entries/pending:message/content/1/arguments"]));
		expect(sub).toEqual(ops);

		// Subscribed to the exact sub-path: also passes
		const subExact = filterPatchForSocket(ops, new Set(["/entries/pending:message/content/1/arguments/path"]));
		expect(subExact).toEqual(ops);
	});

	it("filters deeply nested sub-paths of lazy object fields", () => {
		// /arguments/nested/key — two levels below the lazy root — should
		// still be filtered for unsubscribed sockets.
		const ops: PatchOp[] = [
			{ op: "replace", path: "/entries/pending:message/content/1/arguments/metadata/lines", value: 42 },
		];

		const unsub = filterPatchForSocket(ops, new Set());
		expect(unsub).toHaveLength(0);

		// Subscribed to the arguments root: sub-path passes through
		const sub = filterPatchForSocket(ops, new Set(["/entries/pending:message/content/1/arguments"]));
		expect(sub).toEqual(ops);
	});

	it("does not filter non-lazy sub-paths (thinking is a leaf)", () => {
		// /thinking has children like /thinkingSignature — those are not object-valued
		// lazy fields. They should pass through unconditionally.
		const ops: PatchOp[] = [{ op: "add", path: "/entries/pending:message/content/0/thinking/extra", value: "x" }];
		const filtered = filterPatchForSocket(ops, new Set());
		// thinking is lazy but a leaf string field — its sub-paths are not lazy
		expect(filtered).toEqual(ops);
	});
});

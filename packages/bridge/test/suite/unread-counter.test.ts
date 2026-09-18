// ============================================================================
// UnreadMessageCounter — pure counting model for the tab-title unread count.
// No React, no store — mirrors store-unit.test.ts's no-React pattern.
// ============================================================================

import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/core/types.ts";
import { UnreadMessageCounter } from "../../web/src/infra/lib/unreadCounter.ts";

function messageEntry(over: Partial<Entry> & { id?: string }): Record<string, unknown> {
	return {
		kind: "message",
		id: over.id ?? "m1",
		parentId: null,
		timestamp: "2024-01-01T00:00:00Z",
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		...over,
	};
}

function entriesDoc(entries: Record<string, unknown>): Record<string, Entry> {
	return entries as Record<string, Entry>;
}

describe("UnreadMessageCounter", () => {
	it("rebase seeds the baseline: existing history never counts", () => {
		const c = new UnreadMessageCounter();
		const doc = entriesDoc({ a1: messageEntry({ id: "a1" }), a2: messageEntry({ id: "a2" }) });
		c.switchedSession("inst-1");
		c.rebase(doc);
		expect(c.sync(doc)).toBe(0);
	});

	it("counts a newly sealed message once, then not again", () => {
		const c = new UnreadMessageCounter();
		const doc1 = entriesDoc({ a1: messageEntry({ id: "a1" }) });
		c.switchedSession("inst-1");
		c.rebase(doc1);

		const doc2 = entriesDoc({ a1: messageEntry({ id: "a1" }), a2: messageEntry({ id: "a2" }) });
		expect(c.sync(doc2)).toBe(1);
		expect(c.sync(doc2)).toBe(0); // absorbed — no double count
	});

	it("does not count the provisional streaming entry; counts it once at seal", () => {
		// The pending entry has no timestamp and a pending: id. At seal it is
		// REMOVED and a durable entry appears — the re-key must not
		// double-count.
		const c = new UnreadMessageCounter();
		c.switchedSession("inst-1");
		c.rebase(entriesDoc({}));

		const streaming = entriesDoc({
			"pending:message": messageEntry({ id: "pending:message", timestamp: "" }),
		});
		expect(c.sync(streaming)).toBe(0);

		const sealed = entriesDoc({ msg_001: messageEntry({ id: "msg_001" }) });
		expect(c.sync(sealed)).toBe(1);
		expect(c.sync(sealed)).toBe(0);
	});

	it("does not count thinking-only, tool-only, or user entries", () => {
		const c = new UnreadMessageCounter();
		c.switchedSession("inst-1");
		c.rebase(entriesDoc({}));

		const doc = entriesDoc({
			t1: {
				kind: "message",
				id: "t1",
				parentId: null,
				timestamp: "2024-01-01T00:00:00Z",
				role: "assistant",
				content: [{ type: "thinking", thinking: "hmm" }],
			},
			x1: {
				kind: "message",
				id: "x1",
				parentId: null,
				timestamp: "2024-01-01T00:00:00Z",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: null }],
			},
			u1: {
				kind: "message",
				id: "u1",
				parentId: null,
				timestamp: "2024-01-01T00:00:00Z",
				role: "user",
				content: [{ type: "text", text: "hi" }],
			},
			r1: {
				kind: "tool_result",
				id: "r1",
				parentId: null,
				timestamp: "2024-01-01T00:00:00Z",
				toolCallId: "tc1",
				toolName: "read",
				content: [],
				details: null,
				isError: false,
			},
		});
		expect(c.sync(doc)).toBe(0);
	});

	it("counts an aborted entry with text (it said something)", () => {
		const c = new UnreadMessageCounter();
		c.switchedSession("inst-1");
		c.rebase(entriesDoc({}));
		const doc = entriesDoc({
			a1: messageEntry({ id: "a1", stopReason: "aborted", errorMessage: "Operation aborted" }),
		});
		expect(c.sync(doc)).toBe(1);
	});

	it("counts messages on sibling branches (entries live document-wide)", () => {
		const c = new UnreadMessageCounter();
		c.switchedSession("inst-1");
		const doc1 = entriesDoc({ a1: messageEntry({ id: "a1" }) });
		c.rebase(doc1);

		// A fork's entry — off the active path but in the document.
		const doc2 = entriesDoc({ a1: messageEntry({ id: "a1" }), fork: messageEntry({ id: "fork" }) });
		expect(c.sync(doc2)).toBe(1);
	});

	it("switchedSession: true once per session change, false otherwise", () => {
		const c = new UnreadMessageCounter();
		// Counter starts unattached (null) — matches the hook mounting before
		// any attach, when the document is empty; no rebase needed.
		expect(c.switchedSession(null)).toBe(false);
		expect(c.switchedSession("inst-1")).toBe(true);
		expect(c.switchedSession("inst-1")).toBe(false);
		expect(c.switchedSession("inst-2")).toBe(true);
	});

	it("instance switch clears the seen baseline (new history never counts)", () => {
		const c = new UnreadMessageCounter();
		c.switchedSession("inst-1");
		c.rebase(entriesDoc({ a1: messageEntry({ id: "a1" }) }));

		// Switch instance: a fresh document with different entries.
		expect(c.switchedSession("inst-2")).toBe(true);
		const doc2 = entriesDoc({ b1: messageEntry({ id: "b1" }) });
		c.rebase(doc2);
		expect(c.sync(doc2)).toBe(0);
	});
});

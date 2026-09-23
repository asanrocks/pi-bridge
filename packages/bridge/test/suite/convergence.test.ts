/**
 * Convergence test — ADR 09 invariant 1:
 * A client initialized from snapshotForWire and one replaying the filtered
 * patch stream (empty subscriptions) must hold the same document. With a
 * subscribed path, only that path may differ.
 *
 * Uses pure core functions (applyEvent/reconcile/filterPatchForSocket) with a
 * hand-scripted event stream — the same seam Connection uses in production.
 */

import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	applyEvent,
	applyPatch,
	type Document,
	filterPatchForSocket,
	initFromEntries,
	type PatchOp,
	reconcile,
	snapshotForWire,
} from "../../src/core/index.ts";
import { deepEqual } from "./harness.ts";

// ── Fixture: one user entry, then an assistant turn with thinking + tool ──

function userEntry(): SessionEntry {
	return {
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: "read /tmp/x", timestamp: 0 },
	} as SessionEntry;
}

function assistantEntry(): SessionEntry {
	return {
		type: "message",
		id: "a1",
		parentId: "u1",
		timestamp: new Date(2000).toISOString(),
		message: {
			role: "assistant",
			api: "anthropic",
			provider: "anthropic",
			model: "faux-1",
			stopReason: "toolUse",
			content: [
				{ type: "thinking", thinking: "Let me think" },
				{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/tmp/x" } },
			],
			usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0 } },
		},
	} as unknown as SessionEntry;
}

/** Build a partial AssistantMessage for test events. */
function makePartial(content: Array<Record<string, unknown>>) {
	return {
		role: "assistant" as const,
		content,
		api: "",
		provider: "",
		model: "",
		stopReason: "" as const,
		usage: null,
		timestamp: 0,
	};
}

function turnEvents(): AgentSessionEvent[] {
	return [
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } },
		{ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
		{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Let " } },
		{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "me think" } },
		{
			type: "message_update",
			assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Let me think" },
		},
		{
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 1,
				partial: makePartial([
					{ type: "thinking", thinking: "Let me think" },
					{ type: "toolCall", id: "", name: "read", arguments: {} },
				]),
			},
		},
		{
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 1,
				delta: '{"path"',
				partial: makePartial([
					{ type: "thinking", thinking: "Let me think" },
					{ type: "toolCall", id: "", name: "read", arguments: { path: "" } },
				]),
			},
		},
		{
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 1,
				delta: ':"/tmp/x"}',
				partial: makePartial([
					{ type: "thinking", thinking: "Let me think" },
					{ type: "toolCall", id: "", name: "read", arguments: { path: "/tmp/x" } },
				]),
			},
		},
		{
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: { id: "tc1", name: "read", arguments: { path: "/tmp/x" } },
			},
		},
		{ type: "message_update", assistantMessageEvent: { type: "done" } },
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				api: "anthropic",
				provider: "anthropic",
				model: "faux-1",
				stopReason: "toolUse",
				usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0 } },
			},
		},
		{ type: "agent_settled" },
	] as unknown as AgentSessionEvent[];
}

/**
 * Drive the canonical document through the turn (applyEvent per event,
 * reconcile at settle — same order as Manager.processEvent), collecting
 * emitted patches.
 */
function driveTurn(initial: Document): { final: Document; patches: PatchOp[][] } {
	const patches: PatchOp[][] = [];
	let doc = initial;
	for (const event of turnEvents()) {
		const patch = applyEvent(doc, event);
		if (patch) {
			doc = applyPatch(doc, patch.ops);
			patches.push(patch.ops);
		}
		if ((event as { type: string }).type === "agent_settled") {
			const recPatch = reconcile(doc, [userEntry(), assistantEntry()], {
				model: { provider: "faux", modelId: "faux-1" },
				thinkingLevel: "off",
			});
			if (recPatch) {
				doc = applyPatch(doc, recPatch.ops);
				patches.push(recPatch.ops);
			}
		}
	}
	return { final: doc, patches };
}

/** Replay patch stream through the socket filter into a client document. */
function replayFiltered(initial: Document, patches: PatchOp[][], subscriptions: Set<string>): Document {
	let doc = initial;
	for (const ops of patches) {
		const filtered = filterPatchForSocket(ops, subscriptions);
		if (filtered.length > 0) doc = applyPatch(doc, filtered);
	}
	return doc;
}

/** Null all thinking fields in every entry's content (for subscribed-diff comparison). */
function nullThinking(doc: Document): Document {
	const entries: Document["entries"] = {};
	for (const [id, entry] of Object.entries(doc.entries)) {
		if ("content" in entry && Array.isArray(entry.content)) {
			entries[id] = {
				...entry,
				content: entry.content.map((b) => (b.type === "thinking" ? { ...b, thinking: null } : b)),
			};
		} else {
			entries[id] = entry;
		}
	}
	return { status: doc.status, entries };
}

/** Raw JSON round-trip (eliminates undefined vs missing) — no lazy stripping. */
function normalizeRaw(doc: Document): Document {
	return JSON.parse(JSON.stringify(doc)) as Document;
}

function assertDocsEqual(a: Document, b: Document, label: string): void {
	const normA = normalizeRaw(a);
	const normB = normalizeRaw(b);
	if (deepEqual(normA, normB)) return;

	const diffs: string[] = [];
	const allIds = new Set([...Object.keys(normA.entries), ...Object.keys(normB.entries)]);
	for (const id of allIds) {
		const ae = normA.entries[id];
		const be = normB.entries[id];
		if (!deepEqual(ae, be)) {
			diffs.push(
				`entry ${id}:\n  A: ${ae ? JSON.stringify(ae).slice(0, 300) : "missing"}\n  B: ${be ? JSON.stringify(be).slice(0, 300) : "missing"}`,
			);
		}
	}
	if (!deepEqual(normA.status, normB.status)) {
		diffs.push(`status:\n  A: ${JSON.stringify(normA.status)}\n  B: ${JSON.stringify(normB.status)}`);
	}
	throw new Error(`[${label}] documents diverged:\n${diffs.join("\n")}`);
}

describe("convergence (ADR 09 invariant 1)", () => {
	it("snapshot client equals empty-subscription replay client", () => {
		const initial = initFromEntries([userEntry()]);
		const { final, patches } = driveTurn(initial);

		const snapshotClient = snapshotForWire(final);
		const replayClient = replayFiltered(snapshotForWire(initial), patches, new Set());

		assertDocsEqual(snapshotClient, replayClient, "empty subscriptions");
	});

	it("subscribed client differs only on the subscribed path", () => {
		const initial = initFromEntries([userEntry()]);
		const { final, patches } = driveTurn(initial);

		const thinkingPath = "/entries/pending:message/content/0/thinking";
		const subscribedClient = replayFiltered(snapshotForWire(initial), patches, new Set([thinkingPath]));

		// The subscribed client received the thinking stream — value survives the seal move
		const a1 = subscribedClient.entries.a1;
		expect(a1).toBeDefined();
		if ("content" in a1 && Array.isArray(a1.content)) {
			expect((a1.content[0] as { thinking: string | null }).thinking).toBe("Let me think");
		}

		// Beyond thinking, the subscribed client matches the snapshot projection
		assertDocsEqual(snapshotForWire(final), nullThinking(subscribedClient), "subscribed, thinking nulled");
	});

	it("reconcile-discovered entries never carry lazy content into the canonical document's wire projection mismatch", () => {
		// An entry discovered by reconcile with NO provisional (e.g. after navigate):
		// the canonical document must hold real values (invariant 2), while both
		// wire paths (snapshot + filtered add op) must strip them identically.
		const initial = initFromEntries([userEntry()]);
		const recPatch = reconcile(initial, [userEntry(), assistantEntry()], {
			model: { provider: "faux", modelId: "faux-1" },
			thinkingLevel: "off",
		});
		expect(recPatch).not.toBeNull();

		const canonical = applyPatch(initial, recPatch!.ops);

		// Invariant 2: canonical holds real values
		const a1 = canonical.entries.a1;
		expect(a1).toBeDefined();
		if ("content" in a1 && Array.isArray(a1.content)) {
			expect((a1.content[0] as { thinking: string | null }).thinking).toBe("Let me think");
			expect((a1.content[1] as { arguments: unknown }).arguments).toEqual({ path: "/tmp/x" });
		}

		// Convergence: snapshot equals filtered replay of the reconcile patch
		const snapshotClient = snapshotForWire(canonical);
		const replayClient = replayFiltered(snapshotForWire(initial), [recPatch!.ops], new Set());
		assertDocsEqual(snapshotClient, replayClient, "reconcile-discovered");
	});
});

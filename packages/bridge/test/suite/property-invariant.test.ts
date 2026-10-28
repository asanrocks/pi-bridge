/**
 * Property-based tests for the bridge data model invariants (ADR 02).
 *
 * Verified invariants:
 *
 * I1. Committed entries are immutable — only unsealed live forms change.
 * I2. Domain validity after each Patch: sealed entries have id/parentId/timestamp;
 *     leafId points to an existing entry or null.
 * I3. Parent chain integrity: every child references an existing parent.
 * I4. Identity is stable: an entry keeps its id from its first event, so
 *     sealing installs content in place and never renames.
 * I5. Seal lifecycle: a persisted entry is sealed with its file position.
 * I6. Refresh idempotency: refreshing twice over the same entry list
 *     is a no-op.
 * I7. initFromEntries produces domain-valid output with no provisionals.
 * I8. Patch atomicity: all ops in a Patch are delivered together.
 */

import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	applyEvent,
	applyPatch,
	type Document,
	initFromEntries,
	isEntrySealed,
	type Patch,
	setAtPath,
} from "../../src/core/index.ts";
import { createDriver } from "./projection-driver.ts";

// ==========================================================================
// Test helpers — produce valid SessionEntry objects with all required fields
// ==========================================================================

function mkSessionEntry(overrides: Record<string, unknown>): SessionEntry {
	const base = {
		id: (overrides.id as string) ?? "e1",
		parentId: (overrides.parentId as string | null) ?? null,
		timestamp: (overrides.timestamp as string) ?? "2024-01-01T00:00:00Z",
	};

	if (overrides.type === "message" || !overrides.type) {
		const msgOverrides = (overrides.message as Record<string, unknown>) ?? overrides;
		return {
			type: "message",
			...base,
			message: {
				role: (msgOverrides.role as string) ?? "user",
				content: (msgOverrides.content as string | unknown[]) ?? "hello",
				timestamp: (msgOverrides.msgTimestamp as number) ?? 0,
				...(msgOverrides.role === "toolResult"
					? {
							toolCallId: (msgOverrides.toolCallId as string) ?? "tc1",
							toolName: (msgOverrides.toolName as string) ?? "read",
							isError: (msgOverrides.isError as boolean) ?? false,
						}
					: {}),
			},
		} as SessionEntry;
	}

	return { ...base, ...overrides } as SessionEntry;
}

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
		entries: {},
	};
}

/** True for an entry that is still a live, not-yet-persisted form. */
function isProvisional(entry: { isSealed?: boolean }): boolean {
	return entry.isSealed === false;
}

// ==========================================================================
// Deep equal
// ==========================================================================

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return a === b;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const aKeys = Object.keys(a as Record<string, unknown>);
	const bKeys = Object.keys(b as Record<string, unknown>);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!(key in (b as Record<string, unknown>))) return false;
		if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
	}
	return true;
}

// ==========================================================================
// Invariant checkers
// ==========================================================================

function checkDomainValidity(doc: Document): string[] {
	const violations: string[] = [];
	for (const [id, entry] of Object.entries(doc.entries)) {
		if (!isProvisional(entry)) {
			if (!entry.id) violations.push(`I2: ${id} missing id`);
			if (entry.parentId === undefined) {
				violations.push(`I2: ${id} missing parentId`);
			}
			if (!entry.timestamp) violations.push(`I2: ${id} empty timestamp`);
		}
		if (entry.parentId && !doc.entries[entry.parentId]) {
			violations.push(`I3: ${id} parent ${entry.parentId} not found`);
		}
	}
	if (doc.status.leafId !== null && !doc.entries[doc.status.leafId]) {
		violations.push(`I2: leafId ${doc.status.leafId} not in entries`);
	}
	return violations;
}

function checkCommittedImmutability(
	prev: Document,
	next: Document,
	patchOps: { op: string; path: string }[],
): string[] {
	const violations: string[] = [];
	for (const id of Object.keys(next.entries)) {
		if (isProvisional(next.entries[id]!)) continue;
		const pe = prev.entries[id];
		const ne = next.entries[id];
		if (pe && !deepEqual(pe, ne)) {
			const isMove = patchOps.some((o) => o.op === "move" && o.path === `/entries/${id}`);
			const isMeta = patchOps.some(
				(o) => o.path === `/entries/${id}/parentId` || o.path === `/entries/${id}/timestamp`,
			);
			if (!isMove && !isMeta) {
				violations.push(`I1: ${id} changed without rename/metadata`);
			}
		}
	}
	return violations;
}

// ==========================================================================
// Tests
// ==========================================================================

describe("property-based invariants (ADR 02)", () => {
	// ── I7: initFromEntries ────────────────────────────────────────────────

	describe("I7: initFromEntries", () => {
		it("empty session produces domain-valid document", () => {
			const doc = initFromEntries([]);
			expect(checkDomainValidity(doc)).toEqual([]);
		});

		it("no provisional ids in bootstrapped document", () => {
			const doc = initFromEntries([
				mkSessionEntry({ type: "message", id: "m1", role: "user", parentId: null }),
				mkSessionEntry({
					type: "message",
					id: "m2",
					role: "assistant",
					parentId: "m1",
					content: [{ type: "text", text: "hi" }],
				}),
			]);
			expect(Object.values(doc.entries).every((entry) => !isProvisional(entry))).toBe(true);
			expect(checkDomainValidity(doc)).toEqual([]);
		});

		it("leafId points to last entry", () => {
			const doc = initFromEntries([
				mkSessionEntry({ type: "message", id: "u1", role: "user" }),
				mkSessionEntry({ type: "message", id: "a1", role: "assistant", content: [{ type: "text", text: "ok" }] }),
				mkSessionEntry({ type: "message", id: "u2", role: "user" }),
			]);
			expect(doc.status.leafId).toBe("u2");
		});

		it("all entry types project as domain-valid", () => {
			const doc = initFromEntries([
				mkSessionEntry({ type: "message", id: "m1", role: "user" }),
				mkSessionEntry({ type: "compaction", id: "c1", summary: "s", firstKeptEntryId: "m1", tokensBefore: 10 }),
				mkSessionEntry({ type: "model_change", id: "mc1", provider: "x", modelId: "m" }),
				mkSessionEntry({ type: "thinking_level_change", id: "t1", thinkingLevel: "high" }),
			]);
			expect(checkDomainValidity(doc)).toEqual([]);
		});
	});

	// ── I6: Refresh idempotency ──────────────────────────────────────────

	describe("I6: refresh idempotency", () => {
		it("second refresh over the same list is a no-op for silent entries", () => {
			const driver = createDriver(emptyDoc());
			const piEntries: SessionEntry[] = [
				mkSessionEntry({ type: "model_change", id: "mc1", provider: "a", modelId: "c" }),
			];
			const p1 = driver.refresh(piEntries);
			expect(p1).not.toBeNull();

			const p2 = driver.refresh(piEntries);
			expect(p2).toBeNull();
		});

		it("second refresh is a no-op after sealing in place", () => {
			const driver = createDriver(emptyDoc());
			driver.applyEvent({
				type: "message_start",
				entryId: "real-1",
				message: {
					role: "assistant",
					content: [],
					api: "x",
					provider: "x",
					model: "x",
					stopReason: null,
					usage: null,
					timestamp: 0,
				},
			} as unknown as AgentSessionEvent);

			const piEntries: SessionEntry[] = [
				mkSessionEntry({
					type: "message",
					id: "real-1",
					role: "assistant",
					parentId: "parent1",
					timestamp: "t",
					content: [],
				}),
			];
			const p1 = driver.refresh(piEntries);
			expect(p1).not.toBeNull();

			const p2 = driver.refresh(piEntries);
			expect(p2).toBeNull();
		});
	});

	// ── I1: Committed immutability ─────────────────────────────────────────

	describe("I1: committed immutability", () => {
		it("committed entries never change between patches", () => {
			let doc = emptyDoc();
			doc = applyPatch(doc, [
				{
					op: "add",
					path: "/entries/e1",
					value: { kind: "message", role: "user", id: "e1", parentId: "p1", timestamp: "t", content: [] },
				},
			]);
			const prev = structuredClone(doc);

			// Add a new entry — e1 should be unchanged
			doc = applyPatch(doc, [
				{
					op: "add",
					path: "/entries/e2",
					value: { kind: "message", role: "assistant", id: "e2", parentId: "p1", timestamp: "t2", content: [] },
				},
			]);

			expect(checkCommittedImmutability(prev as Document, doc, [])).toEqual([]);
		});

		it("committed entry mutation is detected", () => {
			let doc = emptyDoc();
			doc = applyPatch(doc, [
				{
					op: "add",
					path: "/entries/e1",
					value: { kind: "message", role: "user", id: "e1", parentId: "p1", timestamp: "t", content: [] },
				},
			]);
			const prev = structuredClone(doc);

			// Mutate e1
			doc = applyPatch(doc, [{ op: "replace", path: "/entries/e1/role", value: "assistant" }]);

			const v = checkCommittedImmutability(prev as Document, doc, [
				{
					op: "replace",
					path: "/entries/e1/role",
				},
			]);
			expect(v.length).toBeGreaterThan(0);
			expect(v[0]).toContain("e1 changed");
		});

		it("rename via move is allowed", () => {
			let doc2 = emptyDoc();
			doc2 = applyPatch(doc2, [
				{
					op: "add",
					path: "/entries/e1",
					value: { kind: "message", role: "user", id: "e1", parentId: null, timestamp: "t", content: [] },
				},
			]);
			const prev = structuredClone(doc2);

			// Move is allowed
			doc2 = applyPatch(doc2, [{ op: "move", from: "/entries/e1", path: "/entries/e1-renamed" }]);

			const v = checkCommittedImmutability(prev as Document, doc2, [
				{
					op: "move",
					from: "/entries/e1",
					path: "/entries/e1-renamed",
				} as { op: string; path: string },
			]);
			expect(v).toEqual([]);
		});

		// ADR 08: reference-identity invariants
		it("applyPatch returns new root reference on non-empty ops", () => {
			let doc = emptyDoc();
			doc = setAtPath(doc, "/entries/e1", {
				kind: "message",
				role: "user",
				id: "e1",
				parentId: null,
				timestamp: "t",
				content: [],
			});
			const oldRoot = doc;
			doc = applyPatch(doc, [
				{
					op: "add",
					path: "/entries/e2",
					value: { kind: "message", role: "assistant", id: "e2", parentId: "e1", timestamp: "t2", content: [] },
				},
			]);
			expect(doc).not.toBe(oldRoot);
			expect(doc.entries.e1).toBe(oldRoot.entries.e1);
		});

		it("untouched entries are referentially stable across touched-path Patch", () => {
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
				kind: "custom",
				id: "b",
				parentId: null,
				timestamp: "t",
				customType: "x",
				data: null,
			});
			const oldRoot = doc;
			doc = applyPatch(doc, [{ op: "replace", path: "/status/name", value: "renamed" }]);
			expect(doc).not.toBe(oldRoot);
			expect(doc.status).not.toBe(oldRoot.status);
			expect(doc.entries).toBe(oldRoot.entries);
			expect(doc.entries.a).toBe(oldRoot.entries.a);
			expect(doc.entries.b).toBe(oldRoot.entries.b);
		});
	});

	// ── I5: Ordinal correctness ────────────────────────────────────────────

	describe("I5: identity and seal lifecycle", () => {
		it("each live message keeps the id it started under", () => {
			let doc = emptyDoc();

			const ev = (id: string, role: string, text: string) =>
				({
					type: "message_start",
					entryId: id,
					message: { role, content: text, timestamp: 0 },
				}) as unknown as AgentSessionEvent;

			doc = applyPatch(doc, applyEvent(doc, ev("u1", "user", "a"))!.ops);
			doc = applyPatch(doc, applyEvent(doc, ev("u2", "user", "b"))!.ops);

			expect(doc.entries.u1).toBeDefined();
			expect(doc.entries.u2).toBeDefined();
			// No synthetic ordinal names: the id is the identity.
			expect(Object.keys(doc.entries).sort()).toEqual(["u1", "u2"]);
		});

		it("sealing installs the entry and its file position", () => {
			const driver = createDriver(emptyDoc());

			const ev = (id: string, role: string, text: string) =>
				({
					type: "message_start",
					entryId: id,
					message: { role, content: text, timestamp: 0 },
				}) as unknown as AgentSessionEvent;

			driver.applyEvent(ev("u1", "user", "a"));
			driver.applyEvent(ev("u2", "user", "b"));

			const piEntries: SessionEntry[] = [
				mkSessionEntry({ type: "message", id: "u1", role: "user", parentId: null }),
				mkSessionEntry({ type: "message", id: "u2", role: "user", parentId: null }),
			];
			driver.refresh(piEntries);
			const doc = driver.document;

			expect(isEntrySealed(doc.entries.u1!)).toBe(true);
			expect(isEntrySealed(doc.entries.u2!)).toBe(true);
			expect(doc.entries.u1?.ord).toBe(0);
			expect(doc.entries.u2?.ord).toBe(1);

			// A later live form is independent of the sealed pair.
			driver.applyEvent(ev("u3", "user", "c"));
			expect(isEntrySealed(driver.document.entries.u3!)).toBe(false);
			expect(driver.document.entries.u3?.ord).toBeUndefined();
		});
	});

	// ── I3: Parent chain ───────────────────────────────────────────────────

	describe("I3: parent chain integrity", () => {
		it("valid parent chain passes check", () => {
			const driver = createDriver(emptyDoc());
			driver.refresh([mkSessionEntry({ type: "message", id: "parent1", role: "user", parentId: null })]);
			driver.applyEvent({
				type: "message_start",
				entryId: "child1",
				message: {
					role: "assistant",
					content: [],
					api: "x",
					provider: "x",
					model: "x",
					stopReason: null,
					usage: null,
					timestamp: 0,
				},
			} as unknown as AgentSessionEvent);

			const piEntries: SessionEntry[] = [
				mkSessionEntry({ type: "message", id: "parent1", role: "user", parentId: null }),
				mkSessionEntry({
					type: "message",
					id: "child1",
					role: "assistant",
					parentId: "parent1",
					timestamp: "t",
					content: [],
				}),
			];
			driver.refresh(piEntries);
			expect(checkDomainValidity(driver.document)).toEqual([]);
		});

		it("broken parent chain is detected", () => {
			const driver = createDriver(emptyDoc());

			const piEntries: SessionEntry[] = [
				mkSessionEntry({
					type: "message",
					id: "rm",
					role: "assistant",
					parentId: "nonexistent",
					timestamp: "t",
					content: [],
				}),
			];
			driver.refresh(piEntries);
			const v = checkDomainValidity(driver.document);
			expect(v.length).toBeGreaterThan(0);
			expect(v[0]).toContain("parent");
		});
	});

	// ── I8: Patch atomicity ────────────────────────────────────────────────

	describe("I8: patch atomicity", () => {
		it("one refresh seals multiple entries in one Patch", () => {
			const driver = createDriver(emptyDoc());
			driver.applyEvent({
				type: "message_start",
				entryId: "a1",
				message: {
					role: "assistant",
					content: [],
					api: "x",
					provider: "x",
					model: "x",
					stopReason: null,
					usage: null,
					timestamp: 0,
				},
			} as unknown as AgentSessionEvent);
			driver.applyEvent({
				type: "tool_execution_start",
				entryId: "tr1",
				toolCallId: "tc-x",
				toolName: "r",
				args: {},
			} as AgentSessionEvent);

			const piEntries: SessionEntry[] = [
				mkSessionEntry({
					type: "message",
					id: "a1",
					role: "assistant",
					parentId: "p1",
					timestamp: "t",
					content: [],
				}),
				mkSessionEntry({
					type: "message",
					id: "tr1",
					role: "toolResult",
					parentId: "p1",
					timestamp: "t",
					toolCallId: "tc-x",
					toolName: "r",
					isError: false,
					content: [],
				}),
			];
			const patch = driver.refresh(piEntries);
			expect(patch).not.toBeNull();
			// One patch installs both persisted forms, and neither is a rename.
			expect(patch!.ops.some((o) => o.op === "move")).toBe(false);
			const installed = patch!.ops.filter((o) => o.op === "add" && /^\/entries\/[^/]+$/.test(o.path));
			expect(installed.length).toBe(2);
		});
	});

	// ── I9: Root reference flips on every change (ADR 08 §4) ───────────────

	describe("I9: root reference flips on every change", () => {
		it("applyPatch with non-empty ops returns a new root", () => {
			let doc = emptyDoc();
			doc = setAtPath(doc, "/entries/a", {
				kind: "message",
				role: "user",
				id: "a",
				parentId: null,
				timestamp: "t",
				content: [],
			});
			const prev = doc;
			doc = applyPatch(doc, [{ op: "replace", path: "/status/name", value: "x" }]);
			expect(doc).not.toBe(prev);
		});

		it("applyPatch with empty ops returns the same root", () => {
			const doc = emptyDoc();
			const result = applyPatch(doc, []);
			expect(result).toBe(doc);
		});

		it("applyEvent returns null for no-op events — no root change needed", () => {
			const doc = emptyDoc();
			const patch = applyEvent(doc, { type: "turn_end" } as AgentSessionEvent);
			expect(patch).toBeNull();
		});

		it("every Patch in a streaming turn produces a distinct root", () => {
			let doc = emptyDoc();
			const roots: Document[] = [doc];

			// Simulate a streaming assistant message
			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_start",
					entryId: "a1",
					message: {
						role: "assistant",
						content: [],
						api: "a",
						provider: "a",
						model: "a",
						stopReason: "",
						usage: null,
						timestamp: 0,
					},
				} as unknown as AgentSessionEvent)!.ops,
			);
			roots.push(doc);

			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_update",
					entryId: "a1",
					assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} },
				} as unknown as AgentSessionEvent)!.ops,
			);
			roots.push(doc);

			doc = applyPatch(
				doc,
				applyEvent(doc, {
					type: "message_update",
					entryId: "a1",
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: {} },
				} as unknown as AgentSessionEvent)!.ops,
			);
			roots.push(doc);

			// Each Patch produced a new root
			for (let i = 1; i < roots.length; i++) {
				expect(roots[i]).not.toBe(roots[i - 1]);
			}
		});
	});

	// ── I10: Structural sharing (ADR 08 §5) ────────────────────────────────

	describe("I10: structural sharing", () => {
		it("append on one entry does not change sibling entry references", () => {
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
				kind: "custom",
				id: "b",
				parentId: null,
				timestamp: "t",
				customType: "x",
				data: null,
			});

			const oldA = doc.entries.a;
			const oldB = doc.entries.b;
			const oldStatus = doc.status;

			doc = applyPatch(doc, [{ op: "append", path: "/entries/a/content/0/text", value: "!" }]);

			// a is touched — new reference
			expect(doc.entries.a).not.toBe(oldA);
			// b is untouched — same reference
			expect(doc.entries.b).toBe(oldB);
			// status untouched — same reference
			expect(doc.status).toBe(oldStatus);
		});

		it("status-only change keeps all entry references stable", () => {
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

			const oldA = doc.entries.a;
			const oldB = doc.entries.b;
			const oldEntries = doc.entries;

			doc = applyPatch(doc, [{ op: "replace", path: "/status/isStreaming", value: true }]);

			expect(doc.entries).toBe(oldEntries);
			expect(doc.entries.a).toBe(oldA);
			expect(doc.entries.b).toBe(oldB);
		});

		it("add to content array shares other content block references", () => {
			let doc = emptyDoc();
			doc = setAtPath(doc, "/entries/a", {
				kind: "message",
				role: "assistant",
				id: "a",
				parentId: null,
				timestamp: "t",
				content: [
					{ type: "text", text: "first" },
					{ type: "thinking", thinking: "hmm" },
				],
			});

			const oldContent = (doc.entries.a as { content: unknown[] }).content;
			const oldBlock0 = oldContent[0];
			const oldBlock1 = oldContent[1];

			// Add a third content block
			doc = applyPatch(doc, [{ op: "add", path: "/entries/a/content/2", value: { type: "text", text: "third" } }]);

			const newContent = (doc.entries.a as { content: unknown[] }).content;
			expect(newContent).not.toBe(oldContent); // array is new
			expect(newContent[0]).toBe(oldBlock0); // untouched block shared
			expect(newContent[1]).toBe(oldBlock1); // untouched block shared
			expect(newContent.length).toBe(3);
		});
	});

	// ── I1-I5: Fuzzing ─────────────────────────────────────────────────────

	describe("I1-I5: fuzzing", () => {
		// Every lifecycle event carries the id pi reserved for the entry, so the
		// harness mirrors what a producer does rather than inventing names.
		function makeMsgEv(role: string, text: string, entryId: string): AgentSessionEvent {
			return {
				type: "message_start",
				entryId,
				message: { role, content: text, timestamp: 0 },
			} as unknown as AgentSessionEvent;
		}
		function makeMsgEnd(
			role: string,
			text: string,
			entryId: string,
			extra?: Record<string, unknown>,
		): AgentSessionEvent {
			const base: Record<string, unknown> = {
				role,
				content: role === "assistant" ? [{ type: "text", text }] : text,
				timestamp: 0,
			};
			if (extra) Object.assign(base, extra);
			return { type: "message_end", entryId, message: base } as unknown as AgentSessionEvent;
		}
		function makeToolStart(tcId: string, name: string, entryId: string): AgentSessionEvent {
			return {
				type: "tool_execution_start",
				entryId,
				toolCallId: tcId,
				toolName: name,
				args: {},
			} as AgentSessionEvent;
		}
		function makeToolEnd(tcId: string, name: string, isErr: boolean, entryId: string): AgentSessionEvent {
			return {
				type: "tool_execution_end",
				entryId,
				toolCallId: tcId,
				toolName: name,
				result: { content: [{ type: "text", text: `out-${tcId}` }], details: {} },
				isError: isErr,
			} as AgentSessionEvent;
		}
		function makeUpdate(type: string, ci: number, val: unknown, entryId: string): AgentSessionEvent {
			const base = {
				type,
				contentIndex: ci,
				partial: {
					role: "assistant",
					content: [],
					api: "",
					provider: "",
					model: "",
					stopReason: "",
					usage: null,
					timestamp: 0,
				},
			};
			if (type.endsWith("_start")) {
				return { type: "message_update", entryId, assistantMessageEvent: base } as unknown as AgentSessionEvent;
			}
			if (type.endsWith("_delta")) {
				return {
					type: "message_update",
					entryId,
					assistantMessageEvent: { ...base, delta: val },
				} as unknown as AgentSessionEvent;
			}
			if (type.endsWith("_end") && type.startsWith("text")) {
				return {
					type: "message_update",
					entryId,
					assistantMessageEvent: { ...base, content: val },
				} as unknown as AgentSessionEvent;
			}
			if (type.endsWith("_end") && type.startsWith("toolcall")) {
				return {
					type: "message_update",
					entryId,
					assistantMessageEvent: { ...base, toolCall: val },
				} as unknown as AgentSessionEvent;
			}
			return {
				type: "message_update",
				entryId,
				assistantMessageEvent: { ...base, thinking: val, content: val },
			} as unknown as AgentSessionEvent;
		}

		for (let seed = 0; seed < 30; seed++) {
			it(`seed ${seed} — invariants hold through random turn`, () => {
				const driver = createDriver(emptyDoc());
				const violations: string[] = [];

				/** Run one projection step, checking the ADR 08 I4 root flip. */
				function step(patch: Patch | null, prev: Document): void {
					if (patch === null) return;
					if (driver.document === prev) {
						violations.push("I4: root reference did not flip after an applied patch");
					}
				}
				const event = (ev: AgentSessionEvent) => {
					const prev = driver.document;
					step(driver.applyEvent(ev), prev);
				};
				const refresh = (list: SessionEntry[]) => {
					const prev = driver.document;
					step(driver.refresh(list), prev);
				};

				const rng = mulberry32(seed);
				const addTextBlocks = (rng() * 3) | 0;
				const addThinkingBlocks = (rng() * 2) | 0;
				const addToolBlocks = (rng() * 2) | 0;
				const addToolResults = (rng() * 3) | 0;
				const includeUser = seed % 3 !== 0;

				// The authoritative list grows as pi persists items.
				const piEntries: SessionEntry[] = [];

				// Optional user
				if (includeUser) {
					event(makeMsgEv("user", "fuzz-msg", `u-${seed}`));
					event(makeMsgEnd("user", "fuzz-msg", `u-${seed}`));
					piEntries.push(mkSessionEntry({ type: "message", id: `u-${seed}`, role: "user", parentId: null }));
					// pi persists the user message before the assistant starts.
					refresh(piEntries);
				}

				// Assistant
				event({
					type: "message_start",
					entryId: `a-${seed}`,
					message: {
						role: "assistant",
						content: [],
						api: "test",
						provider: "test",
						model: "test",
						stopReason: "",
						usage: null,
						timestamp: 0,
					},
				} as unknown as AgentSessionEvent);

				let ci = 0;
				for (let t = 0; t < addTextBlocks; t++) {
					const idx = ci++;
					event(makeUpdate("text_start", idx, null, `a-${seed}`));
					let full = "";
					for (let d = 0; d < 1 + ((rng() * 3) | 0); d++) {
						const chunk = "xyz".slice(0, 1 + ((rng() * 3) | 0));
						full += chunk;
						event(makeUpdate("text_delta", idx, chunk, `a-${seed}`));
					}
					event(makeUpdate("text_end", idx, full, `a-${seed}`));
				}
				for (let t = 0; t < addThinkingBlocks; t++) {
					const idx = ci++;
					event(makeUpdate("thinking_start", idx, null, `a-${seed}`));
					const chunk = `think-${seed}-${t}`;
					event(makeUpdate("thinking_delta", idx, chunk, `a-${seed}`));
					event(makeUpdate("thinking_end", idx, chunk, `a-${seed}`));
				}
				for (let t = 0; t < addToolBlocks; t++) {
					const idx = ci++;
					event(makeUpdate("toolcall_start", idx, null, `a-${seed}`));
					const args = `{"s":${seed},"t":${t}}`;
					event(makeUpdate("toolcall_delta", idx, args, `a-${seed}`));
					event(
						makeUpdate(
							"toolcall_end",
							idx,
							{
								id: `tc-${seed}-${t}`,
								name: "fuzz",
								arguments: { s: seed, t },
							},
							`a-${seed}`,
						),
					);
				}

				event(
					makeMsgEnd("assistant", "final", `a-${seed}`, {
						api: "test",
						provider: "test",
						model: "test",
						stopReason: "stop",
						usage: {
							input: 1,
							output: 2,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 3,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					}),
				);

				// Tool results
				for (let t = 0; t < addToolResults; t++) {
					const tcId = `tc-${seed}-${t}`;
					event(makeToolStart(tcId, "fuzz", `tr-${seed}-${t}`));
					event(makeToolEnd(tcId, "fuzz", false, `tr-${seed}-${t}`));
				}

				// The seal: the persisted assistant carries its own content.
				piEntries.push(
					mkSessionEntry({
						type: "message",
						id: `a-${seed}`,
						role: "assistant",
						parentId: includeUser ? `u-${seed}` : null,
						timestamp: "t",
						content: [],
					}),
				);
				for (let t = 0; t < addToolResults; t++) {
					piEntries.push(
						mkSessionEntry({
							type: "message",
							id: `tr-${seed}-${t}`,
							role: "toolResult",
							parentId: `a-${seed}`,
							timestamp: "t",
							toolCallId: `tc-${seed}-${t}`,
							toolName: "fuzz",
							isError: false,
							content: [{ type: "text", text: `out-tc-${seed}-${t}` }],
						}),
					);
				}

				// Seal
				refresh(piEntries);
				event({ type: "agent_settled" } as AgentSessionEvent);

				// ADR 08 I5: structural sharing — capture committed entry refs
				// before an idempotent second refresh.
				const committedIds = Object.keys(driver.document.entries).filter((id) =>
					isEntrySealed(driver.document.entries[id]!),
				);
				const snapBefore: Record<string, unknown> = {};
				for (const id of committedIds) snapBefore[id] = driver.document.entries[id];

				if (driver.refresh(piEntries) !== null) violations.push("I6: second refresh was not a no-op");

				// Entries not touched by the final refresh keep their reference
				for (const id of committedIds) {
					if (driver.document.entries[id] !== snapBefore[id]) {
						violations.push(`I5: committed entry ${id} reference changed without being touched`);
					}
				}

				// Verify invariants
				// I2, I3: domain validity
				const dv = checkDomainValidity(driver.document);
				if (dv.length > 0) violations.push(...dv.map((v) => `I2/I3: ${v}`));

				// I4: every entry kept the id it started under — no synthetic
				// identity exists alongside a persisted entry.
				for (const id of Object.keys(driver.document.entries)) {
					if (id.startsWith("pending:")) violations.push(`I4: synthetic identity ${id} after seal`);
				}

				// I5: a persisted entry is sealed and carries its file position.
				for (let i = 0; i < piEntries.length; i++) {
					const id = piEntries[i]!.id;
					if (!isEntrySealed(driver.document.entries[id]!)) violations.push(`I5: ${id} not sealed`);
					if (driver.document.entries[id]?.ord !== i) violations.push(`I5: ${id} ord mismatch`);
				}

				expect(violations, `seed=${seed}`).toEqual([]);
			});
		}
	});
});

function mulberry32(a: number): () => number {
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

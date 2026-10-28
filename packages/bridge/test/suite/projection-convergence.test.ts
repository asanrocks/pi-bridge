// ============================================================================
// Projection convergence oracle — the publication contract of
// createEntryProjection: a mirror that applies every emitted patch, in order,
// holds exactly the canonical document the projection maintains. Checked
// after *every* step (event, refresh, rewrite, settle), not only at the end,
// so an intermediate divergence cannot be repaired by a later patch.
//
// The same scenarios also pin the domain invariants on the canonical
// document: parent chains resolve, the leaf exists, sealed entries carry
// their file position.
// ============================================================================

import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { applyPatch, type Document, type Patch, type PatchOp } from "../../src/core/index.ts";
import { isEntrySealed } from "../../src/core/types.ts";
import { createDriver } from "./projection-driver.ts";

// ---------------------------------------------------------------------------
// Fixtures
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
		entries: {},
	};
}

function userEntry(id: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2026-01-01T00:00:${id}s`,
		message: { role: "user", content: `text of ${id}`, timestamp: 0 },
	} as SessionEntry;
}

function assistantEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2026-01-01T00:01:${id}s`,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "x",
			provider: "x",
			model: "m",
			stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
			timestamp: 0,
		},
	} as unknown as SessionEntry;
}

function labelEntry(id: string, parentId: string | null, targetId: string, label: string): SessionEntry {
	return { type: "label", id, parentId, timestamp: "2026-01-01T00:02:00Z", targetId, label } as SessionEntry;
}

function msgStart(entryId: string, role: string): AgentSessionEvent {
	return {
		type: "message_start",
		entryId,
		message: { role, content: [], api: "x", provider: "x", model: "m", timestamp: 0 },
	} as unknown as AgentSessionEvent;
}

function textDelta(entryId: string, index: number, delta: string): AgentSessionEvent {
	return {
		type: "message_update",
		entryId,
		assistantMessageEvent: { type: "text_delta", contentIndex: index, delta },
	} as unknown as AgentSessionEvent;
}

function textStart(entryId: string, index: number): AgentSessionEvent {
	return {
		type: "message_update",
		entryId,
		assistantMessageEvent: { type: "text_start", contentIndex: index },
	} as unknown as AgentSessionEvent;
}

function thinkingDelta(entryId: string, index: number, delta: string): AgentSessionEvent {
	return {
		type: "message_update",
		entryId,
		assistantMessageEvent: { type: "thinking_delta", contentIndex: index, delta },
	} as unknown as AgentSessionEvent;
}

function thinkingStart(entryId: string, index: number): AgentSessionEvent {
	return {
		type: "message_update",
		entryId,
		assistantMessageEvent: { type: "thinking_start", contentIndex: index },
	} as unknown as AgentSessionEvent;
}

function toolStart(entryId: string, toolCallId: string): AgentSessionEvent {
	return {
		type: "tool_execution_start",
		entryId,
		toolCallId,
		toolName: "read",
		args: {},
	} as unknown as AgentSessionEvent;
}

function toolEnd(entryId: string, toolCallId: string): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		entryId,
		toolCallId,
		toolName: "read",
		result: { content: [{ type: "text", text: "output" }], details: {} },
		isError: false,
	} as unknown as AgentSessionEvent;
}

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

function norm(doc: Document): Document {
	return JSON.parse(JSON.stringify(doc)) as Document;
}

function assertDocsEqual(a: Document, b: Document, label: string): void {
	const na = norm(a);
	const nb = norm(b);
	const aJson = JSON.stringify(na);
	const bJson = JSON.stringify(nb);
	if (aJson === bJson) return;
	// Fall back to a per-entry diff for a readable failure.
	const ids = new Set([...Object.keys(na.entries), ...Object.keys(nb.entries)]);
	const diffs: string[] = [];
	for (const id of ids) {
		const x = JSON.stringify(na.entries[id]);
		const y = JSON.stringify(nb.entries[id]);
		if (x !== y) diffs.push(`entry ${id}:\n  mirror: ${x?.slice(0, 300)}\n  canonical: ${y?.slice(0, 300)}`);
	}
	if (JSON.stringify(na.status) !== JSON.stringify(nb.status)) {
		diffs.push(`status:\n  mirror: ${JSON.stringify(na.status)}\n  canonical: ${JSON.stringify(nb.status)}`);
	}
	throw new Error(`[${label}] mirror diverged from canonical:\n${diffs.join("\n")}`);
}

function domainViolations(doc: Document): string[] {
	const v: string[] = [];
	for (const [id, entry] of Object.entries(doc.entries)) {
		if (entry.parentId !== null && !doc.entries[entry.parentId])
			v.push(`parent of ${id} (${entry.parentId}) missing`);
		if (isEntrySealed(entry) && entry.ord === undefined) v.push(`sealed entry ${id} has no ord`);
	}
	if (doc.status.leafId !== null && !doc.entries[doc.status.leafId]) v.push(`leaf ${doc.status.leafId} missing`);
	return v;
}

/** A driver plus a mirror that applies every emitted patch, checked per step. */
function tracked(initial: Document) {
	const driver = createDriver(structuredClone(initial));
	let mirror = structuredClone(initial);
	let steps = 0;
	const apply = (patch: Patch | null, label: string): void => {
		if (patch === null) return;
		mirror = applyPatch(mirror, patch.ops);
		steps += 1;
		assertDocsEqual(mirror, driver.document, `${label} (step ${steps})`);
		expect(domainViolations(driver.document), `${label} (step ${steps})`).toEqual([]);
	};
	return {
		driver,
		get mirror(): Document {
			return mirror;
		},
		get patchesApplied(): number {
			return steps;
		},
		applyEvent(event: AgentSessionEvent, label: string): PatchOp[] {
			const patch = driver.applyEvent(event);
			apply(patch, label);
			return patch?.ops ?? [];
		},
		refresh(entries: SessionEntry[], leafId?: string | null, label = "refresh"): PatchOp[] {
			const patch = driver.refresh(entries, leafId);
			apply(patch, label);
			return patch?.ops ?? [];
		},
		rewrite(entries: SessionEntry[], leafId?: string | null, label = "rewrite"): PatchOp[] {
			const patch = driver.rewrite(entries, leafId);
			apply(patch, label);
			return patch?.ops ?? [];
		},
		settle(label = "settle"): PatchOp[] {
			const patch = driver.settle();
			apply(patch, label);
			return patch?.ops ?? [];
		},
	};
}

// ---------------------------------------------------------------------------
// Scripted scenarios
// ---------------------------------------------------------------------------

describe("projection convergence oracle", () => {
	it("a full turn: live stream, seal, silent append, branch move, rewrite, abandoned live form", () => {
		const t = tracked(emptyDoc());

		// Bootstrap: history installs from the entry list.
		const history = [userEntry("u1", null), assistantEntry("a1", "u1", "first answer")];
		t.refresh(history, undefined, "bootstrap");
		expect(t.driver.document.entries.u1?.ord).toBe(0);
		expect(t.driver.document.entries.a1?.ord).toBe(1);
		expect(t.driver.document.status.leafId).toBe("a1");

		// Turn 2: a live user message plus a streamed assistant.
		t.applyEvent(
			{
				...msgStart("u2", "user"),
				message: { role: "user", content: "second", timestamp: 0 },
			} as unknown as AgentSessionEvent,
			"user live",
		);
		t.applyEvent(msgStart("a2", "assistant"), "assistant live");
		t.applyEvent(textStart("a2", 0), "text start");
		t.applyEvent(textDelta("a2", 0, "sec"), "text delta 1");
		t.applyEvent(textDelta("a2", 0, "ond"), "text delta 2");
		expect(t.driver.document.status.leafId).toBe("a2");

		// pi persists the user message mid-turn; the refresh installs it while
		// the assistant stays live.
		t.refresh([...history, userEntry("u2", "a1")], undefined, "mid-turn persist");
		expect(isEntrySealed(t.driver.document.entries.u2!)).toBe(true);
		expect(isEntrySealed(t.driver.document.entries.a2!)).toBe(false);

		// The assistant seals with content the stream never produced.
		const sealedList = [
			...history,
			userEntry("u2", "a1"),
			assistantEntry("a2", "u2", "the authoritative second answer"),
		];
		t.refresh(sealedList, undefined, "seal");
		expect(isEntrySealed(t.driver.document.entries.a2!)).toBe(true);
		expect(t.driver.document.entries.a2?.ord).toBe(3);

		// A late stream event for the sealed entry is refused.
		const late = t.applyEvent(textDelta("a2", 0, " LATE"), "late stream");
		expect(late).toEqual([]);
		expect(t.driver.document.entries.a2).toBe(t.mirror.entries.a2);

		// A silent append (a label persisted out of band) is discovered.
		t.refresh([...sealedList, labelEntry("l1", "a2", "u2", "bookmark")], undefined, "silent append");
		expect(t.driver.document.entries.l1?.kind).toBe("label");

		// A branch move with no append: pi selects an earlier leaf.
		t.refresh([...sealedList, labelEntry("l1", "a2", "u2", "bookmark")], "u2", "branch move");
		expect(t.driver.document.status.leafId).toBe("u2");

		// A wholesale rewrite (fork): new prefix, installed entries not in it are gone.
		t.rewrite([userEntry("u1", null)], "u1", "fork");
		expect(t.driver.document.entries.u2).toBeUndefined();
		expect(t.driver.document.status.leafId).toBe("u1");

		// An abandoned live form: opened, never persisted, dropped by settle.
		t.applyEvent(msgStart("a3", "assistant"), "abandoned live");
		expect(t.driver.document.entries.a3).toBeDefined();
		t.settle();
		expect(t.driver.document.entries.a3).toBeUndefined();
		expect(t.driver.document.status.leafId).toBe("u1");

		expect(t.patchesApplied).toBeGreaterThan(5);
	});

	it("convergence holds when a rewrite arrives as a suffix read", () => {
		// The Manager reads from the position the projection holds, so after a
		// wholesale rewrite the first read returns a suffix of the new list.
		// The projection must re-read from zero, and the mirror must still
		// converge through the emitted patch.
		const t = tracked(emptyDoc());
		const v1 = [userEntry("u1", null), userEntry("u2", "u1")];
		t.refresh(v1, undefined, "v1 install");

		const v2 = [userEntry("n1", null), userEntry("n2", "n1"), userEntry("n3", "n2")];
		t.rewrite(v2, undefined, "v2 rewrite");
		expect(Object.keys(t.driver.document.entries).sort()).toEqual(["n1", "n2", "n3"]);
		expect(t.driver.document.entries.n1?.ord).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Fuzz
// ---------------------------------------------------------------------------

function mulberry32(a: number): () => number {
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("projection convergence fuzz", () => {
	for (let seed = 0; seed < 20; seed++) {
		it(`seed ${seed} — mirror converges through a random turn`, () => {
			const t = tracked(emptyDoc());
			const rng = mulberry32(seed);
			const textBlocks = (rng() * 3) | 0;
			const thinkingBlocks = (rng() * 2) | 0;
			const toolResults = (rng() * 3) | 0;
			const includeUser = seed % 3 !== 0;

			const entries: SessionEntry[] = [];
			if (includeUser) {
				t.applyEvent(
					{
						type: "message_start",
						entryId: `u-${seed}`,
						message: { role: "user", content: `fuzz-${seed}`, timestamp: 0 },
					} as unknown as AgentSessionEvent,
					"user",
				);
				entries.push(userEntry(`u-${seed}`, null));
				// Persist the user message before the assistant starts.
				t.refresh([...entries], undefined, "persist user");
			}

			t.applyEvent(msgStart(`a-${seed}`, "assistant"), "assistant");
			let ci = 0;
			for (let b = 0; b < textBlocks; b++) {
				const idx = ci++;
				t.applyEvent(textStart(`a-${seed}`, idx), "text start");
				t.applyEvent(textDelta(`a-${seed}`, idx, "chunk"), "text delta");
			}
			for (let b = 0; b < thinkingBlocks; b++) {
				const idx = ci++;
				t.applyEvent(thinkingStart(`a-${seed}`, idx), "thinking start");
				t.applyEvent(thinkingDelta(`a-${seed}`, idx, "thought"), "thinking delta");
			}
			for (let b = 0; b < toolResults; b++) {
				t.applyEvent(toolStart(`tr-${seed}-${b}`, `tc-${seed}-${b}`), "tool start");
				t.applyEvent(toolEnd(`tr-${seed}-${b}`, `tc-${seed}-${b}`), "tool end");
			}

			// Seal: the persisted assistant carries its own content.
			entries.push(assistantEntry(`a-${seed}`, entries.at(-1)?.id ?? null, "authoritative"));
			for (let b = 0; b < toolResults; b++) {
				entries.push({
					type: "message",
					id: `tr-${seed}-${b}`,
					parentId: `a-${seed}`,
					timestamp: "t",
					message: {
						role: "toolResult",
						toolCallId: `tc-${seed}-${b}`,
						toolName: "read",
						content: [{ type: "text", text: "output" }],
						isError: false,
						timestamp: 0,
					},
				} as SessionEntry);
			}
			t.refresh(entries, undefined, "seal");

			// Idempotence: an unchanged refresh emits nothing and changes nothing.
			const before = t.driver.document;
			expect(t.driver.refresh(entries)).toBeNull();
			expect(t.driver.document).toBe(before);

			// Settle drops nothing that persisted.
			t.settle();
			for (const entry of entries) {
				expect(isEntrySealed(t.driver.document.entries[entry.id]!), `seed ${seed}: ${entry.id}`).toBe(true);
			}

			// A random branch move without an append.
			const leaf = entries[(rng() * entries.length) | 0]!.id;
			t.refresh(entries, leaf, "branch move");
			expect(t.driver.document.status.leafId).toBe(leaf);

			// Domain validity on the final canonical document.
			expect(domainViolations(t.driver.document)).toEqual([]);
		});
	}
});

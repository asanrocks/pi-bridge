// Send-anchor consumption (§3b of useViewportTracking) over the real event
// pipeline. The consumption logic is store-side and pure (consumeSendAnchor),
// so it is tested here against the actual patch stream a session produces —
// including the provisional→committed re-key that motivated the fingerprint.
//
// Regression (observed live): a steer armed mid-turn captured the previous
// message's PROVISIONAL id as the baseline; when the seal re-keyed that
// message to its real persisted id, the id-only comparison consumed the
// anchor on the PREVIOUS message — pinning it and leaving the steer
// unanchored.

import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { Patch } from "../../src/core/index.ts";
import { DocumentMirror, snapshotForWire } from "../../src/core/index.ts";
import type { Entry } from "../../src/core/types.ts";
import {
	consumeSendAnchor,
	lastUserEntryIdOnPath,
	messageFingerprint,
	type SendAnchorBaseline,
} from "../../web/src/infra/state/ui.ts";
import type { BridgeHarness } from "./harness.ts";
import { createBridgeHarness } from "./harness.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

/** The §3b state machine minus the DOM: mirrors every patch, arms like
 * armSendAnchor does, and records the first id consumeSendAnchor returns. */
class SendAnchorSim {
	private mirror = new DocumentMirror();
	baseline: SendAnchorBaseline | null = null;
	anchored: Array<{ id: string; text: string }> = [];

	constructor(harness: BridgeHarness) {
		this.mirror.applyReplace(snapshotForWire(harness.manager.document));
		harness.manager.onPatch((p: Patch) => {
			this.mirror.applyPatch(p.ops);
			this.tick();
		});
	}

	private text(id: string): string {
		const entry = this.mirror.document.entries[id] as unknown as {
			content?: Array<{ type: string; text?: string }>;
		};
		return (entry?.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
	}

	/** Runs on every patch — the same cadence as the §3b effect's vm dep. */
	private tick(): void {
		if (this.baseline === null) return;
		const doc = this.mirror.document;
		const id = consumeSendAnchor(doc.entries, doc.status.leafId, this.baseline);
		if (id === null) return;
		this.anchored.push({ id, text: this.text(id) });
		this.baseline = null;
	}

	arm(): void {
		const doc = this.mirror.document;
		const id = lastUserEntryIdOnPath(doc.entries, doc.status.leafId);
		this.baseline = { id, fingerprint: messageFingerprint(doc.entries, id) };
	}
}

describe("send anchor consumption", () => {
	const harnesses: BridgeHarness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("sequential turns anchor each sent message", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [
				fauxAssistantMessage("reply one"),
				fauxAssistantMessage("reply two"),
				fauxAssistantMessage("reply three"),
			],
		});
		harnesses.push(bh);

		const sim = new SendAnchorSim(bh);
		for (const text of ["send one", "send two", "send three"]) {
			sim.arm();
			await bh.manager.prompt(text);
			expect(sim.anchored.length, `anchored once for "${text}"`).toBeGreaterThan(0);
			const last = sim.anchored[sim.anchored.length - 1];
			expect(last.text).toContain(text);
		}
		// Every consume landed on the message it was armed for — no strays.
		expect(sim.anchored.map((a) => a.text)).toEqual(["send one", "send two", "send three"]);
	});

	it("a steer armed mid-turn anchors the steer, not the re-keyed previous message", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("a fairly long streaming reply so the turn is still in flight")],
			tokensPerSecond: 50,
		});
		harnesses.push(bh);

		const sim = new SendAnchorSim(bh);

		sim.arm();
		const first = bh.manager.prompt("the initial message");
		// Let the turn start: the message renders as a `pending:user:`
		// provisional and the assistant is streaming when the steer is sent —
		// the baseline captures the provisional id.
		await new Promise((r) => setTimeout(r, 60));

		sim.arm(); // the steer's arm — mid-turn, previous message still provisional
		await bh.manager.prompt("a mid-turn steer");
		await first;

		// Two sends → two consumes; the second (the steer's) must be the steer
		// message, never the re-keyed previous one.
		expect(sim.anchored.length).toBe(2);
		expect(sim.anchored[0].text).toContain("the initial message");
		expect(sim.anchored[1].text).toContain("a mid-turn steer");
	});

	it("consumeSendAnchor skips a pure re-key: same message, new id", () => {
		// Hand-built minimal case: the walk tail is the re-keyed baseline
		// (identical content, different id) — no consume; a genuinely new
		// message — consume.
		const baseline: SendAnchorBaseline = { id: "pending:user:1", fingerprint: "hello" };
		// Minimal hand-built entries: (id, role, text, parent) message records.
		const entry = (id: string, role: string, text: string, parentId: string | null) =>
			({ kind: "message", id, role, parentId, content: [{ type: "text", text }] }) as unknown as Entry;
		const doc = (tailId: string, tail: Entry): { entries: Record<string, Entry>; leafId: string } => ({
			entries: { root: entry("root", "assistant", "hi", null), [tailId]: tail },
			leafId: tailId,
		});

		// Tail is the baseline itself — no consume.
		expect(
			consumeSendAnchor(
				doc("pending:user:1", entry("pending:user:1", "user", "hello", "root")).entries,
				"pending:user:1",
				baseline,
			),
		).toBeNull();

		// Tail is the baseline's re-key (same content, real id) — still no consume.
		expect(
			consumeSendAnchor(doc("abc123", entry("abc123", "user", "hello", "root")).entries, "abc123", baseline),
		).toBeNull();

		// Tail is a genuinely new message — consume on it.
		expect(
			consumeSendAnchor(doc("def456", entry("def456", "user", "hello again", "root")).entries, "def456", baseline),
		).toBe("def456");
	});
});

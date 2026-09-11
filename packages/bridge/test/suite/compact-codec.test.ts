import { describe, expect, it } from "vitest";
import type { AppendOp, PatchOp, RpcReply, ServerPushMessage } from "../../src/core/index.ts";
import { CompactCodec } from "../../src/core/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function append(path: string, value: string): { kind: "patch"; ops: AppendOp[] } {
	return { kind: "patch", ops: [{ op: "append", path, value }] };
}

function patch(ops: PatchOp[]): { kind: "patch"; ops: PatchOp[] } {
	return { kind: "patch", ops };
}

function replaceFrame(): ServerPushMessage {
	return {
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
	} as unknown as ServerPushMessage;
}

function reply(): RpcReply {
	return { id: "1", ok: true };
}

// Drive `frames` through a fresh encoder, then each wire string through a
// fresh decoder; return the sequence of decoded messages. Asserts the two
// sides stay in lockstep (the contract that makes the compact form safe).
function roundTrip(frames: Record<string, unknown>[]): Array<ServerPushMessage | RpcReply> {
	const enc = new CompactCodec();
	const dec = new CompactCodec();
	const out: Array<ServerPushMessage | RpcReply> = [];
	for (const f of frames) {
		const wire = enc.encodeOutgoing(f);
		out.push(dec.decodeIncoming(wire));
	}
	return out;
}

// ---------------------------------------------------------------------------

describe("CompactCodec", () => {
	// ── Round-trip ────────────────────────────────────────────────────────

	it("encodes a same-path append stream as one full frame then bare strings", () => {
		const enc = new CompactCodec();
		const path = "/entries/pending:message/content/0/thinking";

		// First append: full frame (primes the path on both sides).
		const w1 = enc.encodeOutgoing(append(path, "Hello"));
		expect(JSON.parse(w1)).toEqual({ kind: "patch", ops: [{ op: "append", path, value: "Hello" }] });

		// Subsequent appends to the same path: bare JSON strings.
		expect(enc.encodeOutgoing(append(path, " "))).toBe(JSON.stringify(" "));
		expect(enc.encodeOutgoing(append(path, "world"))).toBe(JSON.stringify("world"));
	});

	it("decodes a compact stream back into the original append ops", () => {
		const path = "/entries/pending:message/content/0/thinking";
		const decoded = roundTrip([append(path, "Hello"), append(path, " "), append(path, "world")]);
		expect(decoded).toEqual([
			{ kind: "patch", ops: [{ op: "append", path, value: "Hello" }] },
			{ kind: "patch", ops: [{ op: "append", path, value: " " }] },
			{ kind: "patch", ops: [{ op: "append", path, value: "world" }] },
		]);
	});

	it("first append to a new path is always a full frame (primes both sides)", () => {
		const enc = new CompactCodec();
		const a = "/entries/e1/content/0/thinking";
		const b = "/entries/e1/content/1/text";

		// Prime path a.
		expect(JSON.parse(enc.encodeOutgoing(append(a, "x")))).toEqual({
			kind: "patch",
			ops: [{ op: "append", path: a, value: "x" }],
		});
		// Compact.
		expect(enc.encodeOutgoing(append(a, "y"))).toBe(JSON.stringify("y"));
		// New path b: full frame, not compact.
		expect(JSON.parse(enc.encodeOutgoing(append(b, "z")))).toEqual({
			kind: "patch",
			ops: [{ op: "append", path: b, value: "z" }],
		});
		// b now compact.
		expect(enc.encodeOutgoing(append(b, "w"))).toBe(JSON.stringify("w"));
		// a is no longer remembered — re-primes as a full frame.
		expect(JSON.parse(enc.encodeOutgoing(append(a, "q")))).toEqual({
			kind: "patch",
			ops: [{ op: "append", path: a, value: "q" }],
		});
	});

	// ── D2: state invalidation ───────────────────────────────────────────

	it("a multi-op patch resets the remembered path", () => {
		const enc = new CompactCodec();
		const path = "/entries/e1/content/0/thinking";
		enc.encodeOutgoing(append(path, "a")); // prime
		expect(enc.encodeOutgoing(append(path, "b"))).toBe(JSON.stringify("b")); // compact

		// Multi-op patch (append + replace) must reset.
		enc.encodeOutgoing(
			patch([
				{ op: "append", path, value: "c" },
				{ op: "replace", path: "/status/isStreaming", value: true },
			]),
		);

		// Next append to the same path: full frame (re-prime), not compact.
		expect(JSON.parse(enc.encodeOutgoing(append(path, "d")))).toEqual({
			kind: "patch",
			ops: [{ op: "append", path, value: "d" }],
		});
	});

	it("a non-append single op (replace) resets the remembered path", () => {
		const enc = new CompactCodec();
		const path = "/entries/e1/content/0/thinking";
		enc.encodeOutgoing(append(path, "a")); // prime
		expect(enc.encodeOutgoing(append(path, "b"))).toBe(JSON.stringify("b")); // compact

		enc.encodeOutgoing(patch([{ op: "replace", path, value: "settled" }]));

		// Next append: full frame (re-prime).
		expect(JSON.parse(enc.encodeOutgoing(append(path, "c")))).toEqual({
			kind: "patch",
			ops: [{ op: "append", path, value: "c" }],
		});
	});

	it("a move op resets the remembered path (relocating a path invalidates it)", () => {
		const enc = new CompactCodec();
		const path = "/entries/e1/content/0/thinking";
		enc.encodeOutgoing(append(path, "a")); // prime
		expect(enc.encodeOutgoing(append(path, "b"))).toBe(JSON.stringify("b")); // compact

		enc.encodeOutgoing(patch([{ op: "move", from: path, path: "/entries/e1/moved" }]));

		expect(JSON.parse(enc.encodeOutgoing(append(path, "c")))).toEqual({
			kind: "patch",
			ops: [{ op: "append", path, value: "c" }],
		});
	});

	it("a replace snapshot resets the remembered path (full document rewrite)", () => {
		const enc = new CompactCodec();
		const path = "/entries/e1/content/0/thinking";
		enc.encodeOutgoing(append(path, "a")); // prime
		expect(enc.encodeOutgoing(append(path, "b"))).toBe(JSON.stringify("b")); // compact

		enc.encodeOutgoing(replaceFrame() as unknown as Record<string, unknown>);

		expect(JSON.parse(enc.encodeOutgoing(append(path, "c")))).toEqual({
			kind: "patch",
			ops: [{ op: "append", path, value: "c" }],
		});
	});

	it("an RPC reply resets the remembered path", () => {
		const enc = new CompactCodec();
		const path = "/entries/e1/content/0/thinking";
		enc.encodeOutgoing(append(path, "a")); // prime
		expect(enc.encodeOutgoing(append(path, "b"))).toBe(JSON.stringify("b")); // compact

		enc.encodeOutgoing(reply() as unknown as Record<string, unknown>);

		expect(JSON.parse(enc.encodeOutgoing(append(path, "c")))).toEqual({
			kind: "patch",
			ops: [{ op: "append", path, value: "c" }],
		});
	});

	it("reset() clears remembered state (reconnect)", () => {
		const enc = new CompactCodec();
		const path = "/entries/e1/content/0/thinking";
		enc.encodeOutgoing(append(path, "a")); // prime
		expect(enc.encodeOutgoing(append(path, "b"))).toBe(JSON.stringify("b")); // compact

		enc.reset();

		// After reset, the next append must re-prime (full frame).
		expect(JSON.parse(enc.encodeOutgoing(append(path, "c")))).toEqual({
			kind: "patch",
			ops: [{ op: "append", path, value: "c" }],
		});
	});

	// ── Decoder safety ───────────────────────────────────────────────────

	it("throws when a compact (bare-string) frame arrives with no remembered path", () => {
		const dec = new CompactCodec();
		expect(() => dec.decodeIncoming(JSON.stringify("orphan"))).toThrow(/no remembered path/);
	});

	it("passes through and round-trips non-compact frames unchanged", () => {
		const enc = new CompactCodec();
		const dec = new CompactCodec();
		const frame = patch([{ op: "replace", path: "/status/isStreaming", value: true }]) as unknown as Record<
			string,
			unknown
		>;
		const wire = enc.encodeOutgoing(frame);
		expect(wire).toBe(JSON.stringify(frame)); // full frame, no compaction
		expect(dec.decodeIncoming(wire)).toEqual(frame);
	});

	it("round-trips a mixed stream: appends, a replace, more appends, a reply", () => {
		const a = "/entries/e1/content/0/thinking";
		const frames: Record<string, unknown>[] = [
			append(a, "Hello"),
			append(a, " "),
			append(a, "world"),
			patch([{ op: "replace", path: a, value: "settled" }]),
			append(a, "!"), // re-prime after the replace
			reply(),
			append(a, "?"), // re-prime after the reply
		];
		const decoded = roundTrip(frames);
		expect(decoded).toEqual([
			{ kind: "patch", ops: [{ op: "append", path: a, value: "Hello" }] },
			{ kind: "patch", ops: [{ op: "append", path: a, value: " " }] },
			{ kind: "patch", ops: [{ op: "append", path: a, value: "world" }] },
			{ kind: "patch", ops: [{ op: "replace", path: a, value: "settled" }] },
			{ kind: "patch", ops: [{ op: "append", path: a, value: "!" }] },
			{ id: "1", ok: true },
			{ kind: "patch", ops: [{ op: "append", path: a, value: "?" }] },
		]);
	});

	// ── Defensive: malformed append op ────────────────────────────────────

	it("treats a single-op patch with a non-string append value as non-compact (defensive)", () => {
		const enc = new CompactCodec();
		// `value` should be a string per AppendOp; a non-string value is a
		// malformed op and must not trigger the compact path.
		const malformed = { kind: "patch", ops: [{ op: "append", path: "/x", value: 123 }] };
		expect(enc.encodeOutgoing(malformed)).toBe(JSON.stringify(malformed));
		// State was reset, so a subsequent legit append to /x primes fresh.
		const path = "/x";
		expect(JSON.parse(enc.encodeOutgoing(append(path, "ok")))).toEqual({
			kind: "patch",
			ops: [{ op: "append", path, value: "ok" }],
		});
	});
});

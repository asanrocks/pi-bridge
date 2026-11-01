// CompactCodec — the transport compaction pair (ADR 19's envelope-preserving
// form). The pins: the one comparison rule (compacted iff the frame differs
// from the held template in exactly the appended string value), the round
// trip (a decoded run equals the frames the full encoder would have sent),
// and the structural impossibility of compaction across an attachment
// change (the generation travels inside the template).

import { describe, expect, it } from "vitest";
import { CompactCodec } from "../../src/core/index.ts";

type Frame = Record<string, unknown>;

function appendFrame(value: string, extra: Frame = {}): Frame {
	return {
		kind: "patch",
		generation: 1,
		ops: [{ op: "append", path: "/entries/e1/content/0/text", value }],
		...extra,
	};
}

function otherAppend(value: string): Frame {
	return {
		kind: "patch",
		generation: 1,
		ops: [{ op: "append", path: "/entries/e2/content/0/text", value }],
	};
}

const rpcReply: Frame = { id: "7", ok: true };
const broadcast: Frame = { kind: "sessions_changed", projectId: "p", sessions: [], hasMore: false };
const multiOp: Frame = {
	kind: "patch",
	generation: 1,
	ops: [
		{ op: "append", path: "/entries/e1/content/0/text", value: "a" },
		{ op: "replace", path: "/status/isStreaming", value: true },
	],
};

/** The wire a Connection produces and the frames a BridgeClient recovers
 * from it: one encoder, one decoder, full-form frames prime the decoder. */
function roundTrip(frames: Frame[]): { wire: string[]; decoded: Frame[] } {
	const encoder = new CompactCodec();
	const decoder = new CompactCodec();
	const wire: string[] = [];
	const decoded: Frame[] = [];
	for (const frame of frames) {
		const bytes = encoder.encode(frame);
		wire.push(bytes);
		const parsed: unknown = JSON.parse(bytes);
		if (typeof parsed === "string") {
			const recovered = decoder.decode(parsed);
			if (recovered === null) throw new Error("undecodable compacted frame");
			decoded.push(recovered);
		} else {
			decoder.observe(parsed as Frame);
			decoded.push(parsed as Frame);
		}
	}
	return { wire, decoded };
}

/** A bare JSON string frame (the compacted form). */
const isBare = (bytes: string): boolean => bytes.startsWith('"');

describe("CompactCodec", () => {
	it("sends the first frame of a run in full form and the rest as bare strings", () => {
		const { wire } = roundTrip([appendFrame("Hello"), appendFrame(" world"), appendFrame("!")]);
		expect(wire.length).toBe(3);
		expect(isBare(wire[0] as string)).toBe(false);
		expect(wire[1]).toBe(JSON.stringify(" world"));
		expect(wire[2]).toBe(JSON.stringify("!"));
	});

	it("decodes a run to the frames the full encoder would have sent", () => {
		const frames = [appendFrame("Hello"), appendFrame(" world"), appendFrame("!")];
		const { decoded } = roundTrip(frames);
		expect(decoded).toEqual(frames);
	});

	it("decodes every field of the template, the attachment generation included", () => {
		const template = appendFrame("Hello", {
			session: { projectId: "p", sessionId: "s1", stem: "a" },
			operationId: "op-1",
		});
		const { wire, decoded } = roundTrip([
			template,
			appendFrame(" world", { session: { projectId: "p", sessionId: "s1", stem: "a" }, operationId: "op-1" }),
		]);
		expect(isBare(wire[1] as string)).toBe(true);
		const compacted = decoded[1] as { generation: number; session: unknown; operationId: string };
		expect(compacted.generation).toBe(1);
		expect(compacted.session).toEqual({ projectId: "p", sessionId: "s1", stem: "a" });
		expect(compacted.operationId).toBe("op-1");
	});

	it("never compacts across an attachment change: a different generation fails the match", () => {
		const { wire } = roundTrip([appendFrame("Hello"), appendFrame(" world", { generation: 2 })]);
		expect(isBare(wire[0] as string)).toBe(false);
		expect(isBare(wire[1] as string)).toBe(false);
	});

	it("replaces the template when a compactable frame fails the match", () => {
		// The run moves to another path: the first frame there is full form
		// and becomes the new template.
		const { wire, decoded } = roundTrip([appendFrame("Hello"), otherAppend("Hi"), otherAppend(" there")]);
		expect(isBare(wire[1] as string)).toBe(false);
		expect(wire[2]).toBe(JSON.stringify(" there"));
		expect(decoded).toEqual([appendFrame("Hello"), otherAppend("Hi"), otherAppend(" there")]);
	});

	it("a multi-op patch travels in full form and does not end the run", () => {
		const { wire, decoded } = roundTrip([appendFrame("Hello"), multiOp, appendFrame(" world")]);
		expect(isBare(wire[1] as string)).toBe(false);
		// The multi-op frame never touched the template, so the run continues.
		expect(wire[2]).toBe(JSON.stringify(" world"));
		expect(decoded).toEqual([appendFrame("Hello"), multiOp, appendFrame(" world")]);
	});

	it("an RPC reply or a broadcast interleave keeps the run alive", () => {
		const { wire, decoded } = roundTrip([appendFrame("Hello"), rpcReply, broadcast, appendFrame(" world")]);
		expect(isBare(wire[1] as string)).toBe(false);
		expect(isBare(wire[2] as string)).toBe(false);
		expect(wire[3]).toBe(JSON.stringify(" world"));
		expect(decoded).toEqual([appendFrame("Hello"), rpcReply, broadcast, appendFrame(" world")]);
	});

	it("a replace or an initial-sync frame never compacts", () => {
		const replace: Frame = {
			kind: "replace",
			generation: 1,
			session: { projectId: "p", sessionId: "s", stem: "a" },
			document: {},
		};
		const { wire, decoded } = roundTrip([appendFrame("Hello"), replace, appendFrame(" world")]);
		expect(isBare(wire[1] as string)).toBe(false);
		expect(wire[2]).toBe(JSON.stringify(" world"));
		expect(decoded).toEqual([appendFrame("Hello"), replace, appendFrame(" world")]);
	});

	it("a non-string append value never compacts and never primes the template", () => {
		const numericAppend: Frame = {
			kind: "patch",
			generation: 1,
			ops: [{ op: "append", path: "/entries/e1/content/0/text", value: 3 }],
		};
		const { wire } = roundTrip([numericAppend, numericAppend]);
		expect(isBare(wire[0] as string)).toBe(false);
		expect(isBare(wire[1] as string)).toBe(false);
	});

	it("decode returns null with no established run", () => {
		const decoder = new CompactCodec();
		expect(decoder.decode("orphan")).toBeNull();
	});

	it("round-trips arbitrary frame sequences (deterministic pseudo-random mix)", () => {
		// A fixed-seed LCG picks frames from a mix of runs, interleaves, and
		// attachment changes; the decoded stream must equal the input stream.
		let seed = 0x2f6e2b1;
		const next = (): number => {
			seed = (seed * 1103515245 + 12345) % 0x80000000;
			return seed;
		};
		const frames: Frame[] = [];
		let generation = 1;
		for (let i = 0; i < 300; i++) {
			const pick = next() % 6;
			if (pick === 0) {
				frames.push(rpcReply);
			} else if (pick === 1) {
				frames.push(broadcast);
			} else if (pick === 2) {
				frames.push(multiOp);
			} else if (pick === 3) {
				generation += 1; // an attachment change mid-stream
				frames.push(appendFrame(`g${generation}`, { generation }));
			} else {
				frames.push(appendFrame(`t${i}`));
			}
		}
		const { wire, decoded } = roundTrip(frames);
		expect(decoded).toEqual(frames);
		// The stream really compacted: some consecutive appends on one
		// attachment crossed the wire as bare strings.
		expect(wire.some((bytes) => isBare(bytes))).toBe(true);
	});
});

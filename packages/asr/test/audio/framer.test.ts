/**
 * Framer unit tests, one per asymmetry documented in `docs/protocol.md` §5.5.
 *
 * The framer is where a wire-format difference turns into bytes, so the two
 * behaviours are asserted separately instead of only through the session:
 * protobuf must close with a `last` (a silent frame when nothing is pending),
 * JSON must close by flushing real audio and nothing else.
 */
import { describe, expect, it } from "vitest";
import type { AudioFramerOptions } from "../../src/framer.ts";
import { AudioFramer } from "../../src/framer.ts";
import { FrameState } from "../../src/protocol/protobuf.ts";
import { ramp } from "../../src/testing/mock-transport.ts";

interface Sent {
	samples: number[];
	state: FrameState | undefined;
}

/** 20 ms at 16 kHz = 320 samples = 640 bytes per frame. */
const FRAME = 320;

function framer(options: Partial<AudioFramerOptions> & { wire: AudioFramerOptions["wire"] }): {
	framer: AudioFramer;
	sent: Sent[];
} {
	const sent: Sent[] = [];
	const instance = new AudioFramer({
		codec: "pcm",
		frameMs: 20,
		sampleRate: 16_000,
		...options,
		sink: (data, state) => {
			const copy = new Uint8Array(data.length);
			copy.set(data);
			const pcm = new Int16Array(copy.buffer);
			sent.push({ samples: Array.from(pcm), state });
		},
	});
	return { framer: instance, sent };
}

describe("AudioFramer / JSON wire", () => {
	it("closes a frame-aligned stream without synthesising silence", () => {
		const { framer: f, sent } = framer({ wire: "json" });
		f.push(ramp(FRAME));
		expect(sent).toHaveLength(1);

		f.finish();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.state).toBeUndefined();
		expect(sent[0]?.samples).toEqual(Array.from(ramp(FRAME)));
	});

	it("flushes a partial frame zero-padded, with no frame state", () => {
		const { framer: f, sent } = framer({ wire: "json" });
		f.push(ramp(100));
		f.finish();

		expect(sent).toHaveLength(1);
		expect(sent[0]?.state).toBeUndefined();
		expect(sent[0]?.samples.slice(0, 100)).toEqual(Array.from(ramp(100)));
		expect(sent[0]?.samples.slice(100).every((value) => value === 0)).toBe(true);
	});

	it("sends one silent frame when the session never captured anything", () => {
		const { framer: f, sent } = framer({ wire: "json" });
		f.finish();

		expect(sent).toHaveLength(1);
		expect(sent[0]?.state).toBeUndefined();
		expect(sent[0]?.samples.every((value) => value === 0)).toBe(true);
	});

	it("honours an explicit tail", () => {
		const { framer: f, sent } = framer({ wire: "json", tailMs: 20 });
		f.push(ramp(FRAME));
		f.finish();

		expect(sent).toHaveLength(2);
		expect(sent[1]?.samples.every((value) => value === 0)).toBe(true);
	});
});

describe("AudioFramer / protobuf wire", () => {
	it("marks first, middle and last, closing with a silent last", () => {
		const { framer: f, sent } = framer({ wire: "protobuf" });
		f.push(ramp(FRAME * 3));
		f.finish();

		expect(sent.map((frame) => frame.state)).toEqual([
			FrameState.first,
			FrameState.middle,
			FrameState.middle,
			FrameState.last,
		]);
		// The closing frame carries the state, not audio: it is silent.
		expect(sent[3]?.samples.every((value) => value === 0)).toBe(true);
	});

	it("sends first then a silent last when the utterance is shorter than a frame", () => {
		const { framer: f, sent } = framer({ wire: "protobuf" });
		f.push(ramp(100));
		f.finish();

		expect(sent.map((frame) => frame.state)).toEqual([FrameState.first, FrameState.last]);
		expect(sent[0]?.samples.slice(0, 100)).toEqual(Array.from(ramp(100)));
		expect(sent[0]?.samples.slice(100).every((value) => value === 0)).toBe(true);
		expect(sent[1]?.samples.every((value) => value === 0)).toBe(true);
	});

	it("marks the requested tail frames last, and only the final one", () => {
		const { framer: f, sent } = framer({ wire: "protobuf", tailMs: 40 });
		f.push(ramp(FRAME));
		f.finish();

		expect(sent.map((frame) => frame.state)).toEqual([FrameState.first, FrameState.middle, FrameState.last]);
		expect(sent.slice(1).every((frame) => frame.samples.every((value) => value === 0))).toBe(true);
	});
});

describe("AudioFramer / rejected configurations", () => {
	it("refuses opus without an encoder", () => {
		expect(() => framer({ wire: "json", codec: "opus" })).toThrow(/opus codec needs an encoder/);
	});

	it("refuses an opus frame longer than 60 ms", () => {
		expect(() =>
			framer({
				wire: "json",
				codec: "opus",
				frameMs: 100,
				encode: () => new Uint8Array(1),
			}),
		).toThrow(/cannot exceed 60/);
	});

	it("refuses a push after finish", () => {
		const { framer: f } = framer({ wire: "json" });
		f.finish();
		expect(() => {
			f.push(ramp(1));
		}).toThrow(/push after finish/);
	});
});

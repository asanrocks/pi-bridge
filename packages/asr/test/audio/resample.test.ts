import { describe, expect, it } from "vitest";
import { Resampler } from "../../src/audio/resample.ts";

describe("Resampler", () => {
	it("is a bit-exact passthrough at the same rate", () => {
		const resampler = new Resampler(16_000);
		const input = Float32Array.from([-1, -0.5, 0, 0.5, 1]);
		const out = resampler.push(input);
		expect(Array.from(out)).toEqual([-32_767, -16_383, 0, 16_384, 32_767]);
	});

	it("downsamples 48k to 16k at exactly one third of the length", () => {
		const resampler = new Resampler(48_000);
		const input = new Float32Array(4800).fill(0.25);
		const out = resampler.push(input);
		expect(out).toHaveLength(1600);
		expect(new Set(out).size).toBe(1);
		expect(out[0]).toBe(Math.round(0.25 * 0x7fff));
	});

	it("produces the same result whether the input arrives in one piece or many", () => {
		const input = new Float32Array(4410);
		for (let index = 0; index < input.length; index += 1) {
			input[index] = Math.sin(index / 20) * 0.5;
		}
		const once = new Resampler(44_100).push(input);

		const chunked = new Resampler(44_100);
		const parts: Int16Array[] = [];
		for (let offset = 0; offset < input.length; offset += 128) {
			parts.push(chunked.push(input.subarray(offset, offset + 128)));
		}
		const many = Int16Array.from(parts.flatMap((part) => Array.from(part)));

		expect(many.length).toBe(once.length);
		expect(Array.from(many)).toEqual(Array.from(once));
	});

	it("does not drift on a non-integer ratio", () => {
		const resampler = new Resampler(44_100);
		const input = new Float32Array(44_100).fill(0.1);
		let produced = 0;
		for (let offset = 0; offset < input.length; offset += 1024) {
			produced += resampler.push(input.subarray(offset, offset + 1024)).length;
		}
		// 44100 / 2.75625 = 16000 samples, within one buffered sample.
		expect(Math.abs(produced - 16_000)).toBeLessThanOrEqual(1);
	});

	it("resamples the flushed remainder instead of passing it through raw", () => {
		const resampler = new Resampler(48_000);
		const input = new Float32Array(1601).fill(0.5);
		const emitted = resampler.push(input);
		const tail = resampler.flush();

		expect(emitted).toHaveLength(533);
		// The partial window is averaged over the two samples it has, so it is still
		// 16 kHz-rate audio (a raw pass-through would append 48 kHz samples).
		expect(Array.from(tail)).toEqual([Math.round(0.5 * 0x7fff)]);
		expect(resampler.buffered).toBe(0);
	});

	it("rejects impossible rates", () => {
		expect(() => new Resampler(0)).toThrow(/invalid rates/);
		expect(() => new Resampler(16_000, -1)).toThrow(/invalid rates/);
	});
});

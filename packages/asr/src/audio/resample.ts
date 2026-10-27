/**
 * Float PCM at the hardware rate → 16 kHz mono s16le.
 *
 * `new AudioContext({ sampleRate: 16000 })` is honoured by Chromium but not
 * guaranteed elsewhere, and file/stream sources arrive at arbitrary rates, so
 * the resampler is not a fallback: it is the contract. A box filter is enough
 * for speech at these ratios (48k→16k is exactly 3:1) and avoids carrying a
 * windowed-sinc kernel in a browser bundle.
 *
 * Window boundaries are tracked in absolute sample indices rather than relative
 * to each chunk, so feeding the same audio in different chunk sizes yields the
 * same output. That matters because `AudioWorklet` quantum size (128 samples)
 * has nothing to do with the frame size the server wants.
 */
import { SAMPLE_RATE } from "../constants.ts";
import { AsrError } from "../errors.ts";

export class Resampler {
	readonly fromRate: number;
	readonly toRate: number;
	private readonly ratio: number;
	private carry: Float32Array = new Float32Array(0);
	/** Absolute index of `carry[0]` in the input stream. */
	private carryStart = 0;
	/** Absolute index of the next window start. */
	private next = 0;

	constructor(fromRate: number, toRate: number = SAMPLE_RATE) {
		if (fromRate <= 0 || toRate <= 0) {
			throw new AsrError("config", `resampler: invalid rates ${String(fromRate)} -> ${String(toRate)}`);
		}
		this.fromRate = fromRate;
		this.toRate = toRate;
		this.ratio = fromRate / toRate;
	}

	/** Input samples buffered but not yet emitted. */
	get buffered(): number {
		return this.carry.length;
	}

	push(chunk: Float32Array): Int16Array {
		if (chunk.length === 0) return new Int16Array(0);
		if (this.fromRate === this.toRate) return toInt16(chunk);

		const merged = new Float32Array(this.carry.length + chunk.length);
		merged.set(this.carry);
		merged.set(chunk, this.carry.length);

		const out: number[] = [];
		while (this.next + this.ratio <= this.carryStart + merged.length) {
			const start = this.next - this.carryStart;
			const end = start + this.ratio;
			const first = Math.round(start);
			const last = Math.round(end);
			let sum = 0;
			for (let index = first; index < last; index += 1) sum += merged[index] ?? 0;
			out.push(toSample(sum / Math.max(1, last - first)));
			this.next += this.ratio;
		}

		// Keep only samples the next window can still touch.
		const drop = Math.max(0, Math.floor(this.next - this.carryStart));
		this.carry = merged.slice(drop);
		this.carryStart += drop;
		return Int16Array.from(out);
	}

	/**
	 * Emit the remainder; only useful once the input stream has ended.
	 *
	 * The leftover window is averaged over the samples that exist instead of being
	 * passed through unresampled, which would append a few samples at the wrong
	 * rate — audible as a click and wrong in length.
	 */
	flush(): Int16Array {
		if (this.carry.length === 0) return new Int16Array(0);
		const rest = this.carry;
		const end = this.carryStart + rest.length;
		const out: number[] = [];
		while (this.next < end) {
			const first = Math.round(this.next - this.carryStart);
			const last = Math.min(rest.length, Math.round(this.next - this.carryStart + this.ratio));
			const stop = Math.max(first + 1, last);
			let sum = 0;
			for (let index = first; index < stop; index += 1) sum += rest[index] ?? 0;
			out.push(toSample(sum / (stop - first)));
			this.next += this.ratio;
		}
		this.carry = new Float32Array(0);
		this.carryStart = end;
		return Int16Array.from(out);
	}
}

function toSample(value: number): number {
	const clamped = Math.max(-1, Math.min(1, value));
	return Math.round(clamped * 0x7fff);
}

function toInt16(chunk: Float32Array): Int16Array {
	const out = new Int16Array(chunk.length);
	for (let index = 0; index < chunk.length; index += 1) out[index] = toSample(chunk[index] ?? 0);
	return out;
}

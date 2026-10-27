/**
 * Turns an arbitrarily chunked PCM stream into wire frames.
 *
 * The server's framing rules are not symmetric (see `docs/protocol.md` §5.5):
 *
 * - protobuf carries one opus packet per message and needs `frame_state`
 *   `first`/`middle`/`last`, so closing means emitting a `last`. When the stream
 *   ended on a frame boundary there is nothing left to flush, and the `last` is
 *   carried by a silent frame — that frame is protocol machinery, not extra
 *   audio for the recogniser. An utterance shorter than one frame becomes
 *   `first` followed by a silent `last`.
 * - the JSON wire takes bare binary frames and has no frame state at all, so
 *   closing is a pure flush: synthesising a silent frame there would be the
 *   trailing silence that measurement says is unnecessary.
 *
 * Tail silence is supported but off by default: 0 ms was correct in every run,
 * and it is ~0.5 s of perceived latency.
 */
import { AsrError } from "./errors.ts";
import { FrameState } from "./protocol/protobuf.ts";
import type { AudioCodec, FrameMs, Wire } from "./types.ts";

export interface AudioFramerOptions {
	wire: Wire;
	codec: AudioCodec;
	frameMs: FrameMs;
	sampleRate: number;
	/** Silence appended after the last real frame, in ms. */
	tailMs?: number;
	/** Required for `opus`; must return one raw opus packet for exactly `frameSamples` samples. */
	encode?: (pcm: Int16Array) => Uint8Array;
	sink: (data: Uint8Array, state: FrameState | undefined) => void;
}

const MAX_OPUS_FRAME_MS = 60;

export class AudioFramer {
	readonly frameSamples: number;
	private readonly wire: Wire;
	private readonly codec: AudioCodec;
	private readonly frameMs: number;
	private readonly tailMs: number;
	private readonly encode: ((pcm: Int16Array) => Uint8Array) | undefined;
	private readonly sink: AudioFramerOptions["sink"];

	private readonly pending: Int16Array;
	private pendingCount = 0;
	private started = false;
	private finished = false;

	framesSent = 0;
	samplesSent = 0;

	constructor(options: AudioFramerOptions) {
		if (!Number.isInteger(options.sampleRate) || options.sampleRate <= 0) {
			throw new AsrError("config", `framer: invalid sample rate ${String(options.sampleRate)}`);
		}
		if (options.codec === "opus") {
			if (options.encode === undefined) {
				throw new AsrError("config", "framer: the opus codec needs an encoder");
			}
			if (options.frameMs > MAX_OPUS_FRAME_MS) {
				throw new AsrError("config", `framer: opus frames cannot exceed ${String(MAX_OPUS_FRAME_MS)} ms`);
			}
		}
		this.frameSamples = (options.sampleRate * options.frameMs) / 1000;
		this.wire = options.wire;
		this.codec = options.codec;
		this.frameMs = options.frameMs;
		this.tailMs = Math.max(0, options.tailMs ?? 0);
		this.encode = options.encode;
		this.sink = options.sink;
		this.pending = new Int16Array(this.frameSamples);
	}

	/** Accepted before the session is ready; the caller buffers instead. */
	push(input: Int16Array | Uint8Array): void {
		if (this.finished) throw new AsrError("config", "framer: push after finish");
		const samples = toSamples(input);
		let offset = 0;
		while (offset < samples.length) {
			const take = Math.min(this.frameSamples - this.pendingCount, samples.length - offset);
			this.pending.set(samples.subarray(offset, offset + take), this.pendingCount);
			this.pendingCount += take;
			offset += take;
			if (this.pendingCount === this.frameSamples) {
				this.emit(this.takePending());
			}
		}
	}

	/** Flush the partial frame and the optional tail, then close the frame state machine. */
	finish(): void {
		if (this.finished) return;
		this.finished = true;

		const frames: Int16Array[] = [];
		if (this.pendingCount > 0) frames.push(this.takePending());
		const tailFrames = Math.round(this.tailMs / this.frameMs);
		for (let index = 0; index < tailFrames; index += 1) {
			frames.push(new Int16Array(this.frameSamples));
		}

		if (this.wire === "json") {
			// No frame state, so closing is just flushing real audio. The one
			// exception is a session that never sent anything: one silent frame keeps
			// the finish message from being audio-less, and that is the only frame
			// this wire ever synthesises on its own.
			if (frames.length === 0 && !this.started) this.emit(new Int16Array(this.frameSamples));
			for (const frame of frames) this.emit(frame);
			return;
		}

		if (!this.started) {
			// The server rejects a `last` that is not preceded by a `first`, so the
			// very first frame of the session can never be the closing one.
			this.emit(frames.shift() ?? new Int16Array(this.frameSamples), FrameState.first);
		}

		const tail = frames.length === 0 ? [new Int16Array(this.frameSamples)] : frames;
		tail.forEach((frame, index) => {
			this.emit(frame, index === tail.length - 1 ? FrameState.last : undefined);
		});
	}

	private takePending(): Int16Array {
		const frame = new Int16Array(this.frameSamples);
		frame.set(this.pending.subarray(0, this.pendingCount));
		this.pendingCount = 0;
		return frame;
	}

	/** `forced` is only honoured on the protobuf wire; JSON frames carry no state. */
	private emit(samples: Int16Array, forced?: FrameState): void {
		const data =
			this.codec === "opus"
				? this.requireEncoder()(samples)
				: new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
		const state =
			this.wire === "protobuf" ? (forced ?? (this.started ? FrameState.middle : FrameState.first)) : undefined;
		this.started = true;
		this.framesSent += 1;
		this.samplesSent += samples.length;
		this.sink(data, state);
	}

	private requireEncoder(): (pcm: Int16Array) => Uint8Array {
		const encode = this.encode;
		if (encode === undefined) throw new AsrError("config", "framer: the opus codec needs an encoder");
		return encode;
	}
}

function toSamples(input: Int16Array | Uint8Array): Int16Array {
	if (input instanceof Int16Array) return input;
	if (input.byteLength % 2 !== 0) {
		throw new AsrError("config", "framer: PCM byte length must be a multiple of 2");
	}
	// A `Uint8Array` view is not necessarily 2-byte aligned, so copy instead of
	// aliasing. Chunks are <= a few ms of audio, so the copy is free.
	const copy = new Uint8Array(input.byteLength);
	copy.set(input);
	return new Int16Array(copy.buffer);
}

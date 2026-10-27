/**
 * Microphone double, published as `@earendil-works/pi-asr/testing`.
 *
 * `openMicrophone` owns the audio graph and is replaced per test through the
 * controller's `openMic` seam, so nothing here touches Web Audio, permissions,
 * or a device. A host supplies fabricate audio with it instead of stubbing the
 * Web Audio globals, which would test the stub.
 */
import type { Microphone, MicrophoneOptions } from "../mic/capture.ts";

export class FakeMic implements Microphone {
	readonly deviceRate = 48_000;
	readonly options: MicrophoneOptions;
	stopped = false;

	constructor(options: MicrophoneOptions) {
		this.options = options;
	}

	/** Deliver one batch, exactly as the worklet would after resampling. */
	emit(samples: Int16Array): void {
		this.options.onPcm(samples);
	}

	/** The device disappeared on its own (unplugged, taken by another app). */
	end(): void {
		this.options.onEnded?.();
	}

	stop(): Promise<void> {
		this.stopped = true;
		return Promise.resolve();
	}
}

/** 20 ms of speech: loud enough to clear the meter's `speaking` threshold. */
export function speech(samples = 320): Int16Array {
	const out = new Int16Array(samples);
	for (let index = 0; index < samples; index += 1) out[index] = index % 2 === 0 ? 9000 : -9000;
	return out;
}

/** 20 ms of digital silence, which is also what a muted device delivers. */
export function silence(samples = 320): Int16Array {
	return new Int16Array(samples);
}

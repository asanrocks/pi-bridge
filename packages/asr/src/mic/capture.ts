/// <reference lib="dom" />

/**
 * Microphone capture: the physical half of the `push()` seam.
 *
 * The session is audio-source agnostic on purpose — it takes 16 kHz mono PCM and
 * nothing else — so recording is a *provider*, not a layer. This one owns the
 * browser facts a caller should not have to know: `getUserMedia` needs a secure
 * context, the hardware rate is not guaranteed to be 16 kHz, and an audio graph
 * only runs while something is connected downstream.
 *
 * Everything is driven by `onPcm`; there is no event stream, no session, and no
 * protocol knowledge here. Tests replace the three globals it touches.
 */
import { Resampler } from "../audio/resample.ts";
import { SAMPLE_RATE } from "../constants.ts";
import { AsrError } from "../errors.ts";

/** Must match `registerProcessor` in `worklet.js`. */
const WORKLET_NAME = "pi-asr-pcm";
const DEFAULT_BATCH_MS = 20;
const RENDER_QUANTUM = 128;

export interface MicrophoneOptions {
	/** 16 kHz mono PCM as it arrives. Pass `session.push` here. */
	onPcm: (pcm: Int16Array) => void;
	/** Extra `getUserMedia` audio constraints, merged over the mono-mic defaults. */
	audio?: MediaTrackConstraints;
	/**
	 * How much audio one worklet message carries, in ms (default 20). Independent
	 * of the session's `frameMs`: this is the capture cadence, not the wire's.
	 */
	batchMs?: number;
	/**
	 * Overrides the worklet module URL. The default is resolved by the bundler
	 * from `new URL('./worklet.js', import.meta.url)`, which is the file this
	 * package ships and tests; override it only when serving the module from
	 * somewhere else (a strict CSP, a relay, a host that inlines its assets).
	 */
	workletUrl?: string;
	/**
	 * The device disappeared on its own (unplugged, taken by another app). The
	 * microphone is already stopped when this runs; without it a dead device is
	 * indistinguishable from a silent room, because the graph keeps posting zeros.
	 */
	onEnded?: () => void;
}

export interface Microphone {
	/** The rate the browser actually opened, before resampling to 16 kHz. */
	readonly deviceRate: number;
	/** Stop the tracks and close the graph. Idempotent. */
	stop(): Promise<void>;
}

export async function openMicrophone(options: MicrophoneOptions): Promise<Microphone> {
	const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
	if (typeof media?.getUserMedia !== "function") {
		throw new AsrError("unsupported", "mic: getUserMedia is unavailable (a browser in a secure context is required)");
	}
	if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") {
		throw new AsrError("unsupported", "mic: AudioWorklet is unavailable in this browser");
	}

	const stream = await openStream(media, options.audio);
	const tracks = stream.getAudioTracks();
	const stopTracks = (): void => {
		// Null first: `stop()` does not fire `ended`, but a handler left installed
		// would turn an unmount into a spurious "device lost".
		for (const track of tracks) track.onended = null;
		for (const track of stream.getTracks()) track.stop();
	};

	const context = new AudioContext();
	try {
		// A context created outside a user gesture starts suspended, and a
		// suspended graph never calls `process()`.
		if (context.state === "suspended") await context.resume();

		await context.audioWorklet.addModule(options.workletUrl ?? new URL("./worklet.js", import.meta.url).href);

		const resampler = new Resampler(context.sampleRate, SAMPLE_RATE);
		const node = new AudioWorkletNode(context, WORKLET_NAME, {
			processorOptions: {
				batchSamples: batchSamplesFor(context.sampleRate, options.batchMs ?? DEFAULT_BATCH_MS),
			},
		});

		let stopped = false;
		node.port.onmessage = (event: MessageEvent<Float32Array>) => {
			if (stopped) return;
			const pcm = resampler.push(event.data);
			if (pcm.length > 0) options.onPcm(pcm);
		};
		context.createMediaStreamSource(stream).connect(node);
		// The processor writes no output, so this keeps the graph scheduled without
		// echoing the microphone back into the speakers.
		node.connect(context.destination);

		const stop = async (): Promise<void> => {
			if (stopped) return;
			stopped = true;
			node.port.onmessage = null;
			stopTracks();
			node.disconnect();
			await context.close();
		};

		for (const track of tracks) {
			track.onended = () => {
				// The graph survives a vanished device and would post silence forever,
				// so ending it here is the only way the caller learns the truth.
				options.onEnded?.();
				void stop();
			};
		}

		return { deviceRate: context.sampleRate, stop };
	} catch (error) {
		stopTracks();
		await context.close().catch(() => {
			// Already closed, or closed by the failed construction itself.
		});
		throw error instanceof AsrError
			? error
			: new AsrError("capture", "mic: cannot start the audio graph", { cause: error });
	}
}

async function openStream(media: MediaDevices, audio: MediaTrackConstraints | undefined): Promise<MediaStream> {
	try {
		return await media.getUserMedia({
			audio: {
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
				...audio,
			},
		});
	} catch (error) {
		throw captureError(error);
	}
}

/**
 * Permission and hardware failures are actionable but not retryable by the SDK:
 * the user has to allow the microphone or plug one in, so `retryable` is false
 * for those and true for everything transient. Rejected constraints are a
 * configuration mistake rather than a capture failure.
 */
function captureError(error: unknown): AsrError {
	const name = error instanceof DOMException ? error.name : "";
	if (name === "OverconstrainedError") {
		return new AsrError("config", "mic: getUserMedia rejected the audio constraints", {
			cause: error,
			retryable: false,
		});
	}
	const actionable = name === "NotAllowedError" || name === "SecurityError";
	const missing = name === "NotFoundError";
	const suffix = name === "" ? "" : ` (${name})`;
	return new AsrError("capture", `mic: getUserMedia failed${suffix}`, {
		cause: error,
		retryable: !actionable && !missing,
	});
}

/** Round the batch up to whole render quanta so `process()` never straddles one. */
function batchSamplesFor(sampleRate: number, batchMs: number): number {
	const wanted = Math.max(0, Math.round((sampleRate * batchMs) / 1000));
	// Must match the constant in `worklet.js`, which cannot import it. Only the
	// quantum matters for both: the worklet's own buffer is sizes this rounds to.
	return Math.max(RENDER_QUANTUM, Math.round(wanted / RENDER_QUANTUM) * RENDER_QUANTUM);
}

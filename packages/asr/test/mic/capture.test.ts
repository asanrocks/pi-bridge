// The three globals `openMicrophone` touches are replaced per test; the module
// itself has no injection knob, because a knob on the public API would be paid
// for by every caller to suit the tests.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMicrophone } from "../../src/mic/capture.ts";

interface WorkletOptions {
	processorOptions?: { batchSamples?: number };
}

class FakePort {
	onmessage: ((event: MessageEvent<Float32Array>) => void) | null = null;

	emit(samples: Float32Array): void {
		this.onmessage?.({ data: samples } as MessageEvent<Float32Array>);
	}
}

class FakeNode {
	static last: FakeNode | undefined;
	readonly port = new FakePort();
	readonly name: string;
	readonly options: WorkletOptions | undefined;
	connected = false;
	disconnected = false;

	constructor(_context: unknown, name: string, options?: WorkletOptions) {
		this.name = name;
		this.options = options;
		FakeNode.last = this;
	}

	connect(): void {
		this.connected = true;
	}

	disconnect(): void {
		this.disconnected = true;
	}
}

class FakeContext {
	static last: FakeContext | undefined;
	sampleRate = 48_000;
	state = "running";
	readonly destination = {};
	moduleUrl: string | null = null;
	closed = false;
	readonly audioWorklet = {
		addModule: (url: string): Promise<void> => {
			this.moduleUrl = url;
			return Promise.resolve();
		},
	};

	constructor() {
		FakeContext.last = this;
	}

	createMediaStreamSource(): { connect: (node: unknown) => void } {
		return { connect: () => undefined };
	}

	resume(): Promise<void> {
		this.state = "running";
		return Promise.resolve();
	}

	close(): Promise<void> {
		this.closed = true;
		return Promise.resolve();
	}
}

const stubbed: (() => void)[] = [];

function stub(name: string, value: unknown): void {
	const previous = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
	stubbed.push(() => {
		if (previous === undefined) Reflect.deleteProperty(globalThis, name);
		else Object.defineProperty(globalThis, name, previous);
	});
}

interface FakeStream {
	stream: MediaStream;
	stopped: () => boolean;
	/** Simulate the device disappearing: the browser fires `ended`, not us. */
	end: () => void;
}

function fakeStream(): FakeStream {
	let stopped = false;
	const track = {
		onended: null as (() => void) | null,
		stop: () => {
			stopped = true;
		},
		end: () => {
			track.onended?.();
		},
	};
	return {
		stream: {
			getTracks: () => [track],
			getAudioTracks: () => [track],
		} as unknown as MediaStream,
		stopped: () => stopped,
		end: () => {
			track.end();
		},
	};
}

function installAudio(options: { fail?: Error } = {}): {
	calls: { constraints: unknown }[];
	stream: FakeStream;
} {
	const stream = fakeStream();
	const calls: { constraints: unknown }[] = [];
	stub("navigator", {
		mediaDevices: {
			getUserMedia: (constraints: unknown): Promise<MediaStream> => {
				calls.push({ constraints });
				return options.fail === undefined ? Promise.resolve(stream.stream) : Promise.reject(options.fail);
			},
		},
	});
	stub("AudioContext", FakeContext);
	stub("AudioWorkletNode", FakeNode);
	return { calls, stream };
}

beforeEach(() => {
	FakeContext.last = undefined;
	FakeNode.last = undefined;
});

afterEach(() => {
	for (const restore of stubbed.splice(0)) restore();
});

describe("openMicrophone", () => {
	it("resamples the device rate down to 16 kHz mono PCM", async () => {
		installAudio();
		const chunks: Int16Array[] = [];
		const mic = await openMicrophone({ onPcm: (pcm) => chunks.push(pcm) });

		expect(mic.deviceRate).toBe(48_000);
		FakeNode.last?.port.emit(new Float32Array(4800).fill(0.25));

		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toHaveLength(1600);
		expect(chunks[0]?.[0]).toBe(Math.round(0.25 * 0x7fff));
	});

	it("asks for a mono mic and merges caller constraints", async () => {
		const { calls } = installAudio();
		await openMicrophone({ onPcm: () => undefined, audio: { deviceId: "usb" } });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.constraints).toMatchObject({
			audio: { channelCount: 1, echoCancellation: true, deviceId: "usb" },
		});
	});

	it("loads the sibling worklet and batching in whole render quanta", async () => {
		installAudio();
		await openMicrophone({ onPcm: () => undefined, batchMs: 20 });

		expect(FakeContext.last?.moduleUrl).toMatch(/\/worklet\.js$/);
		// 20 ms at 48 kHz is 960 samples, rounded up to 8 quanta.
		expect(FakeNode.last?.options?.processorOptions?.batchSamples).toBe(1024);
	});

	it("lets the caller override the worklet URL", async () => {
		installAudio();
		await openMicrophone({ onPcm: () => undefined, workletUrl: "https://example.test/w.js" });
		expect(FakeContext.last?.moduleUrl).toBe("https://example.test/w.js");
	});

	it("stop() ends the tracks, closes the graph, and ignores later audio", async () => {
		const { stream } = installAudio();
		const chunks: Int16Array[] = [];
		const mic = await openMicrophone({ onPcm: (pcm) => chunks.push(pcm) });

		const node = FakeNode.last;
		await mic.stop();
		await mic.stop(); // idempotent

		expect(stream.stopped()).toBe(true);
		expect(node?.disconnected).toBe(true);
		expect(FakeContext.last?.closed).toBe(true);

		node?.port.emit(new Float32Array(4800).fill(0.5));
		expect(chunks).toHaveLength(0);
	});

	it("reports a vanished device once and closes the graph", async () => {
		const { stream } = installAudio();
		let ended = 0;
		const mic = await openMicrophone({
			onPcm: () => undefined,
			onEnded: () => {
				ended += 1;
			},
		});

		expect(ended).toBe(0);
		stream.end();
		expect(ended).toBe(1);
		expect(stream.stopped()).toBe(true);
		expect(FakeContext.last?.closed).toBe(true);

		// Teardown is not an event: stopping ourselves must not report a loss.
		await mic.stop();
		expect(ended).toBe(1);
	});

	it("classifies rejected constraints as a config error", async () => {
		installAudio({ fail: new DOMException("no 8 channel mic", "OverconstrainedError") });
		await expect(openMicrophone({ onPcm: () => undefined })).rejects.toMatchObject({
			code: "config",
			retryable: false,
		});
	});

	it("reports a missing getUserMedia as unsupported", async () => {
		stub("navigator", {});
		await expect(openMicrophone({ onPcm: () => undefined })).rejects.toMatchObject({
			code: "unsupported",
		});
	});

	it("reports a denied permission as a non-retryable capture error", async () => {
		installAudio({ fail: new DOMException("denied", "NotAllowedError") });

		await expect(openMicrophone({ onPcm: () => undefined })).rejects.toMatchObject({
			code: "capture",
			retryable: false,
		});
		expect(FakeContext.last).toBeUndefined();
	});

	it("reports an unavailable device as non-retryable, a transient failure as retryable", async () => {
		installAudio({ fail: new DOMException("no mic", "NotFoundError") });
		await expect(openMicrophone({ onPcm: () => undefined })).rejects.toMatchObject({
			retryable: false,
		});

		for (const restore of stubbed.splice(0)) restore();
		installAudio({ fail: new Error("device busy") });
		await expect(openMicrophone({ onPcm: () => undefined })).rejects.toMatchObject({
			code: "capture",
			retryable: true,
		});
	});
});

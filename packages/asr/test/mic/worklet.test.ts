/// <reference lib="dom" />

/**
 * The worklet, executed.
 *
 * `src/mic/worklet.js` runs in the audio rendering thread: it is not imported by
 * anything, it is loaded by URL, and no type checker sees it. So the only honest
 * way to cover it is to run the shipped file, in the shape the browser gives it,
 * and assert what it posts. The test reads the file from disk rather than a copy,
 * which is what makes drift impossible — the alternative (a duplicated module
 * behind an import) is the exact failure this file exists to prevent.
 *
 * What is asserted: the batch size is honoured, a full buffer is transferred
 * rather than copied, the samples arrive in order, and a render quantum with no
 * channel does not disturb the accumulator.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src/mic/worklet.js"), "utf8");

interface Posted {
	samples: Float32Array;
	transfer: readonly unknown[];
}

interface Processor {
	process(inputs: Float32Array[][]): boolean;
}

/** One render quantum: `inputs[input][channel]`, mono. */
function quantum(length: number, value: number | ((index: number) => number)): Float32Array[][] {
	const fill = typeof value === "function" ? value : (): number => value;
	return [[Float32Array.from({ length }, (_, index) => fill(index))]];
}

interface Loaded {
	name: string;
	create(options?: { processorOptions?: { batchSamples?: number } }): Processor;
	posted: Posted[];
}

/**
 * Run the shipped module in a scope that looks like the audio worklet global:
 * one class to extend, one registry to fill, one port to post through.
 */
function loadWorklet(): Loaded {
	const posted: Posted[] = [];
	let name = "";
	let registered: (new (options?: unknown) => Processor) | undefined;

	class StubProcessor {
		readonly port = {
			postMessage: (samples: Float32Array, transfer?: readonly unknown[]): void => {
				posted.push({ samples, transfer: transfer ?? [] });
			},
		};
	}

	const register = (processorName: string, processor: new (options?: unknown) => Processor): void => {
		name = processorName;
		registered = processor;
	};

	// A separate realm, because the audio thread is one: the module's declarations
	// cannot leak into this file's scope, and this file's imports are not visible
	// to it — which is also what makes a stray import fail here instead of only in
	// a browser.
	const context = createContext({
		AudioWorkletProcessor: StubProcessor,
		registerProcessor: register,
	});
	runInContext(source, context);

	if (registered === undefined) throw new Error("the worklet registered no processor");
	const ProcessorClass = registered;
	return {
		name,
		create: (options) => new ProcessorClass(options),
		posted,
	};
}

describe("the packed worklet module", () => {
	it("stays standalone: no imports, no module graph", () => {
		// The audio thread has no module resolution beyond this one fetch: an import
		// would fail there and nowhere else, so it is checked here.
		expect(source).not.toMatch(/(?:^|\n)\s*(?:import|export)\b/);
		expect(source).not.toMatch(/\brequire\s*\(/);
	});

	it("registers under the name capture.ts asks for", () => {
		expect(loadWorklet().name).toBe("pi-asr-pcm");
	});

	it("posts one batch per configured size, in order", () => {
		const worklet = loadWorklet();
		const tap = worklet.create({ processorOptions: { batchSamples: 256 } });

		tap.process(quantum(128, (index) => index / 1000));
		expect(worklet.posted).toHaveLength(0);
		tap.process(quantum(128, (index) => (128 + index) / 1000));

		expect(worklet.posted).toHaveLength(1);
		const batch = worklet.posted[0]?.samples;
		expect(batch).toHaveLength(256);
		expect(batch?.[0]).toBeCloseTo(0);
		expect(batch?.[255]).toBeCloseTo(0.255);
	});

	it("transfers the buffer instead of copying it", () => {
		const worklet = loadWorklet();
		const tap = worklet.create({ processorOptions: { batchSamples: 128 } });
		tap.process(quantum(128, 0.5));

		const posted = worklet.posted[0];
		expect(posted?.transfer).toEqual([posted?.samples.buffer]);
		// The next batch gets a fresh buffer, so the posted one is not mutated later.
		tap.process(quantum(128, 0.25));
		expect(posted?.samples[0]).toBeCloseTo(0.5);
	});

	it("floors the batch at one render quantum", () => {
		const worklet = loadWorklet();
		// A caller asking for less than the quantum the graph delivers would wait
		// forever for a full buffer.
		const tap = worklet.create({ processorOptions: { batchSamples: 32 } });
		tap.process(quantum(128, 0.1));
		expect(worklet.posted).toHaveLength(1);
		expect(worklet.posted[0]?.samples).toHaveLength(128);
	});

	it("defaults to about 20 ms at 48 kHz", () => {
		const worklet = loadWorklet();
		const tap = worklet.create();
		for (let rendered = 0; rendered < 8; rendered += 1) {
			tap.process(quantum(128, 0.1));
		}
		expect(worklet.posted).toHaveLength(1);
		expect(worklet.posted[0]?.samples).toHaveLength(1024);
	});

	it("survives a quantum with no input channel, and keeps what it had", () => {
		const worklet = loadWorklet();
		const tap = worklet.create({ processorOptions: { batchSamples: 256 } });

		tap.process(quantum(128, 0.2));
		expect(tap.process([[]])).toBe(true);
		expect(tap.process([])).toBe(true);
		expect(worklet.posted).toHaveLength(0);

		tap.process(quantum(128, 0.3));
		expect(worklet.posted).toHaveLength(1);
		const batch = worklet.posted[0]?.samples;
		expect(batch?.[0]).toBeCloseTo(0.2);
		expect(batch?.[128]).toBeCloseTo(0.3);
	});
});

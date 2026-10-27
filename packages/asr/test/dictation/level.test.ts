import { describe, expect, it } from "vitest";
import { LevelMeter } from "../../src/dictation/level.ts";
import { silence, speech } from "../../src/testing/fake-mic.ts";

describe("LevelMeter", () => {
	it("reads digital silence as zero and never speaks", () => {
		const meter = new LevelMeter();
		expect(meter.push(silence(), 0)).toEqual({ level: 0, speaking: false });
	});

	it("maps full-scale input near 1 and turns speaking on", () => {
		const meter = new LevelMeter();
		const reading = meter.push(speech(), 0);
		expect(reading.level).toBeGreaterThan(0.7);
		expect(reading.level).toBeLessThanOrEqual(1);
		expect(reading.speaking).toBe(true);
	});

	it("decays on release instead of dropping, and clears speaking once quiet", () => {
		const meter = new LevelMeter({ attackMs: 10, releaseMs: 100 });
		meter.push(speech(), 0);
		const first = meter.push(silence(), 1);
		expect(first.level).toBeGreaterThan(0.7);
		expect(first.level).toBeLessThan(0.85);
		expect(first.speaking).toBe(true);

		const later = meter.push(silence(), 1_000);
		expect(later.level).toBeLessThan(0.05);
		expect(later.speaking).toBe(false);
	});

	it("clamps the bar to 0..1 between the dB floor and full scale", () => {
		const meter = new LevelMeter({ floorDb: -40 });
		// 10% of full scale is -20 dBFS, i.e. halfway between -40 dB and 0 dB.
		const quiet = meter.push(new Int16Array(320).fill(3_276), 0);
		expect(quiet.level).toBeCloseTo(0.5, 1);
		// A fresh meter starts at its first measurement instead of ramping up from 0.
		const loud = new LevelMeter({ floorDb: -40 }).push(new Int16Array(320).fill(32_767), 0);
		expect(loud.level).toBeGreaterThan(0.99);
		expect(loud.level).toBeLessThanOrEqual(1);
	});

	it("resets to silence and forgets the last timestamp", () => {
		const meter = new LevelMeter();
		meter.push(speech(), 0);
		meter.reset();
		expect(meter.reading).toEqual({ level: 0, speaking: false });
		// A stale timestamp would decay instead of starting at the measurement.
		expect(meter.push(speech(), 50_000).level).toBeGreaterThan(0.7);
	});
});

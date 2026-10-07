import { describe, expect, it } from "vitest";
import { DEFAULT_ZOOM, PINCH_STEP_RATIO, snapZoom, stepPinch, stepZoom, ZOOM_LADDER } from "./zoom.ts";

describe("snapZoom", () => {
	it("keeps an exact ladder step", () => {
		for (const step of ZOOM_LADDER) expect(snapZoom(step)).toBe(step);
	});

	it("snaps an off-ladder value to the nearest step", () => {
		expect(snapZoom(1.16)).toBe(1.1);
		expect(snapZoom(1.2)).toBe(1.25);
		expect(snapZoom(1.3)).toBe(1.25);
		expect(snapZoom(0.5)).toBe(ZOOM_LADDER[0]);
		expect(snapZoom(99)).toBe(ZOOM_LADDER[ZOOM_LADDER.length - 1]);
	});
});

describe("stepZoom", () => {
	it("advances one rung at a time", () => {
		expect(stepZoom(1, 1)).toBe(1.1);
		expect(stepZoom(1.1, 1)).toBe(1.25);
		expect(stepZoom(1.1, -1)).toBe(1);
	});

	it("clamps at both ends", () => {
		expect(stepZoom(ZOOM_LADDER[0], -1)).toBe(ZOOM_LADDER[0]);
		expect(stepZoom(ZOOM_LADDER[ZOOM_LADDER.length - 1], 1)).toBe(ZOOM_LADDER[ZOOM_LADDER.length - 1]);
	});

	it("treats an arbitrary current value as its nearest step", () => {
		expect(stepZoom(1.12, 1)).toBe(1.25);
		expect(stepZoom(1.12, -1)).toBe(1);
	});
});

describe("stepPinch", () => {
	it("does not step until the gesture travels past the threshold", () => {
		const { direction } = stepPinch(100, 100 * PINCH_STEP_RATIO - 1);
		expect(direction).toBe(0);
	});

	it("steps in when the fingers spread and rebases the reference", () => {
		const spread = 100 * PINCH_STEP_RATIO + 1;
		expect(stepPinch(100, spread)).toEqual({ reference: spread, direction: 1 });
	});

	it("steps out when the fingers close and rebases the reference", () => {
		const closed = 100 / PINCH_STEP_RATIO - 1;
		expect(stepPinch(100, closed)).toEqual({ reference: closed, direction: -1 });
	});

	it("lets a long spread step repeatedly by rebasing between steps", () => {
		let reference = 100;
		const directions: number[] = [];
		for (let i = 0; i < 3; i++) {
			const next = stepPinch(reference, reference * PINCH_STEP_RATIO + 1);
			reference = next.reference;
			directions.push(next.direction);
		}
		expect(directions).toEqual([1, 1, 1]);
	});
});

describe("DEFAULT_ZOOM", () => {
	it("is a ladder step", () => {
		expect(ZOOM_LADDER).toContain(DEFAULT_ZOOM);
	});
});

// Locks the shape the reader relies on: skimming pulls back through fine
// rungs, and enlarging stays short and shallow.
describe("ZOOM_LADDER shape", () => {
	it("is ascending and contains the default", () => {
		expect(ZOOM_LADDER).toEqual([...ZOOM_LADDER].sort((a, b) => a - b));
		expect(ZOOM_LADDER).toContain(DEFAULT_ZOOM);
	});

	it("weights zoom-out over zoom-in and caps the enlargement", () => {
		const out = ZOOM_LADDER.filter((step) => step < DEFAULT_ZOOM);
		const inn = ZOOM_LADDER.filter((step) => step > DEFAULT_ZOOM);
		expect(out.length).toBeGreaterThan(inn.length);
		expect(inn.length).toBeLessThanOrEqual(2);
		expect(Math.max(...inn)).toBeLessThanOrEqual(1.25);
	});
});

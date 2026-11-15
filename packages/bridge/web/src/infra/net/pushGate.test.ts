// The pre-check push gate: frames are held until the build check decides, then
// replayed in arrival order — or dropped, because they belong to a build this
// client cannot read. The one failure is a backlog so deep that the stream's
// beginning is already lost.

import { describe, expect, it } from "vitest";
import type { ServerPushMessage } from "../../../../src/core/index.ts";
import { createPushGate } from "./pushGate.ts";

const frame = (revision: number): ServerPushMessage => ({
	kind: "queue_changed",
	mode: "delta",
	revision,
	upsert: [],
	remove: [],
	invalidateHistory: [],
});

/** Collect what the gate replays, in order. */
function collector(): { applied: number[]; apply: (push: ServerPushMessage) => void } {
	const applied: number[] = [];
	return {
		applied,
		apply: (push) => {
			if (push.kind === "queue_changed") applied.push(push.revision);
		},
	};
}

describe("createPushGate", () => {
	it("holds frames and replays them in arrival order once opened", () => {
		const gate = createPushGate();
		const { applied, apply } = collector();

		expect(gate.route(frame(1), apply)).toBe("held");
		expect(gate.route(frame(2), apply)).toBe("held");
		expect(applied).toEqual([]);

		gate.open(apply);
		expect(applied).toEqual([1, 2]);
	});

	it("passes frames straight through after opening", () => {
		const gate = createPushGate();
		const { applied, apply } = collector();
		gate.open(apply);

		expect(gate.route(frame(3), apply)).toBe("applied");
		expect(applied).toEqual([3]);
	});

	it("replays nothing on a second open", () => {
		// A retry re-runs initialization on a socket whose gate is already open.
		const gate = createPushGate();
		const { applied, apply } = collector();
		gate.route(frame(1), apply);
		gate.open(apply);
		gate.open(apply);
		expect(applied).toEqual([1]);
	});

	it("drops what it held when abandoned", () => {
		const gate = createPushGate();
		const { applied, apply } = collector();
		gate.route(frame(1), apply);
		gate.abandon();

		expect(gate.route(frame(2), apply)).toBe("overflow");
		gate.open(apply);
		expect(applied).toEqual([]);
	});

	it("reports a backlog deeper than its limit", () => {
		const gate = createPushGate(2);
		const { applied, apply } = collector();

		expect(gate.route(frame(1), apply)).toBe("held");
		expect(gate.route(frame(2), apply)).toBe("held");
		expect(gate.route(frame(3), apply)).toBe("overflow");

		gate.open(apply);
		expect(applied).toEqual([]);
	});
});

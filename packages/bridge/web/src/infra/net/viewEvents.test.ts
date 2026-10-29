// viewEvents — the generation rule of the browser view actor (ADR 19): every
// observation event names the attachment that produced it, and only the
// committed attachment's events may become visible.

import { describe, expect, it } from "vitest";
import type { PatchOp, SessionRef } from "../../../../src/core/index.ts";
import { isCurrentGeneration, type ViewObservationEvent, viewGeneration } from "./viewEvents.ts";

const ref: SessionRef = { projectId: "p", sessionId: "s1", stem: "stem" };
const op: PatchOp = { op: "replace", path: "/status/model", value: null };

/** Every event kind at one generation, in delivery order. */
function events(generation: number): ViewObservationEvent[] {
	return [
		{ kind: "initial_sync", generation, ref, ops: null },
		{ kind: "initial_sync", generation, ref, ops: [op], operationId: "op-1" },
		{ kind: "patch", generation, ops: [op] },
		{ kind: "session_closed", generation, projectId: "p", stem: "stem" },
	];
}

describe("viewEvents", () => {
	it("every observation event carries its attachment's generation", () => {
		for (const event of events(3)) {
			expect(viewGeneration(event)).toBe(3);
		}
	});

	it("an event is current only for the committed generation", () => {
		for (const event of events(3)) {
			expect(isCurrentGeneration(3, event)).toBe(true);
			// Older: a stale frame from a superseded attachment — dropped.
			expect(isCurrentGeneration(2, event)).toBe(false);
			// Newer: not the actor's to apply — the owning transition commits it.
			expect(isCurrentGeneration(4, event)).toBe(false);
		}
	});
});

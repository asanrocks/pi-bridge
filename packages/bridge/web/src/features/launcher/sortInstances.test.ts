// Unit tests for the launcher's instance ordering (see sortInstances.ts for
// the rationale: client-owned presentation, daemon stays registry-order).

import { describe, expect, it } from "vitest";
import type { InstanceInfo } from "../../../../src/core/index.ts";
import { sortByLastActivity } from "./sortInstances.ts";

function inst(id: string, lastActivityAt?: string): InstanceInfo {
	return {
		instanceId: id,
		sessionId: `sess-${id}`,
		cwd: "/proj",
		name: id,
		isStreaming: false,
		...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
	};
}

describe("sortByLastActivity", () => {
	it("orders newest activity first", () => {
		const sorted = sortByLastActivity([
			inst("old", "2026-01-01T10:00:00Z"),
			inst("new", "2026-01-01T12:00:00Z"),
			inst("mid", "2026-01-01T11:00:00Z"),
		]);
		expect(sorted.map((i) => i.instanceId)).toEqual(["new", "mid", "old"]);
	});

	it("sorts instances without lastActivityAt last", () => {
		const sorted = sortByLastActivity([
			inst("fresh-no-activity"),
			inst("active", "2026-01-01T10:00:00Z"),
			inst("also-fresh"),
		]);
		expect(sorted.map((i) => i.instanceId)).toEqual(["active", "fresh-no-activity", "also-fresh"]);
	});

	it("sorts instances with an invalid timestamp last", () => {
		const sorted = sortByLastActivity([inst("bad", "not-a-date"), inst("good", "2026-01-01T10:00:00Z")]);
		expect(sorted.map((i) => i.instanceId)).toEqual(["good", "bad"]);
	});

	it("keeps input order for equal timestamps (stable)", () => {
		const sorted = sortByLastActivity([
			inst("a", "2026-01-01T10:00:00Z"),
			inst("b", "2026-01-01T10:00:00Z"),
			inst("c", "2026-01-01T10:00:00Z"),
		]);
		expect(sorted.map((i) => i.instanceId)).toEqual(["a", "b", "c"]);
	});

	it("does not mutate the input array", () => {
		const input = [inst("old", "2026-01-01T10:00:00Z"), inst("new", "2026-01-01T11:00:00Z")];
		sortByLastActivity(input);
		expect(input.map((i) => i.instanceId)).toEqual(["old", "new"]);
	});
});

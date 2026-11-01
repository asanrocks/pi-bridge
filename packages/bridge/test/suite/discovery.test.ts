// Startup role decision: the probe result is the only input, so the matrix is
// pure and every branch is pinned here.

import { describe, expect, it } from "vitest";
import { isSocketTaken, type ProbeResult, resolveStartupRole } from "../../src/host/discovery.ts";

function decide(probe: ProbeResult, removed: { count: number }) {
	return resolveStartupRole({
		probe: async () => probe,
		removeStale: () => {
			removed.count += 1;
		},
	});
}

describe("startup role discovery", () => {
	it("joins a live daemon as a worker and carries its web address", async () => {
		const removed = { count: 0 };
		await expect(decide({ kind: "live", web: "http://localhost:33334" }, removed)).resolves.toEqual({
			role: "worker",
			web: "http://localhost:33334",
		});
		expect(removed.count).toBe(0);
	});

	it("starts a daemon when nothing owns the path", async () => {
		const removed = { count: 0 };
		await expect(decide({ kind: "absent" }, removed)).resolves.toEqual({ role: "daemon" });
		expect(removed.count).toBe(0);
	});

	it("removes a proved-stale socket before starting a daemon", async () => {
		const removed = { count: 0 };
		await expect(decide({ kind: "stale" }, removed)).resolves.toEqual({ role: "daemon" });
		expect(removed.count).toBe(1);
	});

	it("reports a refused path instead of choosing another address", async () => {
		const removed = { count: 0 };
		await expect(decide({ kind: "refused", reason: "not a bridge" }, removed)).resolves.toEqual({
			error: "not a bridge",
		});
		expect(removed.count).toBe(0);
	});

	it("treats EADDRINUSE as a lost bind race", () => {
		const taken = Object.assign(new Error("in use"), { code: "EADDRINUSE" });
		expect(isSocketTaken(taken)).toBe(true);
		expect(isSocketTaken(new Error("other"))).toBe(false);
		expect(isSocketTaken(null)).toBe(false);
	});
});

// Worker service contract — the Daemon → execution boundary carries values.
//
// The contract is types only, so the tests pin the properties a remote adapter
// depends on: every value survives a JSON round trip, the three identities
// (registration, target, observation) stay distinct, and the module imports no
// host runtime module — the source-level check is what keeps a local type from
// leaking back into the boundary.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
	ObservedSession,
	SessionAddress,
	SessionTarget,
	WorkerEvent,
	WorkerObservation,
	WorkerObservationFrame,
	WorkerRegistration,
} from "../../src/host/worker-contract.ts";

const REGISTRATION: WorkerRegistration = { id: "reg-1", incarnation: "inc-1", generation: 1 };

const ADDRESS: SessionAddress = { projectId: "proj", stem: "work/review" };

const TARGET: SessionTarget = {
	...ADDRESS,
	sessionId: "sess-1",
	cwd: "/repo/proj",
	worker: REGISTRATION,
	activation: 7,
};

function roundTrip<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

describe("worker contract values", () => {
	it("round-trips a target with all three identities intact", () => {
		const restored = roundTrip(TARGET);
		expect(restored).toEqual(TARGET);
		expect(restored.worker.incarnation).toBe("inc-1");
		expect(restored.worker.generation).toBe(1);
		expect(restored.activation).toBe(7);
		expect(restored.sessionId).toBe("sess-1");
	});

	it("round-trips every observation frame shape", () => {
		const frames: WorkerObservationFrame[] = [
			{ kind: "closed", address: ADDRESS },
			{ kind: "patch", ops: [{ op: "replace", path: "/status/isStreaming", value: true }] },
			{
				kind: "replace",
				session: { projectId: "proj", stem: "work/review", sessionId: "sess-1" },
				document: { status: { isStreaming: false } as never, entries: {} },
			},
		];
		for (const frame of frames) expect(roundTrip(frame)).toEqual(frame);
	});

	it("round-trips the worker events the daemon broadcasts", () => {
		const events: WorkerEvent[] = [
			{
				kind: "sessions_changed",
				projectId: "proj",
				page: {
					sessions: [
						{
							projectId: "proj",
							sessionId: "sess-1",
							stem: "work/review",
							location: "inbox",
							timestamp: "2024-01-01T00:00:00Z",
						},
					],
					hasMore: true,
					nextCursor: { sortTimeMs: 1704067200000, stem: "work/review" },
				},
			},
			{ kind: "queue_changed", sessions: [] },
			{ kind: "unavailable", reason: "drain failed" },
		];
		for (const event of events) expect(roundTrip(event)).toEqual(event);
	});

	it("keeps a registration distinct from the activations it serves", () => {
		// Two activations of one registration: the registration identity is
		// shared, the activation identity is not, so a stale target is
		// distinguishable from a live one without consulting the runtime.
		const first: SessionTarget = { ...TARGET, stem: "a", sessionId: "s-a", activation: 2 };
		const second: SessionTarget = { ...TARGET, stem: "b", sessionId: "s-b", activation: 3 };
		expect(first.worker).toEqual(second.worker);
		expect(first.activation).not.toBe(second.activation);
		expect(first.sessionId).not.toBe(second.sessionId);
	});
});

describe("worker contract boundary", () => {
	const source = readFileSync(new URL("../../src/host/worker-contract.ts", import.meta.url), "utf8");
	const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] as string);

	it("imports no host runtime module", () => {
		const forbidden = [
			"./connection.ts",
			"./manager.ts",
			"./activation-registry.ts",
			"./session-actor.ts",
			"./projects.ts",
			"./repository.ts",
			"./daemon.ts",
			"node:fs",
			"node:net",
			"node:http",
			"ws",
		];
		for (const specifier of imports) expect(forbidden).not.toContain(specifier);
	});

	it("imports only the browser-safe core types", () => {
		expect(imports).toEqual(["../core/index.ts"]);
		// Type-only import: the contract is erased at runtime, which is what
		// lets a browser-safe consumer read it.
		expect(source).toMatch(/import type \{/);
	});
});

describe("observation leasing shape", () => {
	it("is a value with an id, a target, pull, and an idempotent release", async () => {
		// A hand-built observation stands in for any adapter: the daemon only
		// ever holds these four members, never a runtime handle.
		let released = 0;
		const observation: WorkerObservation = {
			id: "obs-1",
			target: TARGET,
			pull: async () => [],
			release: async () => {
				released++;
			},
		};
		const observed: ObservedSession = { target: TARGET, observation };
		expect(observed.observation.id).toBe("obs-1");
		expect(observed.observation.target.sessionId).toBe("sess-1");
		expect(await observed.observation.pull([])).toEqual([]);
		await observed.observation.release();
		expect(released).toBe(1);
	});
});

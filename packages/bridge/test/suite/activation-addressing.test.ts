// Activation addressing — the registry's one job (ADR 19): the address and
// durable-session-id indexes, creation reservation, and replacement/close
// coordination. These tests pin the exclusivity matrix the index must hold
// under interleaving: concurrent opens share one creation, an open arriving
// during teardown waits for the completed disposal before creating, the
// address stays reserved until the actor's close and the cleanup both
// finish, a stale record can neither dispose a replacement nor release its
// durable-id claim, and a shutdown drain owns a factory that completes
// mid-drain. Never two live Managers for one address or one durable id.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Document } from "../../src/core/index.ts";
import { type ActivationRecord, ActivationRegistry } from "../../src/host/activation-registry.ts";
import type { ConnectionHandle, Manager } from "../../src/host/manager.ts";
import type { ProjectConfig } from "../../src/host/projects.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface GatedStub {
	manager: Manager;
	/** True once `dispose()` was entered. */
	disposeEntered: () => boolean;
	/** Allow a held `dispose()` to finish. */
	finishDispose: () => void;
	disposeCount: () => number;
}

/** A Manager stand-in whose `dispose()` is optional gated. The Session actor
 * wires `onPatch`/`onSettled` at construction, so both must exist. */
function gatedStub(sessionId: string, sessionFile: string, opts?: { holdDispose?: boolean }): GatedStub {
	let entered = false;
	let count = 0;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const connectionHandles = new Set<ConnectionHandle>();
	const document = {
		status: { isStreaming: false, isCompacting: false },
		entries: {},
	} as unknown as Document;
	const manager = {
		document,
		liveSessionId: sessionId,
		cwd: "/proj",
		sessionFile,
		createdAt: new Date(0).toISOString(),
		onPatch: () => () => {},
		onSettled: () => () => {},
		activity: () => ({ phase: "idle" as const, tool: null, recoverable: false }),
		onActivityChange: () => () => {},
		addConnection(handle: ConnectionHandle, session: Parameters<Manager["addConnection"]>[1]) {
			connectionHandles.add(handle);
			handle.onInitialSync({ kind: "replace", session, document });
		},
		removeConnection(handle: ConnectionHandle) {
			connectionHandles.delete(handle);
		},
		prompt: async () => {},
		promptAdmitted: async () => {},
		executeBash: async () => {},
		abort: async () => {},
		discardSteer: async () => {},
		compact: async () => ({ tokensBefore: 0, estimatedTokensAfter: 0 }),
		setModel: async () => {},
		setThinkingLevel: async () => {},
		renameSession: async () => {},
		setLabel: async () => {},
		navigate: async () => {},
		recoverTurn: async () => "retry" as const,
		dispose: async () => {
			entered = true;
			count++;
			if (opts?.holdDispose) await gate;
		},
	} as unknown as Manager;
	return {
		manager,
		disposeEntered: () => entered,
		finishDispose: () => release?.(),
		disposeCount: () => count,
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `cond` holds (host-side state, not frames). */
function waitFor(cond: () => boolean, what: string, timeout = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		if (cond()) return resolve();
		const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeout);
		const interval = setInterval(() => {
			if (cond()) {
				clearTimeout(timer);
				clearInterval(interval);
				resolve();
			}
		}, 5);
	});
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

interface Harness {
	registry: ActivationRegistry;
	project: ProjectConfig;
	/** The stubs the factory produced, in creation order. */
	managers: GatedStub[];
	/** Reserve `stem`, routing the factory to `stub` (optionally holding the
	 * factory itself before it produces the stub). */
	reserveWith(stem: string, stub: GatedStub, opts?: { holdFactory?: Promise<void> }): Promise<ActivationRecord>;
	writeFile(stem: string): string;
}

function makeHarness(): Harness {
	const root = join(tmpdir(), `pi-bridge-addr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const sessionDir = join(root, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const project: ProjectConfig = { id: "proj", cwd: root, sessionDir };
	const managers: GatedStub[] = [];
	let next: GatedStub | null = null;
	let factoryHold: Promise<void> | null = null;
	const registry = new ActivationRegistry({
		incarnation: "test",
		createManager: async (_project, stem, abs) => {
			if (factoryHold !== null) {
				const hold = factoryHold;
				factoryHold = null;
				await hold;
			}
			const stub = next ?? gatedStub(stem, abs);
			next = null;
			managers.push(stub);
			return stub.manager;
		},
		idleGcMs: 60_000,
		unflushedIdleGcMs: 60_000,
		onSettled: () => {},
		onStreamingChange: () => {},
		onRegistryChange: () => {},
	});
	const writeFile = (stem: string): string => {
		const abs = join(sessionDir, `${stem}.jsonl`);
		writeFileSync(abs, "");
		return abs;
	};
	return {
		registry,
		project,
		managers,
		reserveWith: (stem, stub, opts) => {
			next = stub;
			factoryHold = opts?.holdFactory ?? null;
			return registry.reserve(project, stem, writeFile(stem));
		},
		writeFile,
	};
}

// ---------------------------------------------------------------------------
// The exclusivity matrix
// ---------------------------------------------------------------------------

describe("address exclusivity", () => {
	it("concurrent opens of one address share one creation", async () => {
		const h = makeHarness();
		const abs = h.writeFile("shared");
		const first = h.registry.reserve(h.project, "shared", abs);
		const second = h.registry.reserve(h.project, "shared", abs);
		const [a, b] = await Promise.all([first, second]);
		expect(a).toBe(b);
		expect(h.managers.length).toBe(1);
		await h.registry.dispose();
	});

	it("an open arriving during teardown waits for the completed disposal", async () => {
		const h = makeHarness();
		// The dying runtime holds its disposal open: the address reservation
		// must outlast it.
		const stubA = gatedStub("x", h.writeFile("x"), { holdDispose: true });
		const recordA = await h.reserveWith("x", stubA);

		const closing = h.registry.collect(recordA);
		await h.registry.awaitSettled("proj", "x");
		await waitFor(stubA.disposeEntered, "the dying runtime's disposal to begin");

		const stubB = gatedStub("x", h.writeFile("x"));
		const reopening = h.reserveWith("x", stubB);
		await delay(5);
		// The reservation has not created a second Manager: the first is
		// still disposing under the address's reservation.
		expect(h.managers.length).toBe(1);

		stubA.finishDispose();
		await closing;
		const recordB = await reopening;
		expect(h.managers.length).toBe(2);
		expect(recordB).not.toBe(recordA);
		// The first Manager died exactly once, and the replacement is live.
		expect(stubA.disposeCount()).toBe(1);
		expect(h.registry.byAddressLive("proj", "x")).toBe(recordB);
		await h.registry.dispose();
	});

	it("a stale record can neither dispose a replacement nor release its durable-id claim", async () => {
		const h = makeHarness();
		const stubA = gatedStub("dup", h.writeFile("x"), { holdDispose: true });
		const recordA = await h.reserveWith("x", stubA);
		const closing = h.registry.collect(recordA);
		await h.registry.awaitSettled("proj", "x");
		stubA.finishDispose();
		await closing;

		// The replacement registration claims the same durable id.
		const stubB = gatedStub("dup", h.writeFile("x"));
		const recordB = await h.reserveWith("x", stubB);

		// A late collect holding the stale record owns nothing: it must not
		// dispose the replacement or drop its claim.
		await h.registry.collect(recordA);
		expect(stubB.disposeCount()).toBe(0);
		expect(h.registry.byAddressLive("proj", "x")).toBe(recordB);

		// The claim is still exclusive to the replacement: another address
		// cannot open the same durable session id.
		const colliding = gatedStub("dup", h.writeFile("y"));
		await expect(h.reserveWith("y", colliding)).rejects.toThrow(/already addressed as proj\/x/);
		await h.registry.dispose();
	});

	it("a durable session id is claimed by only one address", async () => {
		const h = makeHarness();
		await h.reserveWith("x", gatedStub("dup", h.writeFile("x")));
		await expect(h.reserveWith("y", gatedStub("dup", h.writeFile("y")))).rejects.toThrow(
			/Session id is already addressed as proj\/x/,
		);
		await h.registry.dispose();
	});

	it("awaitSettled sees a creation still in flight", async () => {
		const h = makeHarness();
		let releaseFactory: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseFactory = resolve;
		});
		const stub = gatedStub("slow", h.writeFile("slow"));
		const opened = h.reserveWith("slow", stub, { holdFactory: gate });

		const settled = h.registry.awaitSettled("proj", "slow");
		let settledDone = false;
		void settled.then(() => {
			settledDone = true;
		});
		await delay(5);
		// The pending creation holds the address: address-mutating operations
		// must wait for it, not act on the empty registered state.
		expect(settledDone).toBe(false);

		releaseFactory?.();
		const record = await opened;
		await settled;
		expect(h.registry.byAddressAny("proj", "slow")).toBe(record);
		await h.registry.dispose();
	});

	it("a shutdown drain disposes a Manager whose factory completed mid-drain", async () => {
		const h = makeHarness();
		let releaseFactory: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseFactory = resolve;
		});
		const stub = gatedStub("mid", h.writeFile("mid"));
		const opened = h.reserveWith("mid", stub, { holdFactory: gate });
		const draining = h.registry.dispose();

		releaseFactory?.();
		// The registration is refused under shutdown, and the refused
		// creation disposes the Manager it produced inside the tracked
		// operation the drain awaits.
		await expect(opened).rejects.toThrow(/shutting down/);
		await draining;
		expect(stub.disposeCount()).toBe(1);
		expect(h.registry.byAddressAny("proj", "mid")).toBeUndefined();
	});
});

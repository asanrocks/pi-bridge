// Session actor (ADR 19) — the one owner of one Session's runtime lifetime.
// These tests pin the actor's four load-bearing contract properties plus the
// admission classes and the terminal boundary it absorbed from
// session-execution.ts (mutations serialize; immediate work never queues;
// `close` is the one disposal path):
//   - a command admitted by a capability completes against the runtime it
//     captured, even when the capability is released while it runs;
//   - observation release is idempotent and per-observation;
//   - the terminal boundary is joinable — a second caller awaits the same
//     drain, and the runtime is disposed exactly once;
//   - after a release or the terminal boundary nothing is admitted, and no
//     event reaches a released observer.

import { describe, expect, it } from "vitest";
import type { Document, SessionRef } from "../../src/core/index.ts";
import type { ConnectionHandle, Manager } from "../../src/host/manager.ts";
import { createSessionActor, type SessionActor } from "../../src/host/session-actor.ts";

const REF: SessionRef = { projectId: "p", sessionId: "s1", stem: "stem" };
const AUTHORIZATION = { incarnation: "inc", generation: 1 };

function tick(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A runtime stub with the facts these contracts exercise: observation
 * handles (installed once per observer, each receiving the initial sync at
 * registration and patches while installed) and a counted disposal whose
 * final patch lands while observers are still installed — the ordering the
 * actor's close must preserve. */
function stubManager(): Manager & {
	log: string[];
	emitPatch(): void;
	disposeCount(): number;
} {
	const log: string[] = [];
	const handles = new Set<ConnectionHandle>();
	let disposed = 0;
	const base = {
		document: { status: { isStreaming: false, isCompacting: false }, entries: {} } as unknown as Document,
		liveSessionId: "s1",
		cwd: "/proj",
		sessionFile: "/proj/s1.jsonl",
		createdAt: new Date(0).toISOString(),
		onPatch: () => () => {},
		addConnection(handle: ConnectionHandle) {
			handles.add(handle);
			log.push("add");
			handle.onInitialSync({ kind: "replace", session: REF, document: base.document });
		},
		removeConnection(handle: ConnectionHandle) {
			handles.delete(handle);
			log.push("remove");
		},
		onSettled: () => () => {},
		onFullySettled: () => () => {},
		activity: () => ({ phase: "idle" as const, tool: null, recoverable: false }),
		onActivityChange: () => () => {},
		prompt: async () => {},
		promptAdmitted: async () => {},
		executeBash: async () => {},
		abort: async () => {},
		discardSteer: async () => {},
		setModel: async () => {},
		setThinkingLevel: async () => {},
		renameSession: async () => {},
		setLabel: async () => {},
		navigate: async () => {},
		recoverTurn: async () => "retry" as const,
		dispose: async () => {
			disposed++;
			// The teardown's final patch: delivered while observers are still
			// installed, before the drain releases them.
			for (const handle of handles) handle.onPatch({ ops: [] });
		},
	};
	return {
		...base,
		log,
		emitPatch: () => {
			for (const handle of handles) handle.onPatch({ ops: [] });
		},
		disposeCount: () => disposed,
	} as unknown as Manager & { log: string[]; emitPatch(): void; disposeCount(): number };
}

function observerFor(log: string[]): ConnectionHandle {
	return {
		onPatch: () => log.push("patch"),
		onInitialSync: () => log.push("initial-sync"),
	};
}

function actorFor(manager: Manager): SessionActor {
	return createSessionActor({ manager, ref: REF, authorization: AUTHORIZATION });
}

describe("SessionActor admission", () => {
	it("runs commands and mutations against the runtime and resolves their values", async () => {
		const actor = actorFor(stubManager());
		const capability = actor.capability();
		await expect(capability.command(async (session) => session.cwd)).resolves.toBe("/proj");
		await expect(capability.mutate(async () => "mutated")).resolves.toBe("mutated");
	});

	it("admits a prompt at preflight instead of holding the reply for the turn", async () => {
		const calls: string[] = [];
		const manager = stubManager();
		// The completion form is the turn itself: a reply that waited on it would
		// pin every send to the run's lifetime (ADR 12 Reply semantics).
		manager.prompt = () => {
			calls.push("turn");
			return new Promise<void>(() => {});
		};
		manager.promptAdmitted = async (text: string) => {
			calls.push(`admit:${text}`);
		};
		const actor = actorFor(manager);

		await expect(actor.admission().prompt("hello")).resolves.toBeUndefined();
		expect(calls).toEqual(["admit:hello"]);
	});

	it("serializes mutations: one at a time, in admission order", async () => {
		const actor = actorFor(stubManager());
		const capability = actor.capability();
		const order: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = capability.mutate(async () => {
			order.push("first:start");
			await blocked;
			order.push("first:end");
		});
		const second = capability.mutate(async () => {
			order.push("second");
		});
		await tick();
		expect(order).toEqual(["first:start"]);
		releaseFirst?.();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("runs immediate work while a mutation is in flight (a read never queues)", async () => {
		const actor = actorFor(stubManager());
		const capability = actor.capability();
		const order: string[] = [];
		let releaseMutation: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			releaseMutation = resolve;
		});
		const mutation = capability.mutate(async () => {
			await blocked;
			order.push("mutation");
		});
		await capability.command(async () => {
			order.push("read");
		});
		expect(order).toEqual(["read"]);
		releaseMutation?.();
		await mutation;
		expect(order).toEqual(["read", "mutation"]);
	});

	it("turns a synchronous operation throw into a rejected command", async () => {
		// Admission is promise-shaped: an operation that fails before returning
		// its promise must reject — escaping as a synchronous throw would bypass
		// the tracked-work accounting and break callers that only handle
		// rejections.
		const actor = actorFor(stubManager());
		await expect(
			actor.capability().command(() => {
				throw new Error("operation failed");
			}),
		).rejects.toThrow("operation failed");
	});

	it("a command admitted before release completes against the runtime it captured", async () => {
		const actor = actorFor(stubManager());
		const capability = actor.capability();
		let releaseWork: (() => void) | undefined;
		const admitted = capability.command(async (session) => {
			await new Promise<void>((resolve) => {
				releaseWork = resolve;
			});
			return session.cwd;
		});
		await capability.release();
		// Admitted while the registration was live: it settles with its own
		// outcome against the runtime it captured, so the reply describes the
		// session that was attached when the request arrived.
		releaseWork?.();
		await expect(admitted).resolves.toBe("/proj");
		await expect(capability.command(() => Promise.resolve("late"))).rejects.toThrow("session is closed");
	});
});

describe("SessionActor observations", () => {
	it("observe emits the initial sync once; observation release is idempotent and stops delivery", async () => {
		const manager = stubManager();
		const actor = actorFor(manager);
		const log: string[] = [];
		const observation = actor.capability().observe(observerFor(log), null);
		expect(log).toEqual(["initial-sync"]);
		expect(manager.log).toEqual(["add"]);
		await observation.release();
		await observation.release();
		expect(manager.log).toEqual(["add", "remove"]);
		manager.emitPatch();
		expect(log).toEqual(["initial-sync"]);
	});

	it("observations are independent: releasing one leaves the others delivering", async () => {
		const manager = stubManager();
		const actor = actorFor(manager);
		const first = actor.capability();
		const second = actor.capability();
		const firstLog: string[] = [];
		const secondLog: string[] = [];
		const observation = first.observe(observerFor(firstLog), null);
		second.observe(observerFor(secondLog), null);
		await observation.release();
		expect(firstLog).toEqual(["initial-sync"]);
		expect(secondLog).toEqual(["initial-sync"]);
		manager.emitPatch();
		expect(firstLog).toEqual(["initial-sync"]);
		expect(secondLog).toEqual(["initial-sync", "patch"]);
		// One observation's release is not the registration's end: commands and
		// fresh observations stay admitted.
		await expect(first.command(async (session) => session.cwd)).resolves.toBe("/proj");
		expect(() => first.observe(observerFor([]), null)).not.toThrow();
	});

	it("capability release ends admission and every observation, and disposes nothing", async () => {
		const manager = stubManager();
		const actor = actorFor(manager);
		const capability = actor.capability();
		const firstLog: string[] = [];
		const secondLog: string[] = [];
		capability.observe(observerFor(firstLog), null);
		capability.observe(observerFor(secondLog), null);
		await capability.release();
		await capability.release();
		expect(manager.log).toEqual(["add", "add", "remove", "remove"]);
		manager.emitPatch();
		expect(firstLog).toEqual(["initial-sync"]);
		expect(secondLog).toEqual(["initial-sync"]);
		await expect(capability.command(() => Promise.resolve("late"))).rejects.toThrow("session is closed");
		// Release ends the attachment, not the Session: idle collection owns
		// disposal, and the runtime outlives the client that left.
		expect(manager.disposeCount()).toBe(0);
		expect(actor.phase).toBe("live");
	});

	it("observe rejects once the registration ended or the terminal boundary began", async () => {
		const released = actorFor(stubManager());
		const capability = released.capability();
		capability.observe(observerFor([]), null);
		await capability.release();
		expect(() => capability.observe(observerFor([]), null)).toThrow("session is closed");

		const terminal = actorFor(stubManager());
		const ending = terminal.close();
		expect(terminal.phase).toBe("closing");
		expect(() => terminal.capability().observe(observerFor([]), null)).toThrow("session is closed");
		await ending;
	});
});

describe("SessionActor idle collection", () => {
	function idleActor(manager: Manager, idleGcMs: number, unflushedIdleGcMs = idleGcMs) {
		let idle = 0;
		const actor = createSessionActor({
			manager,
			ref: REF,
			authorization: AUTHORIZATION,
			idleGcMs,
			unflushedIdleGcMs,
			onIdle: () => {
				idle++;
			},
		});
		return { actor, idleCount: () => idle };
	}

	it("arms when the last capability leaves; a fresh capability cancels it", async () => {
		const { actor, idleCount } = idleActor(stubManager(), 20);
		await actor.capability().release();
		// A fresh client arrives before the delay elapses: the pending idle
		// collection is cancelled — a live capability is an attached client.
		const again = actor.capability();
		await delay(50);
		expect(idleCount()).toBe(0);
		await again.release();
		await delay(60);
		expect(idleCount()).toBe(1);
	});

	it("defers while the runtime is streaming, then reports idle", async () => {
		const manager = stubManager();
		const { actor, idleCount } = idleActor(manager, 20);
		manager.document.status.isStreaming = true;
		await actor.capability().release();
		await delay(60);
		expect(idleCount()).toBe(0); // deferred and re-armed
		manager.document.status.isStreaming = false;
		await delay(60);
		expect(idleCount()).toBe(1);
	});

	it("an entry-bearing unflushed runtime waits the longer delay", async () => {
		const manager = stubManager();
		const { actor, idleCount } = idleActor(manager, 20, 200);
		(manager.document.entries as Record<string, unknown>).e1 = { id: "e1" };
		await actor.capability().release();
		await delay(80);
		expect(idleCount()).toBe(0); // the short delay passed; the long one has not
		await delay(200);
		expect(idleCount()).toBe(1);
	});

	it("armIdle covers a registration that never attached a client", async () => {
		const { actor, idleCount } = idleActor(stubManager(), 20);
		actor.armIdle();
		await delay(60);
		expect(idleCount()).toBe(1);
	});

	it("close cancels the idle timer and idle is never reported afterwards", async () => {
		const { actor, idleCount } = idleActor(stubManager(), 20);
		actor.armIdle();
		await actor.close();
		await delay(60);
		expect(idleCount()).toBe(0);
		expect(actor.phase).toBe("closed");
	});
});

describe("SessionCapability typed verbs", () => {
	it("route through admission and reject once the actor closed", async () => {
		const actor = actorFor(stubManager());
		const capability = actor.capability();
		await expect(capability.prompt("hello")).resolves.toBeUndefined();
		await expect(capability.abort()).resolves.toBeUndefined();
		await expect(capability.discardSteer()).resolves.toBeUndefined();
		await expect(capability.renameSession("name")).resolves.toBeUndefined();
		await expect(capability.setLabel("e1", "label")).resolves.toBeUndefined();
		await expect(capability.navigate("e1")).resolves.toBeUndefined();
		await expect(capability.recoverTurn()).resolves.toBe("retry");
		expect(capability.cwd).toBe("/proj");
		await actor.close();
		await expect(capability.prompt("late")).rejects.toThrow("session is closed");
		await expect(capability.renameSession("late")).rejects.toThrow("session is closed");
	});

	it("pull reads values through the actor and reports live fields", async () => {
		const manager = stubManager();
		const capability = actorFor(manager).capability();
		const entries = manager.document.entries as Record<string, unknown>;
		entries.live = { id: "live", isSealed: false };
		entries.sealed = { id: "sealed" };
		const values = await capability.pull([
			{ entryId: "live", fieldPath: "/entries/live/id" },
			{ entryId: "sealed", fieldPath: "/entries/sealed/id" },
			{ entryId: "missing", fieldPath: "/entries/missing/id" },
		]);
		// A live (unsealed) value streams further updates; a sealed one is
		// one-shot; a missing entry is skipped, not an error.
		expect(values).toEqual([
			{ entryId: "live", fieldPath: "/entries/live/id", value: "live", live: true },
			{ entryId: "sealed", fieldPath: "/entries/sealed/id", value: "sealed", live: false },
		]);
	});
});

describe("SessionActor terminal boundary", () => {
	it("is joinable: one drain, one disposal, admitted work awaited", async () => {
		const manager = stubManager();
		const actor = actorFor(manager);
		const capability = actor.capability();
		let releaseWork: (() => void) | undefined;
		const admitted = capability.command(async () => {
			await new Promise<void>((resolve) => {
				releaseWork = resolve;
			});
		});
		expect(actor.phase).toBe("live");
		const closing = actor.close();
		const joining = actor.close();
		await expect(capability.command(() => Promise.resolve("late"))).rejects.toThrow("session is closed");
		// The runtime is disposed exactly once; the drain still waits for the
		// work admitted before it began.
		expect(manager.disposeCount()).toBe(1);
		releaseWork?.();
		await Promise.all([admitted, closing, joining]);
		expect(manager.disposeCount()).toBe(1);
		expect(actor.phase).toBe("closed");
		// The memoized drain: a later close observes the same teardown.
		await actor.close();
		expect(actor.phase).toBe("closed");
	});

	it("a mutation admitted before close completes; one queued after rejects", async () => {
		const actor = actorFor(stubManager());
		const capability = actor.capability();
		const order: string[] = [];
		let releaseMutation: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			releaseMutation = resolve;
		});
		const admitted = capability.mutate(async () => {
			await blocked;
			order.push("admitted");
		});
		// Admitted while the actor was live: it runs during the drain.
		const closing = actor.close();
		await expect(capability.mutate(async () => order.push("queued"))).rejects.toThrow("session is closed");
		releaseMutation?.();
		await admitted;
		await closing;
		expect(order).toEqual(["admitted"]);
	});

	it("releases every observation after the drain, so the final patches land first", async () => {
		const manager = stubManager();
		const actor = actorFor(manager);
		const capability = actor.capability();
		const log: string[] = [];
		capability.observe(observerFor(log), null);
		await actor.close();
		// The teardown's final patch was delivered while the observer was still
		// installed (before the drain released it) — and nothing reaches the
		// observer after the actor's teardown completed.
		expect(log).toEqual(["initial-sync", "patch"]);
		manager.emitPatch();
		expect(log).toEqual(["initial-sync", "patch"]);
		expect(manager.log).toEqual(["add", "remove"]);
	});
});

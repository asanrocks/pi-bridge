// Session actor contracts (ADR 19) — the characterization suite for the
// capability seam. These tests pin the four properties the actor refactor
// must preserve, exercised through `createSessionCapability` over today's
// machinery (SessionExecution admission, runtime observation handles), so
// the actor can replace the machinery behind the same seam without moving
// these assertions:
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
import { createSessionCapability } from "../../src/host/session-actor.ts";
import { createSessionExecution, type SessionExecution } from "../../src/host/session-execution.ts";

const REF: SessionRef = { projectId: "p", sessionId: "s1", stem: "stem" };
const AUTHORIZATION = { incarnation: "inc", generation: 1 };

/** A runtime stub with the two facts these contracts exercise: observation
 * handles (installed once per observer, each receiving the initial sync at
 * registration and patches while installed) and a counted disposal. */
function stubManager(): Manager & { log: string[]; emitPatch(): void; disposeCount(): number } {
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

function capabilityFor(manager: Manager): ReturnType<typeof createSessionCapability> & { execution: SessionExecution } {
	const execution = createSessionExecution(manager);
	return Object.assign(createSessionCapability({ execution, ref: REF, authorization: AUTHORIZATION }), {
		execution,
	});
}

describe("SessionCapability", () => {
	it("runs commands and mutations against the runtime and resolves their values", async () => {
		const capability = capabilityFor(stubManager());
		await expect(capability.command(async (session) => session.cwd)).resolves.toBe("/proj");
		await expect(capability.mutate(async () => "mutated")).resolves.toBe("mutated");
	});

	it("a command admitted before release completes against the runtime it captured", async () => {
		const capability = capabilityFor(stubManager());
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

	it("observe emits the initial sync once; observation release is idempotent and stops delivery", async () => {
		const manager = stubManager();
		const capability = capabilityFor(manager);
		const log: string[] = [];
		const observation = capability.observe(observerFor(log), null);
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
		const capability = capabilityFor(manager);
		const first: string[] = [];
		const second: string[] = [];
		const observation = capability.observe(observerFor(first), null);
		capability.observe(observerFor(second), null);
		await observation.release();
		expect(first).toEqual(["initial-sync"]);
		expect(second).toEqual(["initial-sync"]);
		manager.emitPatch();
		expect(first).toEqual(["initial-sync"]);
		expect(second).toEqual(["initial-sync", "patch"]);
		// One observation's release is not the registration's end: commands and
		// fresh observations stay admitted.
		await expect(capability.command(async (session) => session.cwd)).resolves.toBe("/proj");
		expect(() => capability.observe(observerFor([]), null)).not.toThrow();
	});

	it("capability release ends admission and every observation, and disposes nothing", async () => {
		const manager = stubManager();
		const capability = capabilityFor(manager);
		const first: string[] = [];
		const second: string[] = [];
		capability.observe(observerFor(first), null);
		capability.observe(observerFor(second), null);
		await capability.release();
		await capability.release();
		expect(manager.log).toEqual(["add", "add", "remove", "remove"]);
		manager.emitPatch();
		expect(first).toEqual(["initial-sync"]);
		expect(second).toEqual(["initial-sync"]);
		await expect(capability.command(() => Promise.resolve("late"))).rejects.toThrow("session is closed");
		// Release ends the attachment, not the Session: idle collection owns
		// disposal, and the runtime outlives the client that left.
		expect(manager.disposeCount()).toBe(0);
	});

	it("observe rejects once the registration ended or the terminal boundary began", async () => {
		const released = capabilityFor(stubManager());
		released.observe(observerFor([]), null);
		await released.release();
		expect(() => released.observe(observerFor([]), null)).toThrow("session is closed");

		const terminal = capabilityFor(stubManager());
		const ending = terminal.execution.end();
		expect(terminal.execution.ended).toBe(true);
		expect(() => terminal.observe(observerFor([]), null)).toThrow("session is closed");
		await ending;
	});

	it("the terminal boundary is joinable: one drain, one disposal, admitted work awaited", async () => {
		const manager = stubManager();
		const capability = capabilityFor(manager);
		let releaseWork: (() => void) | undefined;
		const admitted = capability.command(async () => {
			await new Promise<void>((resolve) => {
				releaseWork = resolve;
			});
		});
		expect(capability.execution.ended).toBe(false);
		const ending = capability.execution.end();
		const joining = capability.execution.end();
		await expect(capability.command(() => Promise.resolve("late"))).rejects.toThrow("session is closed");
		// The runtime is disposed exactly once; the drain still waits for the
		// work admitted before it began.
		expect(manager.disposeCount()).toBe(1);
		releaseWork?.();
		await Promise.all([admitted, ending, joining]);
		expect(manager.disposeCount()).toBe(1);
	});
});

// SessionExecution — the work-admission owner for one live Session runtime.
// These tests pin the two admission classes and the terminal boundary:
// mutations serialize among themselves; immediate work never queues behind
// them (or behind a turn); `end` stops admission synchronously, disposes the
// runtime exactly once, and drains admitted work.

import { describe, expect, it } from "vitest";
import type { Document, SessionRef } from "../../src/core/index.ts";
import type { ConnectionHandle, Manager } from "../../src/host/manager.ts";
import { createSessionExecution } from "../../src/host/session-execution.ts";

function stubManager(): Manager & { disposeCalls: () => number; calls: string[] } {
	const state = { disposed: 0, calls: [] as string[] };
	const ref: SessionRef = { projectId: "p", sessionId: "s1", stem: "stem" };
	const base = {
		document: { status: { isStreaming: false, isCompacting: false }, entries: {} } as unknown as Document,
		liveSessionId: "s1",
		cwd: "/proj",
		sessionFile: "/proj/s1.jsonl",
		createdAt: new Date(0).toISOString(),
		onPatch: () => () => {},
		addConnection(handle: ConnectionHandle) {
			state.calls.push("observe");
			handle.onInitialSync({ kind: "replace", session: ref, document: base.document });
		},
		removeConnection: () => state.calls.push("unobserve"),
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
			state.disposed++;
		},
	};
	return { ...base, ...state, disposeCalls: () => state.disposed } as unknown as Manager & {
		disposeCalls: () => number;
		calls: string[];
	};
}

function tick(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("SessionExecution", () => {
	it("serializes mutations: one at a time, in admission order", async () => {
		const manager = stubManager();
		const execution = createSessionExecution(manager);
		const order: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = execution.mutate(async () => {
			order.push("first:start");
			await blocked;
			order.push("first:end");
		});
		const second = execution.mutate(async () => {
			order.push("second");
		});
		await tick();
		expect(order).toEqual(["first:start"]);
		releaseFirst?.();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("runs immediate work while a mutation is in flight (a read never queues)", async () => {
		const manager = stubManager();
		const execution = createSessionExecution(manager);
		const order: string[] = [];
		let releaseMutation: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			releaseMutation = resolve;
		});
		const mutation = execution.mutate(async () => {
			await blocked;
			order.push("mutation");
		});
		await execution.run(async () => {
			order.push("read");
		});
		expect(order).toEqual(["read"]);
		releaseMutation?.();
		await mutation;
		expect(order).toEqual(["read", "mutation"]);
	});

	it("end stops admission synchronously and disposes the runtime exactly once", async () => {
		const manager = stubManager();
		const execution = createSessionExecution(manager);
		await expect(execution.run(() => Promise.resolve("ok"))).resolves.toBe("ok");
		const ending = execution.end();
		await expect(execution.run(() => Promise.resolve("late"))).rejects.toThrow("session is closed");
		await expect(execution.mutate(() => Promise.resolve("late"))).rejects.toThrow("session is closed");
		await ending;
		// Idempotent: every caller observes the same end, one disposal.
		await execution.end();
		expect(manager.disposeCalls()).toBe(1);
	});

	it("end drains tracked immediate work before resolving", async () => {
		const manager = stubManager();
		const execution = createSessionExecution(manager);
		let releaseTurn: (() => void) | undefined;
		const turn = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const tracked = execution.run(async () => {
			await turn;
		});
		let ended = false;
		const ending = execution.end().then(() => {
			ended = true;
		});
		await tick();
		// The runtime is disposed (aborting the turn), but the admitted work has
		// not settled: the end waits for it.
		expect(manager.disposeCalls()).toBe(1);
		expect(ended).toBe(false);
		releaseTurn?.();
		await tracked;
		await ending;
		expect(ended).toBe(true);
	});

	it("a mutation admitted before end completes; one queued after rejects", async () => {
		const manager = stubManager();
		const execution = createSessionExecution(manager);
		const order: string[] = [];
		let releaseMutation: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			releaseMutation = resolve;
		});
		const admitted = execution.mutate(async () => {
			await blocked;
			order.push("admitted");
		});
		// Admitted while the line was open: it runs during the drain.
		const ending = execution.end();
		await expect(execution.mutate(async () => order.push("queued"))).rejects.toThrow("session is closed");
		releaseMutation?.();
		await admitted;
		await ending;
		expect(order).toEqual(["admitted"]);
	});

	it("observe installs the observer once; after end it is a no-op", () => {
		const manager = stubManager();
		const execution = createSessionExecution(manager);
		const ref: SessionRef = { projectId: "p", sessionId: "s1", stem: "stem" };
		const log: string[] = [];
		const handle: ConnectionHandle = {
			onPatch: () => log.push("patch"),
			onInitialSync: () => log.push("initial-sync"),
		};
		execution.observe(handle, ref, null);
		expect(manager.calls).toEqual(["observe"]);
		expect(log).toEqual(["initial-sync"]);
		execution.unobserve(handle);
		expect(manager.calls).toEqual(["observe", "unobserve"]);
		void execution.end();
		execution.observe(handle, ref, null);
		expect(manager.calls).toEqual(["observe", "unobserve"]);
	});
});

// SessionLease — the Connection → Session capability. These tests pin the
// admission and observer semantics: commands run through the lease, the
// observer is installed at most once and removed on release, and a lease
// whose registration ended (released, or its validity flipped by the
// registry) rejects instead of reaching the runtime.

import { describe, expect, it } from "vitest";
import type { Document, SessionRef } from "../../src/core/index.ts";
import type { ConnectionHandle, Manager } from "../../src/host/manager.ts";
import { createSessionExecution } from "../../src/host/session-execution.ts";
import { createSessionLease, issueDirectLease } from "../../src/host/session-lease.ts";

function stubManager(): Manager & {
	observeLog: string[];
	disposeLog: string[];
} {
	const observeLog: string[] = [];
	const disposeLog: string[] = [];
	const base = {
		document: { status: { isStreaming: false, isCompacting: false }, entries: {} } as unknown as Document,
		liveSessionId: "s1",
		cwd: "/proj",
		sessionFile: "/proj/s1.jsonl",
		createdAt: new Date(0).toISOString(),
		onPatch: () => () => {},
		addConnection(handle: ConnectionHandle) {
			observeLog.push("add");
			handle.onInitialSync({ kind: "replace", session: ref, document: base.document });
		},
		removeConnection: () => observeLog.push("remove"),
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
		dispose: async () => disposeLog.push("dispose"),
	};
	const ref: SessionRef = { projectId: "proj", sessionId: "s1", stem: "stem" };
	return { ...base, observeLog, disposeLog } as unknown as Manager & {
		observeLog: string[];
		disposeLog: string[];
	};
}

function handleFor(log: string[]): ConnectionHandle {
	return {
		onPatch: () => log.push("patch"),
		onInitialSync: () => log.push("initial-sync"),
	};
}

describe("SessionLease", () => {
	it("runs a command against the runtime and resolves its value", async () => {
		const manager = stubManager();
		const lease = issueDirectLease(manager, { projectId: "p", sessionId: "s1", stem: "stem" });
		const value = await lease.command(async (session) => session.cwd);
		expect(value).toBe("/proj");
	});

	it("installs the observer once, emitting the initial sync", () => {
		const manager = stubManager();
		const lease = issueDirectLease(manager, { projectId: "p", sessionId: "s1", stem: "stem" });
		const log: string[] = [];
		lease.attachObserver(handleFor(log), null);
		lease.attachObserver(handleFor(log), null); // at most once
		expect(manager.observeLog).toEqual(["add"]);
		expect(log).toEqual(["initial-sync"]);
	});

	it("release removes the observer and ends admission; it is idempotent", async () => {
		const manager = stubManager();
		const lease = issueDirectLease(manager, { projectId: "p", sessionId: "s1", stem: "stem" });
		lease.attachObserver(handleFor([]), null);
		lease.release();
		lease.release();
		expect(manager.observeLog).toEqual(["add", "remove"]);
		await expect(lease.command(() => Promise.resolve())).rejects.toThrow("session is closed");
	});

	it("rejects a command while the registration is invalid (mid-collection)", async () => {
		const manager = stubManager();
		const execution = createSessionExecution(manager);
		const lease = createSessionLease({
			execution,
			ref: { projectId: "p", sessionId: "s1", stem: "stem" },
			authorization: { incarnation: "inc", generation: 1 },
		});
		await expect(lease.command(() => Promise.resolve("ok"))).resolves.toBe("ok");
		// The terminal boundary stops admission synchronously — the registry
		// reaches it when collection begins, before the runtime is disposed.
		void execution.end();
		await expect(lease.command(() => Promise.resolve("ok"))).rejects.toThrow("session is closed");
	});

	it("a command admitted before release still completes against its runtime", async () => {
		const manager = stubManager();
		const lease = issueDirectLease(manager, { projectId: "p", sessionId: "s1", stem: "stem" });
		const admitted = lease.command(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			return "done";
		});
		lease.release();
		// The command was admitted while the lease was valid: it settles with
		// its own outcome, so the reply the client trusts describes the session
		// that was attached when the request arrived.
		await expect(admitted).resolves.toBe("done");
	});
});

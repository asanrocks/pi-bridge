// Ownership gates on the host side: a terminal leg must be joinable, so a
// second caller waits for the disposal already in flight instead of returning
// as if it had finished. `collect` joins `record.collecting` before the
// terminal `ended` check, and `dispose` returns the memoized drain, so
// `archiveSession` can move a Session file only after its disposal completed
// and every shutdown caller observes the same completion.

import { describe, expect, it } from "vitest";
import type { Document, SessionRef } from "../../src/core/index.ts";
import { ActivationRegistry } from "../../src/host/activation-registry.ts";
import type { ConnectionHandle, Manager } from "../../src/host/manager.ts";

const REF: SessionRef = { projectId: "p", sessionId: "s", stem: "a" };

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A Manager stand-in whose disposal is gated by the test. */
function gatedManager(onDispose: () => Promise<void>): Manager {
	const document = {
		status: { isStreaming: false, isCompacting: false },
		entries: {},
	} as unknown as Document;
	return {
		document,
		liveSessionId: "s",
		cwd: "/repo",
		sessionFile: "/repo/sessions/a.jsonl",
		createdAt: new Date(0).toISOString(),
		onPatch: () => () => {},
		addConnection(handle: ConnectionHandle) {
			handle.onInitialSync({ kind: "replace", session: REF, document });
		},
		removeConnection: () => {},
		onSettled: () => () => {},
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
		dispose: onDispose,
	} as unknown as Manager;
}

function makeRegistry(manager: Manager): ActivationRegistry {
	return new ActivationRegistry({
		incarnation: "test",
		createManager: async () => manager,
		idleGcMs: 60_000,
		unflushedIdleGcMs: 60_000,
		onSettled: () => {},
		onStreamingChange: () => {},
		onRegistryChange: () => {},
	});
}

/** A registry whose single Manager blocks inside `dispose()`. */
function blockedRegistry(): {
	registry: ActivationRegistry;
	manager: Manager;
	started: Promise<void>;
	finish: () => void;
} {
	const started = deferred();
	const finish = deferred();
	const manager = gatedManager(async () => {
		started.resolve();
		await finish.promise;
	});
	return { registry: makeRegistry(manager), manager, started: started.promise, finish: finish.resolve };
}

describe("terminal joins", () => {
	it("a second collect joins the disposal already in flight", async () => {
		const { registry, manager, started, finish } = blockedRegistry();
		const record = await registry.register(manager, REF);
		const first = registry.collect(record);
		await started;

		let secondDone = false;
		const second = registry.collect(record).then(() => {
			secondDone = true;
		});
		try {
			await delay(5);
			// archiveSession relies on this join before moving the file.
			expect(secondDone).toBe(false);
		} finally {
			finish();
			await Promise.all([first, second]);
			await registry.dispose();
		}
	});

	it("a second shutdown joins the drain already in flight", async () => {
		const { registry, manager, started, finish } = blockedRegistry();
		await registry.register(manager, REF);
		const first = registry.dispose();
		await started;

		let secondDone = false;
		const second = registry.dispose().then(() => {
			secondDone = true;
		});
		try {
			await delay(5);
			expect(secondDone).toBe(false);
		} finally {
			finish();
			await Promise.all([first, second]);
		}
	});
});

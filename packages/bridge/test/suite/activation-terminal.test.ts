// Activation terminal state — the registry's records end exactly once. A
// stale handle (a close that raced a GC, a caller holding a replaced
// registration) is refused by `collect`, so it can neither double-dispose the
// runtime nor release a newer registration's durable-id claim; the claim
// itself is released by record identity, not address fields (F5).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Document, SessionRef } from "../../src/core/index.ts";
import { ActivationRegistry } from "../../src/host/activation-registry.ts";
import type { ConnectionHandle, Manager } from "../../src/host/manager.ts";
import type { ProjectConfig } from "../../src/host/projects.ts";

function stubManager(sessionId: string): Manager & { disposeCalls(): number } {
	const state = { disposed: 0 };
	const ref: SessionRef = { projectId: "p", sessionId, stem: "a" };
	const base = {
		document: { status: { isStreaming: false, isCompacting: false }, entries: {} } as unknown as Document,
		liveSessionId: sessionId,
		cwd: "/repo",
		sessionFile: `/repo/${sessionId}.jsonl`,
		createdAt: new Date(0).toISOString(),
		onPatch: () => () => {},
		addConnection(handle: ConnectionHandle) {
			handle.onInitialSync({ kind: "replace", session: ref, document: base.document });
		},
		removeConnection: () => {},
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
	return { ...base, disposeCalls: () => state.disposed } as unknown as Manager & { disposeCalls(): number };
}

describe("Activation terminal state", () => {
	let dir: string | null = null;

	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = null;
		}
	});

	function makeRegistry(factory?: () => Promise<Manager>): ActivationRegistry {
		return new ActivationRegistry({
			incarnation: "test",
			createManager:
				factory ??
				(async () => {
					throw new Error("factory unused by these tests");
				}),
			idleGcMs: 60_000,
			unflushedIdleGcMs: 60_000,
			onSettled: () => {},
			onStreamingChange: () => {},
			onRegistryChange: () => {},
		});
	}

	it("a stale collect is refused and cannot release a newer registration's claim", async () => {
		const m3 = stubManager("S");
		const registry = makeRegistry(async () => m3);
		const ref: SessionRef = { projectId: "p", sessionId: "S", stem: "a" };
		const m1 = stubManager("S");
		const r1 = await registry.register(m1, ref);
		await registry.collect(r1);
		expect(m1.disposeCalls()).toBe(1);

		// The address re-registers (a new activation for the same session).
		const m2 = stubManager("S");
		const r2 = await registry.register(m2, ref);
		expect(registry.byAddressLive("p", "a")).toBe(r2);

		// The stale handle reaches collect again: a no-op — the newer
		// registration keeps running and keeps its durable-id claim.
		await registry.collect(r1);
		expect(m2.disposeCalls()).toBe(0);
		expect(registry.byAddressLive("p", "a")).toBe(r2);

		// The claim is still held: reserving a *different* address whose
		// session file carries the same durable id is rejected, not silently
		// re-registered. The factory hands the registry a Manager whose
		// liveSessionId collides with the live registration's claim.
		dir = mkdtempSync(join(tmpdir(), "bridge-terminal-"));
		const project = { id: "p", cwd: dir, sessionDir: dir } as unknown as ProjectConfig;
		writeFileSync(join(dir, "b.jsonl"), "");
		await expect(registry.reserve(project, "b", join(dir, "b.jsonl"))).rejects.toThrow(
			"Session id is already addressed as p/a",
		);
		expect(m3.disposeCalls()).toBe(1); // the refused creation disposed its Manager
		await registry.dispose();
	});

	it("an ended record's admission is refused, not retargeted", async () => {
		const registry = makeRegistry();
		const ref: SessionRef = { projectId: "p", sessionId: "S", stem: "a" };
		const m1 = stubManager("S");
		const r1 = await registry.register(m1, ref);
		const admission = r1.admission;
		await registry.collect(r1);
		// The registration-scoped admission is the one path to the runtime;
		// once the actor closed it rejects instead of reaching a disposed
		// Manager, so a stale handle cannot command a successor either.
		await expect(admission.renameSession("late")).rejects.toThrow("session is closed");
		await registry.dispose();
	});

	it("collect is idempotent for concurrent callers: one disposal", async () => {
		const registry = makeRegistry();
		const ref: SessionRef = { projectId: "p", sessionId: "S", stem: "a" };
		const m1 = stubManager("S");
		const r1 = await registry.register(m1, ref);
		await Promise.all([registry.collect(r1), registry.collect(r1), registry.collect(r1)]);
		expect(m1.disposeCalls()).toBe(1);
		await registry.dispose();
	});
});

// ============================================================================
// SessionExecution — the work-admission owner for one live Session runtime.
//
// The Activation registry owns the Session's lifetime (registration,
// collection, exclusivity); this module owns the order of the work admitted
// against that runtime. Work arrives in two classes, and the classes exist
// because the bridge must not add a competing turn lifecycle (architecture
// invariant 5: pi's event loop is serial and the bridge observes it):
//
//   - Mutations (setModel, setThinkingLevel, renameSession, setLabel,
//     navigate) are serialized among themselves — one at a time, in
//     admission order — so concurrent commands from different Connections
//     get a deterministic order. Mutations are quick and never await a
//     turn, so this line cannot deadlock behind streaming.
//   - Immediate work (turns like prompt and recoverTurn, aborts, reads like
//     pull and gitShow) runs without queueing: a Stop must reach a
//     streaming turn rather than wait behind it, and a read that queued
//     behind a turn would stall the live pulls the client issues while
//     content streams. It is *tracked*, so the terminal drain accounts for
//     it.
//
// `end` is the terminal boundary: admission stops synchronously, queued
// mutations reject, the runtime is disposed exactly once (its disposal
// aborts and finalizes the in-flight turn, settling the tracked work
// admitted against it), and every tracked operation is awaited before `end`
// resolves.
// ============================================================================

import type { PrefixCursor, SessionRef } from "../core/index.ts";
import { createLifecycleScope } from "./lifecycle-scope.ts";
import type { ConnectionHandle, Manager } from "./manager.ts";

export interface SessionExecution {
	/** Run immediate, tracked work: turns, aborts, reads. Never queues behind
	 * a running command (pi is the serialization authority for turns; a read
	 * must not stall behind one). Rejected once `end` began. */
	run<T>(operation: (session: Manager) => Promise<T>): Promise<T>;
	/** Run a serialized mutation: one at a time, in admission order, settled
	 * before the next begins. Rejected once `end` began. */
	mutate<T>(operation: (session: Manager) => Promise<T>): Promise<T>;
	/** Install an observer handle on the runtime (emits the initial sync).
	 * At most once per handle; a no-op once `end` began. */
	observe(handle: ConnectionHandle, ref: SessionRef, cursor: PrefixCursor | null): void;
	/** Remove an observer handle. */
	unobserve(handle: ConnectionHandle): void;
	/** The terminal boundary: stop admission, dispose the runtime exactly
	 * once, drain admitted work. Idempotent: every caller observes the same
	 * end. */
	end(): Promise<void>;
}

export function createSessionExecution(manager: Manager): SessionExecution {
	const mutations = createLifecycleScope();
	const tracked = new Set<Promise<unknown>>();
	let ending = false;
	let ended: Promise<void> | undefined;

	return {
		run<T>(operation: (session: Manager) => Promise<T>): Promise<T> {
			if (ending) return Promise.reject(new Error("session is closed"));
			let started: Promise<T>;
			try {
				// Normalize at the boundary: the admission surface is promise-shaped,
				// so an operation that fails before returning its promise rejects
				// instead of escaping as a synchronous throw (untracked) — the same
				// idiom BridgeClient.call uses for a transport that throws in `send`.
				started = Promise.resolve(operation(manager));
			} catch (error) {
				return Promise.reject(error instanceof Error ? error : new Error(String(error)));
			}
			const settle = started.then(
				() => undefined,
				() => undefined,
			);
			tracked.add(settle);
			void settle.then(() => tracked.delete(settle));
			return started;
		},
		mutate<T>(operation: (session: Manager) => Promise<T>): Promise<T> {
			if (ending) return Promise.reject(new Error("session is closed"));
			return mutations.run(() => operation(manager));
		},
		observe(handle: ConnectionHandle, ref: SessionRef, cursor: PrefixCursor | null): void {
			if (ending) return;
			manager.addConnection(handle, ref, cursor);
		},
		unobserve(handle: ConnectionHandle): void {
			manager.removeConnection(handle);
		},
		end(): Promise<void> {
			if (ended !== undefined) return ended;
			// Admission stops synchronously: a command that arrives from here on
			// is rejected before it can reach a runtime being torn down.
			ending = true;
			ended = (async () => {
				// Queued mutations reject instead of running against a disposing
				// runtime; the one still running settles first (mutations are
				// quick and never await a turn).
				await mutations.close();
				// Disposal aborts and finalizes the in-flight turn — which is
				// what settles the tracked work admitted against it.
				await manager.dispose();
				await Promise.allSettled([...tracked]);
			})();
			return ended;
		},
	};
}

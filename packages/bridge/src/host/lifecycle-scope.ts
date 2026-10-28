// ============================================================================
// LifecycleScope — one FIFO of serialized operations with a terminal close.
//
// The host had three hand-rolled copies of the same tail chain (Connection's
// transition chain, the daemon's settings-mutation chain, the git-stamp
// observation queue), each reimplementing "run in arrival order; one failure
// must not wedge the rest" and each closing differently, if at all. This is
// the one shared implementation, modeled on pi-durable's Session mutation
// line: reserve before acquire, drain before release.
//
// The rules:
//   - `run` executes operations one at a time, in arrival order. A rejecting
//     operation settles its own caller and is swallowed out of the chain, so
//     a failure never wedges whatever is queued behind it.
//   - `close` stops admission synchronously — a `run` after close begins
//     rejects — and resolves only after every admitted operation has settled.
//   - `close` is idempotent; every caller observes the same drain.
//
// The scope owns ordering and admission only. Cleanup of what an operation
// acquired is the caller's business; there is deliberately no poison state.
// ============================================================================

export interface LifecycleScope {
	/** Serialized in arrival order. Rejects once close has begun. */
	run<T>(operation: () => Promise<T>): Promise<T>;
	/** Stop admission synchronously, then resolve once admitted work settled.
	 * Idempotent: every caller observes the same drain. */
	close(): Promise<void>;
	/** "open" until close begins, "closing" while admitted work drains,
	 * "closed" once the drain settled. */
	readonly state: "open" | "closing" | "closed";
}

export function createLifecycleScope(): LifecycleScope {
	let tail: Promise<unknown> = Promise.resolve();
	let drain: Promise<void> | undefined;
	let state: LifecycleScope["state"] = "open";
	return {
		get state() {
			return state;
		},
		run<T>(operation: () => Promise<T>): Promise<T> {
			if (drain !== undefined) return Promise.reject(new Error("lifecycle scope is closed"));
			const run = tail.then(operation);
			// Both handlers: the chain itself never rejects, so a failing
			// operation settles only its own caller and later work still runs.
			tail = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		},
		close(): Promise<void> {
			if (drain === undefined) {
				state = "closing";
				drain = tail.then(() => {
					state = "closed";
				});
			}
			return drain;
		},
	};
}

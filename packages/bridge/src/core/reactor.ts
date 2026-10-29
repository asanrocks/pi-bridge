// ============================================================================
// Reactor — one serialized state machine over an explicit lifetime.
//
// A reactor is an ownership boundary: the state of one lifetime and every
// transition of that lifetime live behind one mailbox. Messages are applied
// one at a time, in arrival order, by a synchronous step function; a step
// reads the current state, returns the next state, and may admit effects —
// asynchronous work whose completion returns to the reactor as an ordinary
// message.
//
// The rules:
//   - `send` resolves once the message has been *applied*; effects it
//     admitted may still be running (their completions arrive as messages).
//   - A reentrant `send` from inside a step queues behind the message being
//     applied; it can never interleave with it.
//   - `close` stops admission synchronously — a `send` after close begins
//     rejects — and resolves only after every applied message and every
//     admitted effect, including the completion messages they produced, has
//     settled. Idempotent: every caller observes the same drain.
//
// Stale completions are the caller's state machine, not the runtime's: a
// step admits an effect under the message's `epoch` (monotonic, one per
// applied message) and embeds that epoch in the completion message it
// returns; the handler that receives the completion compares it with the
// epoch its state recorded and ignores a superseded one. That is the whole
// mechanism — one comparison in one place, instead of a scattered
// "is this still current?" guard at every await.
//
// The reactor owns ordering, admission, and the drain only. What an effect
// acquired is the effect's business; there is deliberately no poison state.
// ============================================================================

/** Asynchronous work admitted by a step. `run` resolves to the completion
 * message, which is applied like any other message; a rejecting `run` is a
 * bug in the effect (completions are values, not throws) and is reported
 * through `onUnhandledEffectError` without wedging the drain. */
export interface ReactorEffect<M> {
	run(): Promise<M>;
}

/** What a step may do while applying one message. */
export interface ReactorStepContext<M> {
	/** The epoch of the message being applied: one per applied message,
	 * monotonic. Admitted effects embed it in their completion message so
	 * the receiving handler can reject a superseded completion with one
	 * comparison. */
	readonly epoch: number;
	/** Reentrant send: queues behind the message being applied. */
	send(message: M): void;
}

/** One applied message: the next state, and optionally admitted effects. */
export interface ReactorStep<S, M> {
	state: S;
	effects?: ReactorEffect<M>[];
}

export interface ReactorOptions<S, M> {
	initial: S;
	/** Apply one message synchronously. Returns the next state plus any
	 * admitted effects; a throw settles only this message's sender. */
	step(state: S, message: M, context: ReactorStepContext<M>): ReactorStep<S, M>;
	/** A rejecting effect cannot produce a completion message; report it and
	 * keep the reactor drainable. */
	onUnhandledEffectError?(error: unknown): void;
}

export type ReactorPhase = "open" | "closing" | "closed";

export interface Reactor<S, M> {
	/** Apply one message. Resolves once the message has been applied; its
	 * admitted effects may still be running. Rejects once close began. */
	send(message: M): Promise<void>;
	/** The current state. */
	snapshot(): S;
	/** "open" until close begins, "closing" while admitted work drains,
	 * "closed" once the drain settled. */
	readonly phase: ReactorPhase;
	/** Stop admission, then resolve once every applied message and admitted
	 * effect — including completion messages they produced — has settled.
	 * Idempotent: every caller observes the same drain. */
	close(): Promise<void>;
}

export function createReactor<S, M>(options: ReactorOptions<S, M>): Reactor<S, M> {
	let state = options.initial;
	let phase: ReactorPhase = "open";
	let epoch = 0;
	let applying = false;
	let effectsInFlight = 0;
	let drainResolve: (() => void) | undefined;
	let drain: Promise<void> | undefined;
	const queue: Array<{ message: M; resolve: () => void; reject: (error: Error) => void }> = [];

	// Resolve the drain once the pipeline is quiet: nothing being applied,
	// nothing queued, no effect in flight. Called after every settle point.
	const settleIfQuiet = () => {
		if (drainResolve !== undefined && !applying && queue.length === 0 && effectsInFlight === 0) {
			phase = "closed";
			const resolve = drainResolve;
			drainResolve = undefined;
			resolve();
		}
	};

	// `internal` marks work driven by already-admitted messages: effect
	// completions and reentrant sends. Admission applies to external sends.
	const enqueue = (message: M, internal: boolean): Promise<void> => {
		if (!internal && phase !== "open") return Promise.reject(new Error("reactor is closed"));
		return new Promise<void>((resolve, reject) => {
			queue.push({ message, resolve, reject });
			apply();
		});
	};

	const apply = () => {
		if (applying) return;
		applying = true;
		try {
			while (queue.length > 0) {
				const item = queue.shift()!;
				const messageEpoch = ++epoch;
				try {
					const step = options.step(state, item.message, {
						epoch: messageEpoch,
						send: (message) => {
							void enqueue(message, true);
						},
					});
					state = step.state;
					item.resolve();
					for (const effect of step.effects ?? []) {
						effectsInFlight++;
						// Normalize at the boundary: an effect whose `run` throws
						// synchronously must not defeat the accounting — decrement and
						// report it exactly like an async rejection, so `close()` still
						// resolves and the bug is not silent.
						void (async () => {
							try {
								const completion = await effect.run();
								effectsInFlight--;
								void enqueue(completion, true);
							} catch (error) {
								effectsInFlight--;
								options.onUnhandledEffectError?.(error);
								settleIfQuiet();
							}
						})();
					}
				} catch (error) {
					// One failing step settles only its own sender; later
					// messages still apply.
					item.reject(error instanceof Error ? error : new Error(String(error)));
				}
			}
		} finally {
			applying = false;
			settleIfQuiet();
		}
	};

	return {
		get phase() {
			return phase;
		},
		send: (message) => enqueue(message, false),
		snapshot: () => state,
		close(): Promise<void> {
			if (drain !== undefined) return drain;
			phase = "closing";
			drain = new Promise<void>((resolve) => {
				drainResolve = resolve;
				settleIfQuiet();
			});
			return drain;
		},
	};
}

// Reactor — the serialized state-machine primitive. These tests pin the
// admission, ordering, effect-completion, and drain semantics that the
// Session execution owner and the browser navigation controller rely on,
// including the epoch pattern that replaces scattered stale-result guards.

import { describe, expect, it } from "vitest";
import { createReactor, type Reactor } from "../../src/core/index.ts";

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A deferred the tests control from outside. */
function gate<T = void>(): { promise: Promise<T>; open: (value: T) => void } {
	let open!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

describe("Reactor", () => {
	it("applies messages one at a time, in arrival order", async () => {
		const seen: string[] = [];
		const reactor = createReactor<number, string>({
			initial: 0,
			step: (state, message) => {
				seen.push(message);
				return { state: state + 1 };
			},
		});
		await reactor.send("a");
		await reactor.send("b");
		expect(seen).toEqual(["a", "b"]);
		expect(reactor.snapshot()).toBe(2);
	});

	it("resolves send after the step ran, before admitted effects settle", async () => {
		const effectGate = gate<void>();
		let applied = false;
		let effectDone = false;
		const reactor = createReactor<number, { kind: "start" } | { kind: "done" }>({
			initial: 0,
			step: (state, message) => {
				if (message.kind === "start") {
					applied = true;
					return {
						state,
						effects: [
							{
								run: async () => {
									await effectGate.promise;
									effectDone = true;
									return { kind: "done" };
								},
							},
						],
					};
				}
				return { state: state + 1 };
			},
		});
		await reactor.send({ kind: "start" });
		expect(applied).toBe(true);
		expect(effectDone).toBe(false);
		expect(reactor.snapshot()).toBe(0);
		effectGate.open(undefined);
		await tick();
		expect(effectDone).toBe(true);
		// The completion was applied as a message.
		expect(reactor.snapshot()).toBe(1);
	});

	it("queues a reentrant send behind the running message", async () => {
		const seen: string[] = [];
		const reactor = createReactor<number, string>({
			initial: 0,
			step: (state, message, context) => {
				seen.push(message);
				if (message === "outer") context.send("inner");
				return { state: state + 1 };
			},
		});
		await reactor.send("outer");
		expect(seen).toEqual(["outer", "inner"]);
	});

	it("a throwing step settles only its own sender", async () => {
		const reactor = createReactor<number, string>({
			initial: 0,
			step: (state, message) => {
				if (message === "boom") throw new Error("boom");
				return { state: state + 1 };
			},
		});
		await expect(reactor.send("boom")).rejects.toThrow("boom");
		await expect(reactor.send("ok")).resolves.toBeUndefined();
		expect(reactor.snapshot()).toBe(1);
	});

	it("rejects sends once close began, and close drains admitted effects and their completions", async () => {
		let completions = 0;
		const reactor = createReactor<number, { kind: "start" } | { kind: "done" }>({
			initial: 0,
			step: (state, message) => {
				if (message.kind === "start") {
					return {
						state,
						effects: [
							{
								run: async () => {
									await tick();
									return { kind: "done" };
								},
							},
						],
					};
				}
				completions++;
				return { state };
			},
		});
		await reactor.send({ kind: "start" });
		const closing = reactor.close();
		expect(reactor.phase).toBe("closing");
		await expect(reactor.send({ kind: "start" })).rejects.toThrow("reactor is closed");
		await closing;
		expect(reactor.phase).toBe("closed");
		// The admitted effect settled and its completion was applied.
		expect(completions).toBe(1);
	});

	it("close is idempotent: every caller observes the same drain", async () => {
		const reactor = createReactor<number, string>({ initial: 0, step: (state) => ({ state }) });
		const first = reactor.close();
		const second = reactor.close();
		expect(second).toBe(first);
		await first;
		expect(reactor.phase).toBe("closed");
	});

	it("a rejecting effect is reported and does not wedge the drain", async () => {
		const errors: unknown[] = [];
		const reactor = createReactor<number, { kind: "start" }>({
			initial: 0,
			step: (state) => ({
				state,
				effects: [
					{
						run: async () => {
							throw new Error("effect bug");
						},
					},
				],
			}),
			onUnhandledEffectError: (error) => errors.push(error),
		});
		await reactor.send({ kind: "start" });
		await reactor.close();
		expect(reactor.phase).toBe("closed");
		expect(errors).toHaveLength(1);
	});

	it("rejects a completion whose epoch was superseded", async () => {
		// The epoch pattern: a step records the epoch it admitted an effect
		// under; the completion carries that epoch back; a later message can
		// supersede it, and the stale completion is ignored with one
		// comparison instead of a scattered staleness guard.
		type Message = { kind: "begin" } | { kind: "supersede" } | { kind: "completed"; epoch: number };
		interface NavState {
			owner: number | null;
			applied: string[];
		}
		const reactor: Reactor<NavState, Message> = createReactor<NavState, Message>({
			initial: { owner: null, applied: [] },
			step: (state, message, context) => {
				switch (message.kind) {
					case "begin":
						return {
							state: { ...state, owner: context.epoch },
							effects: [
								{
									// Completes after a supersedable delay.
									run: async () => {
										await tick();
										await tick();
										return { kind: "completed", epoch: context.epoch };
									},
								},
							],
						};
					case "supersede":
						return { state: { ...state, owner: null } };
					case "completed":
						if (state.owner !== message.epoch) {
							// Superseded: the work no longer describes the
							// state it was admitted against.
							return { state: { ...state, applied: [...state.applied, "ignored"] } };
						}
						return { state: { ...state, applied: [...state.applied, "committed"], owner: null } };
				}
			},
		});
		await reactor.send({ kind: "begin" });
		// A newer message supersedes before the completion lands.
		await reactor.send({ kind: "supersede" });
		await tick();
		await tick();
		await tick();
		expect(reactor.snapshot().applied).toEqual(["ignored"]);
	});

	it("commits a completion that still owns its epoch", async () => {
		type Message = { kind: "begin" } | { kind: "completed"; epoch: number };
		const reactor = createReactor<{ owner: number | null; committed: boolean }, Message>({
			initial: { owner: null, committed: false },
			step: (state, message, context) => {
				switch (message.kind) {
					case "begin":
						return {
							state: { ...state, owner: context.epoch },
							effects: [
								{
									run: async () => ({ kind: "completed", epoch: context.epoch }),
								},
							],
						};
					case "completed":
						if (state.owner !== message.epoch) return { state };
						return { state: { owner: null, committed: true } };
				}
			},
		});
		await reactor.send({ kind: "begin" });
		await tick();
		expect(reactor.snapshot().committed).toBe(true);
	});

	it("a synchronous-throwing effect is reported and does not wedge close()", async () => {
		// F1: the effect accounting is promise-shaped at the boundary. An effect
		// whose `run` throws synchronously must decrement the in-flight count and
		// reach onUnhandledEffectError exactly like an async rejection — leaving
		// the count elevated would stick close() at "closing" forever and the
		// effect bug would be silent.
		const errors: unknown[] = [];
		const reactor = createReactor<number, { kind: "start" }>({
			initial: 0,
			step: (state) => ({
				state,
				effects: [
					{
						run(): Promise<{ kind: "start" }> {
							throw new Error("sync effect bug");
						},
					},
				],
			}),
			onUnhandledEffectError: (error) => errors.push(error),
		});
		await reactor.send({ kind: "start" });
		const closing = reactor.close();
		// Gate on a timeout, not a sleep: close must win the race.
		await Promise.race([
			closing,
			new Promise((_, reject) => setTimeout(() => reject(new Error("close wedged")), 300)),
		]);
		await closing;
		expect(reactor.phase).toBe("closed");
		expect(errors).toHaveLength(1);
	});
});

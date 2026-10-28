// LifecycleScope — the shared serialized-operation FIFO with a terminal
// close, adopted by Connection (attachment transitions), the Daemon
// (settings mutations), and the git-stamp observation queue. These tests
// pin the admission and drain semantics the callers rely on.

import { describe, expect, it } from "vitest";
import { createLifecycleScope } from "../../src/host/lifecycle-scope.ts";

function tick(ms = 5): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("LifecycleScope", () => {
	it("runs operations one at a time, in arrival order", async () => {
		const scope = createLifecycleScope();
		const order: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = scope.run(async () => {
			order.push("first:start");
			await blocked;
			order.push("first:end");
		});
		const second = scope.run(async () => {
			order.push("second");
		});
		await tick();
		// The second operation waits behind the blocked first.
		expect(order).toEqual(["first:start"]);
		releaseFirst?.();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("a rejected operation does not wedge later ones", async () => {
		const scope = createLifecycleScope();
		await expect(
			scope.run(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(scope.run(async () => 7)).resolves.toBe(7);
	});

	it("queues a reentrant run behind the running operation", async () => {
		const scope = createLifecycleScope();
		const order: string[] = [];
		let inner: Promise<unknown> | undefined;
		const outer = scope.run(async () => {
			order.push("outer");
			// Reentrant from inside the running operation: it must queue
			// behind, not interleave.
			inner = scope.run(async () => {
				order.push("inner");
			});
			await tick();
			expect(order).toEqual(["outer"]);
		});
		await outer;
		await inner;
		expect(order).toEqual(["outer", "inner"]);
	});

	it("rejects new operations once close has begun", async () => {
		const scope = createLifecycleScope();
		await scope.close();
		expect(scope.state).toBe("closed");
		await expect(scope.run(async () => 1)).rejects.toThrow("lifecycle scope is closed");
	});

	it("close drains admitted work before resolving", async () => {
		const scope = createLifecycleScope();
		let release: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const admitted = scope.run(async () => {
			await blocked;
		});
		let settled = false;
		const closing = scope.close().then(() => {
			settled = true;
		});
		await tick();
		expect(scope.state).toBe("closing");
		expect(settled).toBe(false);
		release?.();
		await admitted;
		await closing;
		expect(settled).toBe(true);
		expect(scope.state).toBe("closed");
	});

	it("a rejecting admitted operation still lets close resolve", async () => {
		const scope = createLifecycleScope();
		const failing = scope.run(async () => {
			throw new Error("boom");
		});
		const closing = scope.close();
		await expect(failing).rejects.toThrow("boom");
		await closing;
		expect(scope.state).toBe("closed");
	});

	it("close is idempotent and every caller observes the same drain", async () => {
		const scope = createLifecycleScope();
		const first = scope.close();
		const second = scope.close();
		expect(second).toBe(first);
		await first;
		expect(scope.state).toBe("closed");
	});
});

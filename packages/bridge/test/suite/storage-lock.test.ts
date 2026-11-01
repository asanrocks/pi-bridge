// Storage exclusion (commit 9 of the Worker split).
//
// Two Workers writing one Session directory interleave JSONL appends, and no
// later reconciliation can repair pi's file. The lock is therefore a hard
// fail-closed claim, not an advisory hint: these tests pin exclusivity, the
// wait deadline, owner-only release, and the two reclamation rules (a provably
// dead same-host owner is reclaimed; a foreign-host owner never is).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireStorageLock, storageLockPath, storageReclaimPath } from "../../src/host/storage-lock.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(): string {
	const dir = join(tmpdir(), `pi-bridge-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

describe("storage lock", () => {
	it("grants one owner and refuses a second until it is released", async () => {
		const dir = tempDir();
		const first = await acquireStorageLock(dir);
		await expect(acquireStorageLock(dir, { timeoutMs: 150, pollMs: 20 })).rejects.toThrow(
			/Session directory is locked by pid/,
		);
		await first.release();
		const second = await acquireStorageLock(dir, { timeoutMs: 500, pollMs: 20 });
		await second.release();
	});

	it("writes an owner record and removes it on release", async () => {
		const dir = tempDir();
		const lock = await acquireStorageLock(dir);
		const record = JSON.parse(readFileSync(storageLockPath(dir), "utf8")) as {
			pid: number;
			host: string;
			token: string;
		};
		expect(record.pid).toBe(process.pid);
		expect(record.host).toBe(hostname());
		expect(record.token).toMatch(/[0-9a-f-]{36}/);

		await lock.release();
		expect(() => readFileSync(storageLockPath(dir), "utf8")).toThrow();
	});

	it("release is idempotent", async () => {
		const dir = tempDir();
		const lock = await acquireStorageLock(dir);
		await lock.release();
		await expect(lock.release()).resolves.toBeUndefined();
	});

	it("reclaims a lock whose same-host owner is provably gone", async () => {
		const dir = tempDir();
		// A crashed predecessor: same host, a pid that is not alive.
		writeFileSync(
			storageLockPath(dir),
			JSON.stringify({ pid: 999_999, host: hostname(), token: "stale", acquiredAt: new Date(0).toISOString() }),
		);
		const lock = await acquireStorageLock(dir, {
			timeoutMs: 1_000,
			pollMs: 20,
			isPidAlive: () => false,
		});
		const record = JSON.parse(readFileSync(storageLockPath(dir), "utf8")) as { token: string };
		expect(record.token).not.toBe("stale");
		await lock.release();
	});

	it("grants a stale lock to exactly one of several competing reclaimers", async () => {
		const dir = tempDir();
		// Every reclaimer judges the same dead record stale. Without a
		// single-winner guard, a loser could unlink the winner's fresh claim and
		// both would believe they own the directory.
		writeFileSync(
			storageLockPath(dir),
			JSON.stringify({ pid: 999_999, host: hostname(), token: "stale", acquiredAt: new Date(0).toISOString() }),
		);
		const results = await Promise.allSettled(
			Array.from({ length: 8 }, () =>
				acquireStorageLock(dir, { timeoutMs: 600, pollMs: 5, isPidAlive: () => false }),
			),
		);

		const winners = results.filter((result) => result.status === "fulfilled");
		expect(winners).toHaveLength(1);
		// The guard is released even on the losing path.
		expect(() => readFileSync(storageReclaimPath(dir), "utf8")).toThrow();

		for (const winner of winners) {
			if (winner.status === "fulfilled") await winner.value.release();
		}
	});

	it("never reclaims a lock held on another host", async () => {
		const dir = tempDir();
		// A stale pid on a foreign host proves nothing here: only that host can
		// tell whether its process still runs.
		writeFileSync(
			storageLockPath(dir),
			JSON.stringify({
				pid: 999_999,
				host: "some-other-host",
				token: "remote",
				acquiredAt: new Date(0).toISOString(),
			}),
		);
		await expect(acquireStorageLock(dir, { timeoutMs: 150, pollMs: 20, isPidAlive: () => false })).rejects.toThrow(
			/locked by pid 999999 on some-other-host/,
		);
	});

	it("a successor's record is not deleted by the previous owner's release", async () => {
		const dir = tempDir();
		const lock = await acquireStorageLock(dir);
		// Simulate a reclamation that replaced the record while the first holder
		// still believed it owned the lock: the token no longer matches.
		writeFileSync(
			storageLockPath(dir),
			JSON.stringify({
				pid: process.pid,
				host: hostname(),
				token: "successor",
				acquiredAt: new Date(0).toISOString(),
			}),
		);
		await lock.release();
		const record = JSON.parse(readFileSync(storageLockPath(dir), "utf8")) as { token: string };
		expect(record.token).toBe("successor");
	});

	it("treats an unreadable record as held", async () => {
		const dir = tempDir();
		writeFileSync(storageLockPath(dir), "not json");
		await expect(acquireStorageLock(dir, { timeoutMs: 150, pollMs: 20 })).rejects.toThrow(/is locked/);
	});
});

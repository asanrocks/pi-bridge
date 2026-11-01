// ============================================================================
// Storage lock — one execution owner per Session directory.
//
// A Daemon link ends with its socket while execution continues, so a
// registration cannot be the exclusion primitive: the runtime outlives it. The
// lock therefore sits next to the filesystem and is held by the Worker for its
// whole lifetime.
//
// Two Workers writing one Session directory interleave JSONL appends, which no
// later reconciliation can repair — pi's file is the durable authority. A Worker
// that cannot establish exclusion refuses to serve rather than writing
// unsynchronized (fail-closed).
//
// Acquisition is an exclusively created file (`wx`) holding the owner's pid,
// host, and a random token. Release is holder-only: a record rewritten by a
// successor is never deleted.
//
// Reclaiming a crashed owner needs a delete, and a bare check-then-unlink is
// wrong: two reclaimers can both judge the same record stale, the winner can
// create a fresh lock, and the loser's unlink then removes *that* live claim —
// leaving two Workers convinced they own the directory. Reclamation therefore
// runs inside a second exclusively created file, `.pi-bridge.lock.reclaim`:
//
//   - only the guard holder may delete the lock, and `wx` makes the guard
//     single-winner;
//   - the lock is re-read *while holding the guard* and deleted only if it is
//     still the record that was judged stale, so a successor's lock created
//     after the judgement cannot be removed;
//   - the guard is released in `finally`, and a guard left by a dead owner is
//     reclaimed by the same pid rule.
//
// A stale guard can only block acquisition (availability), never permit a
// second holder (safety), which is the property that matters here.
//
// Kernel-released exclusion (flock/fcntl, or one SQLite transaction) would
// remove the pid probe and the guard entirely; it needs a native primitive this
// package does not depend on, so the limitation is stated rather than hidden: a
// lock left by a crashed process on another host requires manual removal.
// ============================================================================

import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

/** The lock file's basename inside the Session directory. Namespaced so it is
 * never mistaken for a Session stem. */
const LOCK_FILE = ".pi-bridge.lock";
/** The single-winner file that authorises a stale-lock reclamation. */
const RECLAIM_FILE = ".pi-bridge.lock.reclaim";

export interface StorageLock {
	/** The directory this lock excludes. */
	readonly directory: string;
	/** The lock file's absolute path (diagnostics and tests). */
	readonly path: string;
	/** Release the lock. Idempotent; a lock no longer owned by this holder is
	 * left alone. */
	release(): Promise<void>;
}

export interface AcquireStorageLockOptions {
	/** How long to wait for another owner to release before giving up. */
	readonly timeoutMs?: number;
	readonly pollMs?: number;
	/** Test seam: pid liveness probe. Defaults to `process.kill(pid, 0)`. */
	readonly isPidAlive?: (pid: number) => boolean;
}

interface LockRecord {
	readonly pid: number;
	readonly host: string;
	readonly token: string;
	readonly acquiredAt: string;
}

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readRecord(path: string): Promise<LockRecord | null> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<LockRecord>;
		if (
			typeof parsed.pid !== "number" ||
			typeof parsed.host !== "string" ||
			typeof parsed.token !== "string" ||
			typeof parsed.acquiredAt !== "string"
		) {
			return null;
		}
		return parsed as LockRecord;
	} catch {
		return null;
	}
}

/** True when the recorded owner is provably gone: same host, pid not alive. An
 * unreadable record is not provable, so it is treated as held. */
function isStale(record: LockRecord, isPidAlive: (pid: number) => boolean): boolean {
	if (record.pid === process.pid) return false;
	if (record.host !== hostname()) return false;
	return !isPidAlive(record.pid);
}

/** Acquire one exclusively created file. Returns false when it already exists. */
async function createExclusive(path: string, record: LockRecord): Promise<boolean> {
	try {
		await writeFile(path, JSON.stringify(record), { flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

/** Remove a file whose owner is provably dead. An unreadable record is never
 * removed (it cannot be proven stale). */
async function removeIfStale(path: string, isPidAlive: (pid: number) => boolean): Promise<void> {
	const held = await readRecord(path);
	if (held !== null && isStale(held, isPidAlive)) await unlink(path).catch(() => {});
}

/** Acquire the Session directory's execution lock. Rejects when the directory is
 * already served by a live owner, or when the wait deadline expires. */
export async function acquireStorageLock(
	directory: string,
	options: AcquireStorageLockOptions = {},
): Promise<StorageLock> {
	const path = join(directory, LOCK_FILE);
	const reclaimPath = join(directory, RECLAIM_FILE);
	const timeoutMs = options.timeoutMs ?? 5_000;
	const pollMs = options.pollMs ?? 100;
	const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
	const token = randomUUID();
	const record: LockRecord = {
		pid: process.pid,
		host: hostname(),
		token,
		acquiredAt: new Date().toISOString(),
	};
	const deadline = Date.now() + timeoutMs;

	/**
	 * Delete a stale lock under the reclaim guard. The guard is the only licence
	 * to delete, so two reclaimers cannot both act; the re-read under the guard
	 * ties the delete to the exact record that was judged stale.
	 */
	const reclaim = async (stale: LockRecord): Promise<void> => {
		if (!(await createExclusive(reclaimPath, record))) {
			// Another process is reclaiming (or a previous one died holding the
			// guard). A dead guard holder is reclaimed by the same pid rule; a live
			// one is left alone — waiting costs availability, never safety.
			await removeIfStale(reclaimPath, isPidAlive);
			return;
		}
		try {
			const current = await readRecord(path);
			// Identity, not just staleness: a successor's fresh lock created after
			// this process judged the old one stale must not be removed.
			if (current !== null && current.token === stale.token) {
				await unlink(path).catch(() => {});
			}
		} finally {
			// Only the guard holder releases the guard, and only its own record.
			const guard = await readRecord(reclaimPath);
			if (guard !== null && guard.token === token) await unlink(reclaimPath).catch(() => {});
		}
	};

	for (;;) {
		const acquired = await createExclusive(path, record);
		if (acquired) {
			let released = false;
			return {
				directory,
				path,
				release: async () => {
					if (released) return;
					released = true;
					// Only the holder releases: a rewritten record belongs to a
					// successor, and deleting it would hand the directory to a third
					// process while the second is still writing.
					const current = await readRecord(path);
					if (current !== null && current.token === token) {
						await unlink(path).catch(() => {});
					}
				},
			};
		}

		const held = await readRecord(path);
		if (held !== null && isStale(held, isPidAlive)) {
			await reclaim(held);
			continue;
		}

		if (Date.now() >= deadline) {
			const current = await readRecord(path);
			throw new Error(
				current === null
					? `Session directory is locked: ${directory}`
					: `Session directory is locked by pid ${current.pid} on ${current.host}: ${directory}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

/** The lock file path for a directory (diagnostics and tests). */
export function storageLockPath(directory: string): string {
	return join(directory, LOCK_FILE);
}

/** The reclamation guard's path (diagnostics and tests). */
export function storageReclaimPath(directory: string): string {
	return join(directory, RECLAIM_FILE);
}

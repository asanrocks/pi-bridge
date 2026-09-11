// ============================================================================
// entryCache — IndexedDB adapter for the ADR 09 client cache.
//
// Storage layout (one database, shared across tabs):
//   entries  — object store keyed by [sessionId, ord], index on sessionId.
//   sessions — object store keyed by sessionId: { formatVersion, statusHint }.
//
// The cache is a disposable derivative of server data. Cache-format changes
// bump FORMAT_VERSION; the IDB upgrade recreates both stores, clearing
// everything. All writes are planned by the pure core policy (planCacheWrites
// / cacheRecordsOfDocument) and applied in one transaction per server patch
// (ADR 09 invariant 5). The first implementation is unbounded; lastAttached
// timestamps for future eviction can be added to the sessions records without
// a format change.
//
// The interface and the in-memory implementation live in core (cache.ts) so
// policy tests run without a DOM; this module is the only DOM-dependent piece
// and is therefore not importable from test/suite.
// ============================================================================

import type { CacheEntryRecord, EntryCacheStore, PrefixCursor, SessionStatusHint } from "../../../src/core/index.ts";
import { computeCursor, InMemoryEntryCacheStore, seedDocument } from "../../../src/core/index.ts";
import { beginSessionCandidate } from "./sessionCandidate.ts";

const DB_NAME = "pi-bridge-cache";
const ENTRIES_STORE = "entries";
const SESSIONS_STORE = "sessions";
/** Bump to invalidate every cached session (projection or format change). */
const FORMAT_VERSION = 1;

interface SessionRecord {
	sessionId: string;
	formatVersion: number;
	hint: SessionStatusHint | null;
}

/** All entries of one session: [sessionId, -Infinity] .. [sessionId, +Infinity]. */
function sessionKeyRange(sessionId: string): IDBKeyRange {
	return IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
}

class IdbEntryCacheStore implements EntryCacheStore {
	private db: IDBDatabase;

	constructor(db: IDBDatabase) {
		this.db = db;
	}

	async loadSession(sessionId: string): Promise<{ records: CacheEntryRecord[]; hint: SessionStatusHint | null }> {
		// One transaction for both reads, so a concurrent tab write cannot
		// interleave between them.
		let records: CacheEntryRecord[] = [];
		let hint: SessionStatusHint | null = null;
		await this.run("readonly", [ENTRIES_STORE, SESSIONS_STORE], (tx) => {
			const getAll = tx.objectStore(ENTRIES_STORE).getAll(sessionKeyRange(sessionId));
			getAll.onsuccess = () => {
				records = ((getAll.result as CacheEntryRecord[]) ?? []).slice();
			};
			const getSession = tx.objectStore(SESSIONS_STORE).get(sessionId);
			getSession.onsuccess = () => {
				hint = (getSession.result as SessionRecord | undefined)?.hint ?? null;
			};
		});
		records.sort((a, b) => a.ord - b.ord);
		return { records, hint };
	}

	async writeEntries(sessionId: string, records: CacheEntryRecord[], hint?: SessionStatusHint): Promise<void> {
		if (records.length === 0 && hint === undefined) return;
		await this.run("readwrite", [ENTRIES_STORE, SESSIONS_STORE], (tx) => {
			const entries = tx.objectStore(ENTRIES_STORE);
			const sessions = tx.objectStore(SESSIONS_STORE);
			for (const record of records) entries.put(record);
			if (hint !== undefined) {
				sessions.put({ sessionId, formatVersion: FORMAT_VERSION, hint });
			}
		});
	}

	async replaceSession(sessionId: string, records: CacheEntryRecord[], hint?: SessionStatusHint): Promise<void> {
		await this.run("readwrite", [ENTRIES_STORE, SESSIONS_STORE], (tx) => {
			const entries = tx.objectStore(ENTRIES_STORE);
			// Delete-then-insert in one read-write transaction — a failed
			// transaction rolls back both, leaving the previous prefix intact
			// and removing any stale suffix (ADR 09 cache repair path).
			entries.delete(sessionKeyRange(sessionId));
			for (const record of records) entries.put(record);
			tx.objectStore(SESSIONS_STORE).put({ sessionId, formatVersion: FORMAT_VERSION, hint: hint ?? null });
		});
	}

	/** Run one transaction to completion. The body issues its requests from
	 * the transaction and captures results in its own closures — two prior
	 * bugs lived in a results-collecting helper here: objectStore() on a store
	 * not in `storeNames` throws NotFoundError, and resolving only the last
	 * request's result made every multi-request read return empty. A
	 * completion-only helper leaves no room for either. */
	private run(mode: IDBTransactionMode, storeNames: string[], body: (tx: IDBTransaction) => void): Promise<void> {
		return new Promise((resolve, reject) => {
			const tx = this.db.transaction(storeNames, mode);
			try {
				body(tx);
			} catch (err) {
				reject(err);
				return;
			}
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error ?? new Error("indexeddb transaction failed"));
			tx.onabort = () => reject(tx.error ?? new Error("indexeddb transaction aborted"));
		});
	}
}

// ---------------------------------------------------------------------------
// Singleton — falls back to the in-memory store when IndexedDB is unavailable
// (private mode, embedded webviews). The fallback loses the cache on reload;
// correctness is unaffected (a missing cursor just yields a full snapshot).
// ---------------------------------------------------------------------------

let cachePromise: Promise<EntryCacheStore> | null = null;

export function getEntryCache(): Promise<EntryCacheStore> {
	if (!cachePromise) {
		cachePromise = open().catch(() => {
			// A failed open must not poison the singleton forever — retry with
			// the in-memory fallback (e.g. quota errors after a version bump).
			// The fallback loses the cache on reload; correctness is unaffected
			// (a missing cursor just yields a full snapshot).
			return new InMemoryEntryCacheStore() as EntryCacheStore;
		});
	}
	return cachePromise;
}

// ---------------------------------------------------------------------------
// Switch preparation (ADR 09 §Session switch, steps 1–3): load the target
// session's cache into a candidate mirror, derive its cursor. Returns
// undefined when there is no usable cache — the switch then falls back to a
// full replace. A cache read failure degrades the same way.
// ---------------------------------------------------------------------------

export async function prepareSwitch(sessionId: string): Promise<PrefixCursor | undefined> {
	let records: CacheEntryRecord[] = [];
	let hint: SessionStatusHint | null = null;
	try {
		({ records, hint } = await (await getEntryCache()).loadSession(sessionId));
	} catch {
		// Cache read failure: plain switch, full replace.
		return undefined;
	}
	const cursor = computeCursor(records);
	if (cursor) beginSessionCandidate(sessionId, seedDocument(records, hint ?? undefined));
	return cursor ?? undefined;
}

function open(): Promise<EntryCacheStore> {
	return new Promise<EntryCacheStore>((resolve, reject) => {
		if (typeof indexedDB === "undefined") {
			resolve(new InMemoryEntryCacheStore());
			return;
		}
		const request = indexedDB.open(DB_NAME, FORMAT_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			// Any prior version is a different cache format — drop it wholesale.
			for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
			const entries = db.createObjectStore(ENTRIES_STORE, { keyPath: ["sessionId", "ord"] });
			entries.createIndex("sessionId", "sessionId", { unique: false });
			db.createObjectStore(SESSIONS_STORE, { keyPath: "sessionId" });
		};
		request.onsuccess = () => resolve(new IdbEntryCacheStore(request.result));
		request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
		request.onblocked = () => reject(new Error("indexedDB open blocked by another tab"));
	});
}

// ============================================================================
// Cache policy — pure, browser-safe (ADR 09).
//
// The client cache is a disposable derivative of server data: committed
// entries only, one deterministic lazy-stripped projection, keyed by
// (sessionId, ord). All decisions live here; storage adapters (IndexedDB in
// web/, in-memory stores in tests) consume CacheEntryRecords.
//
// Invariants (ADR 09 §Cache Projection and Storage):
//   - only committed entries with server-assigned `ord` are cached;
//   - provisional entries (`pending:*`) are never cached;
//   - cached entries use one deterministic projection with all lazy fields
//     null, so concurrent writers converge on identical records;
//   - the cursor is derived from the contiguous record prefix, never from
//     separate mutable metadata.
// ============================================================================

import { deriveStatus, stripLazyFields } from "./document.ts";
import type { Document, Entry, PrefixCursor, Status } from "./types.ts";

/** One cached entry. The storage key is `[sessionId, ord]`. */
export interface CacheEntryRecord {
	sessionId: string;
	/** File position of the entry (Entry.ord). Key part 1. */
	ord: number;
	/** Entry id. Key part 2 — also stored inside `entry` for direct reads. */
	entryId: string;
	/** Deterministic lazy-stripped projection. Immutable once written. */
	entry: Entry;
}

/** Cached status hint — a paint hint only, never authoritative. Every
 * initial sync replaces status with current server values. */
export type SessionStatusHint = Partial<Status>;

/**
 * Storage adapter interface (ADR 09). The IndexedDB implementation lives in
 * web/src/infra/persist/entryCache.ts; this interface and the in-memory
 * implementation are browser-safe core so policy tests run without a DOM.
 */
export interface EntryCacheStore {
	/** Load one session's cached records (ord order) and its status hint. */
	loadSession(sessionId: string): Promise<{ records: CacheEntryRecord[]; hint: SessionStatusHint | null }>;
	/** All-or-nothing delta write in one transaction. A failed write leaves
	 * the previous prefix unchanged. */
	writeEntries(sessionId: string, records: CacheEntryRecord[], hint?: SessionStatusHint): Promise<void>;
	/** Delete the session's existing records and insert replacements in one
	 * transaction (cache repair path). */
	replaceSession(sessionId: string, records: CacheEntryRecord[], hint?: SessionStatusHint): Promise<void>;
}

/** In-memory EntryCacheStore — test seam and fallback when IndexedDB is
 * unavailable. Mirrors the IndexedDB adapter's semantics: one map per
 * session keyed by ord, hint last-write-wins. */
export class InMemoryEntryCacheStore implements EntryCacheStore {
	private sessions = new Map<string, { records: Map<number, CacheEntryRecord>; hint: SessionStatusHint | null }>();

	async loadSession(sessionId: string): Promise<{ records: CacheEntryRecord[]; hint: SessionStatusHint | null }> {
		const session = this.sessions.get(sessionId);
		if (!session) return { records: [], hint: null };
		const records = [...session.records.values()].sort((a, b) => a.ord - b.ord);
		return { records, hint: session.hint };
	}

	async writeEntries(sessionId: string, records: CacheEntryRecord[], hint?: SessionStatusHint): Promise<void> {
		if (records.length === 0 && hint === undefined) return;
		const session = this.sessions.get(sessionId) ?? { records: new Map(), hint: null };
		for (const record of records) session.records.set(record.ord, record);
		if (hint !== undefined) session.hint = hint;
		this.sessions.set(sessionId, session);
	}

	async replaceSession(sessionId: string, records: CacheEntryRecord[], hint?: SessionStatusHint): Promise<void> {
		const next = new Map<number, CacheEntryRecord>();
		for (const record of records) next.set(record.ord, record);
		this.sessions.set(sessionId, { records: next, hint: hint ?? null });
	}
}

/**
 * Derive a prefix cursor from cached records.
 *
 * Records must cover positions exactly 0..n-1 with no gap, no duplicate, and
 * a single session id. An empty or invalid set produces no cursor — the
 * caller then falls back to a full snapshot.
 */
export function computeCursor(records: CacheEntryRecord[]): PrefixCursor | null {
	if (records.length === 0) return null;

	let sessionId: string | undefined;
	const ordToId = new Map<number, string>();
	for (const record of records) {
		if (sessionId === undefined) sessionId = record.sessionId;
		else if (record.sessionId !== sessionId) return null;
		if (!Number.isInteger(record.ord) || record.ord < 0) return null;
		if (ordToId.has(record.ord)) return null; // duplicate position
		ordToId.set(record.ord, record.entryId);
	}
	for (let i = 0; i < records.length; i++) {
		if (!ordToId.has(i)) return null; // gap
	}

	return {
		sessionId: sessionId as string,
		lastKnownId: ordToId.get(records.length - 1) as string,
		entryCount: records.length,
	};
}

/**
 * Project an entry to its deterministic cached form: all lazy fields null.
 * Cached thinking, tool arguments, tool result content, and tool result
 * details are always null; pull responses are never persisted.
 */
export function projectCacheEntry(entry: Entry): Entry {
	return stripLazyFields(entry);
}

/**
 * Plan the cache writes implied by a Document transition.
 *
 * Uses applyPatch structural sharing: unchanged entries keep their object
 * reference and produce no write. A reference change alone is not sufficient,
 * though — lazy-field pulls (pull replies filling thinking/arguments/content)
 * replace the entry object while the cached projection is identical, which
 * once rewrote hundreds of byte-identical records per pull wave. Selected
 * entries therefore also require their lazy-stripped projections to differ
 * from the base entry's. Comparison is by JSON string; key-order divergence
 * can only cause a spurious (idempotent) write, never a missed one.
 *
 * Selected entries must be committed (no `pending:*` id) and carry `ord`.
 * Records are returned in ord order so storage transactions are
 * deterministic.
 */
export function planCacheWrites(sessionId: string, before: Document, after: Document): CacheEntryRecord[] {
	const writes: CacheEntryRecord[] = [];
	for (const [id, entry] of Object.entries(after.entries)) {
		if (id.startsWith("pending:")) continue;
		if (entry.ord === undefined) continue;
		const base = before.entries[id];
		if (base === entry) continue;
		if (
			base !== undefined &&
			base.ord === entry.ord &&
			JSON.stringify(projectCacheEntry(base)) === JSON.stringify(projectCacheEntry(entry))
		) {
			continue; // only lazy (stripped) fields changed — cache content identical
		}
		writes.push({ sessionId, ord: entry.ord, entryId: id, entry: projectCacheEntry(entry) });
	}
	writes.sort((a, b) => a.ord - b.ord);
	return writes;
}

/**
 * All cacheable entries of a document, projected and ord-ordered — the
 * record set for the replace-repair path (full initial sync).
 */
export function cacheRecordsOfDocument(sessionId: string, doc: Document): CacheEntryRecord[] {
	const records: CacheEntryRecord[] = [];
	for (const [id, entry] of Object.entries(doc.entries)) {
		if (id.startsWith("pending:")) continue;
		if (entry.ord === undefined) continue;
		records.push({ sessionId, ord: entry.ord, entryId: id, entry: projectCacheEntry(entry) });
	}
	records.sort((a, b) => a.ord - b.ord);
	return records;
}

/** The cacheable status hint of a document (ADR 09: paint hint, never
 * authoritative). Stats are derived on seed, so they are not stored. */
export function statusHintOfDocument(doc: Document): SessionStatusHint {
	return {
		name: doc.status.name,
		model: doc.status.model,
		thinkingLevel: doc.status.thinkingLevel,
		contextUsage: doc.status.contextUsage,
	};
}

/**
 * Seed a Document from cached records for offline paint / mirror seeding.
 *
 * Entries are inserted in ord order. The status is derived from the entries
 * (leaf, name, model, thinking level, stats), then overlaid with the
 * non-undefined fields of `statusHint` — a paint hint only, never
 * authoritative; every initial sync replaces status and scoped models with
 * current server values. Scoped models are not cached.
 */
export function seedDocument(records: CacheEntryRecord[], statusHint?: Partial<Status>): Document {
	const sorted = [...records].sort((a, b) => a.ord - b.ord);
	const entries: Record<string, Entry> = {};
	for (const record of sorted) {
		entries[record.entryId] = record.entry;
	}

	const status = deriveStatus(entries);
	if (statusHint) {
		for (const [key, value] of Object.entries(statusHint)) {
			if (value !== undefined) {
				(status as unknown as Record<string, unknown>)[key] = value;
			}
		}
	}

	return { status, entries, scopedModels: [] };
}

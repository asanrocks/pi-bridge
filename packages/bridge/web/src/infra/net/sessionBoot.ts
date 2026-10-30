// ============================================================================
// sessionBoot — the cache-first local half of boot (ADR 09 §Client Restore
// Flow + ADR 11 §URLs). The route's session can render from the IndexedDB
// cache before and independent of the wire, and this module reads that local
// truth — value-only (ADR 19): it returns the seed (the address, the durable
// session id, and the quiesced seeded document) and writes nothing. The view
// actor decides whether the values become visible: `navigationLocalSeed`
// carries them to the navigation reactor, whose step applies the race guard
// (the wire may have claimed the view while the cache read was in flight)
// and paints.
//
// The restore is last-known-state and always renderable; the connection
// gates capabilities (sync, mutation), never rendering.
// ============================================================================

import type { CacheEntryRecord, Document, SessionStatusHint } from "../../../../src/core/index.ts";
import { seedDocument } from "../../../../src/core/index.ts";
import { lookupSessionId } from "../persist/addressIndex.ts";
import { getEntryCache } from "../persist/entryCache.ts";

/** Injectable seams (tests): the address→id map and the cache read. */
export interface LocalRestoreDeps {
	lookupSessionId: (projectId: string, stem: string) => string | undefined;
	loadSession: (sessionId: string) => Promise<{ records: CacheEntryRecord[]; hint: SessionStatusHint | null }>;
}

const defaultLocalRestoreDeps: LocalRestoreDeps = {
	lookupSessionId,
	loadSession: (sessionId) => getEntryCache().then((cache) => cache.loadSession(sessionId)),
};

/** What a local restore produced: the values, and nothing else. The view
 * actor decides whether they become visible. */
export interface LocalSessionSeed {
	/** The address the seed restores. */
	readonly projectId: string;
	readonly stem: string;
	/** The durable session id the cached records belong to. */
	readonly sessionId: string;
	/** The seeded document — last-known state, never authoritative. */
	readonly doc: Document;
}

/**
 * Read the route's session from the local cache, before and independent of
 * the wire. Returns null unless the address's session id is remembered and
 * the cache holds records: with no local truth there is nothing to render,
 * and the address stays unclaimed so the Launcher's down states show while
 * connecting.
 *
 * The seeded status is quiesced: the cached hint may describe a mid-flight
 * turn (streaming, compaction, pending steer) that can never progress without
 * the daemon, which would render as an eternal spinner. The initial sync
 * restores the authoritative status.
 */
export async function restoreLocalSession(
	projectId: string,
	stem: string,
	deps: LocalRestoreDeps = defaultLocalRestoreDeps,
): Promise<LocalSessionSeed | null> {
	const sessionId = deps.lookupSessionId(projectId, stem);
	if (!sessionId) return null;
	let records: CacheEntryRecord[] = [];
	let hint: SessionStatusHint | null = null;
	try {
		({ records, hint } = await deps.loadSession(sessionId));
	} catch {
		return null; // cache read failure: no local truth to render
	}
	if (records.length === 0) return null;

	const doc = seedDocument(records, hint ?? undefined);
	doc.status.isStreaming = false;
	doc.status.isCompacting = false;
	doc.status.pendingSteer = [];
	return { projectId, stem, sessionId, doc };
}

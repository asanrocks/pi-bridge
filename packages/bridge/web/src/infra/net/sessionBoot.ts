// ============================================================================
// sessionBoot — the cache-first local half of boot (ADR 09 §Client Restore
// Flow + ADR 11 §URLs). The route's session renders from the IndexedDB cache
// before and independent of the wire; the wire half — staging, the open RPC,
// initial-sync commit, and fallback — is the navigation reactor
// (`navigation.ts`), which also owns the cache base this module seeds
// against.
//
// The restore is last-known-state and always renderable; the connection
// gates capabilities (sync, mutation), never rendering. The race guard is
// store-based on purpose: navigation maintains exactly the invariants the
// guard reads — the address is staged before the RPC resolves, and the
// durable session id lands only with the initial sync — so the guard is one
// place, reading one owner's publication.
// ============================================================================

import { type CacheEntryRecord, type SessionStatusHint, seedDocument } from "../../../../src/core/index.ts";
import { lookupSessionId } from "../persist/addressIndex.ts";
import { getEntryCache } from "../persist/entryCache.ts";
import { getStore } from "../state/store.tsx";

/** Injectable seams (tests): the address→id map and the cache read. */
export interface LocalRestoreDeps {
	lookupSessionId: (projectId: string, stem: string) => string | undefined;
	loadSession: (sessionId: string) => Promise<{ records: CacheEntryRecord[]; hint: SessionStatusHint | null }>;
}

const defaultLocalRestoreDeps: LocalRestoreDeps = {
	lookupSessionId,
	loadSession: (sessionId) => getEntryCache().then((cache) => cache.loadSession(sessionId)),
};

/**
 * Restore the route's session from the local cache, before and independent of
 * the wire. No-op unless the address's session id is remembered and the cache
 * holds records: with no local truth there is nothing to render, and the
 * address stays unclaimed so the Launcher's down states show while
 * connecting. Nothing here touches the mirror or `cacheBase` — the wire half
 * (navigation) owns those once a connection exists.
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
): Promise<void> {
	const sessionId = deps.lookupSessionId(projectId, stem);
	if (!sessionId) return;
	let records: CacheEntryRecord[] = [];
	let hint: SessionStatusHint | null = null;
	try {
		({ records, hint } = await deps.loadSession(sessionId));
	} catch {
		return; // cache read failure: no local truth to render
	}
	if (records.length === 0) return;

	const store = getStore();
	// Race guard: the wire may have advanced while the cache read was in
	// flight — never let stale cache overwrite wire data. Apply only when the
	// address is still unclaimed, or the claimed address is this one and
	// nothing has rendered for it yet (the wire half stages the address before
	// its RPC resolves). `activeSessionId` set means an address-bearing frame
	// already landed — even for an empty session — so the wire is authoritative.
	const s = store.getState();
	const unclaimed = s.currentProjectId === null && s.currentStem === null;
	const matchesEmpty =
		s.currentProjectId === projectId && s.currentStem === stem && Object.keys(s.document.entries).length === 0;
	if ((!unclaimed && !matchesEmpty) || s.activeSessionId !== null) return;

	const doc = seedDocument(records, hint ?? undefined);
	doc.status.isStreaming = false;
	doc.status.isCompacting = false;
	doc.status.pendingSteer = [];

	// Address first, then the id (the pipeline's ordering rule):
	// setCurrentSession unbinds a stale id on an address change, so the pair
	// must land in this order.
	store.getState().setCurrentSession(projectId, stem);
	store.getState().setActiveSessionId(sessionId);
	store.getState().applyReplace(doc);
}

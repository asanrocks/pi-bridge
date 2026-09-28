// ============================================================================
// sessionBoot — cache-first boot (ADR 09 §Client Restore Flow + ADR 11
// §URLs). Two halves of one boot:
//   - restoreLocalSession — the local half, run at mount before the wire:
//     render the route's session from the IndexedDB cache when the address's
//     session id is remembered. The document is always last-known-state and
//     always renderable; the connection gates capabilities (sync, mutation),
//     never rendering — so a cold boot is the same shape as a reconnect that
//     still holds its document in memory.
//   - openSessionAddress — the wire half, run at boot and reconnect once the
//     init RPC resolves: seed the mirror (from the already-restored store
//     document when present, else from the cache), derive a prefix cursor,
//     and call openSession. A failed open falls back to the Project page.
// ============================================================================

import {
	type BridgeClient,
	type CacheEntryRecord,
	computeCursor,
	type SessionStatusHint,
	seedDocument,
} from "../../../../src/core/index.ts";
import { writeRoute } from "../lib/routes.ts";
import { lookupSessionId } from "../persist/addressIndex.ts";
import { getEntryCache } from "../persist/entryCache.ts";
import { getStore } from "../state/store.tsx";
import { cacheBase } from "./connectionPipeline.ts";

/** A failed open falls back to the Project page (ADR 11): the stem no longer
 *  resolves (deleted file, or an unflushed session after a daemon restart),
 *  so the seeded cache/paint and any session identity must be dropped. */
function fallbackToProjectPage(projectId: string): void {
	getStore().getState().clearCurrentSession(projectId);
	writeRoute({ kind: "project", projectId });
}

// ---------------------------------------------------------------------------
// Local restore — the cache-first half of boot
// ---------------------------------------------------------------------------

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
 * (`openSessionAddress`) owns those once a connection exists.
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

/**
 * Open a session address — the wire half of boot (ADR 09 §Client Restore
 * Flow). At boot the store is typically already seeded by
 * `restoreLocalSession`, so the sameSession branch reuses the store document
 * for the mirror and cache base; at reconnect the store holds the in-memory
 * document from before the drop, which is richer than the cache. The
 * cache-load branch remains for opens without a prior restore (the alias
 * path). Cold load without a remembered id: plain open, full replace. A
 * failure (unknown stem, deleted file, unflushed session after restart) falls
 * back to the Project page — the server left any previous attachment
 * untouched, so the client must not claim the new address either.
 *
 * `isSuperseded` is the stale-connection guard: every awaited step re-checks
 * it, because a newer connection may have taken over mid-open.
 *
 * `viaAlias` (ADR 13): the address was reached through `/@<alias>`, so the
 * alias flag is already set and the pipeline suppresses route writes; a
 * failed open still lands on the resolved Project's home (an explicit URL,
 * leaving the alias form).
 */
export async function openSessionAddress(
	client: BridgeClient,
	projectId: string,
	stem: string,
	isSuperseded: () => boolean,
	options: { viaAlias?: boolean } = {},
): Promise<void> {
	const store = getStore();
	if (options.viaAlias) store.getState().setAddressViaAlias(true);
	store.getState().setCurrentSession(projectId, stem);
	const sessionId = lookupSessionId(projectId, stem);
	if (!sessionId) {
		const reply = await client.openSession(projectId, stem);
		if (isSuperseded()) return;
		if (!reply.ok) fallbackToProjectPage(projectId);
		return;
	}
	let records: CacheEntryRecord[] = [];
	let hint: SessionStatusHint | null = null;
	try {
		({ records, hint } = await (await getEntryCache()).loadSession(sessionId));
	} catch {
		// Cache read failure: plain open, full replace.
	}
	if (isSuperseded()) return; // superseded mid-load
	const state = store.getState();
	const sameSession = state.activeSessionId === sessionId && Object.keys(state.document.entries).length > 0;
	const seed = sameSession ? state.document : seedDocument(records, hint ?? undefined);
	client.mirror.applyReplace(seed);
	// The seed mirrors the cache content — it becomes the session's cache
	// base so the initial-sync delta's flush persists only new entries.
	cacheBase.value = { sessionId, doc: seed };
	if (!sameSession && records.length > 0) {
		store.getState().applyReplace(seed);
	}
	const cursor = computeCursor(records);
	const reply = await client.openSession(projectId, stem, cursor ?? undefined);
	if (isSuperseded()) return;
	if (!reply.ok) fallbackToProjectPage(projectId);
}

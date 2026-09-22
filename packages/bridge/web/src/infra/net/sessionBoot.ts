// ============================================================================
// sessionBoot — the route-driven session open at boot and reconnect (ADR 09
// §Client Restore Flow + ADR 11 §URLs). Seeds the mirror from the IndexedDB
// cache when the address's session id is remembered, so the initial sync can
// be a cursor delta instead of a full replace. A failed open falls back to
// the Project page.
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

/**
 * Open a session address, seeding the mirror from cache when the address's
 * session id is known (ADR 09 §Client Restore Flow). Cold load without a
 * remembered id: plain open, full replace. A failure (unknown stem, deleted
 * file, unflushed session after restart) falls back to the Project page —
 * the server left any previous attachment untouched, so the client must not
 * claim the new address either.
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

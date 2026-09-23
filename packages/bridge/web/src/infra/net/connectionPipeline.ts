// ============================================================================
// connectionPipeline — per-connection push ingestion. One pipeline is created
// per WebSocket and owns:
//   - patch coalescing (store writes coalesced to one per animation frame
//     while visible, ~1s while hidden),
//   - the ADR 09 cache write-through (delta writes planned against the
//     session's cache base) and the full-replace repair path,
//   - session-candidate promotion for initial-sync deltas (ADR 09),
//   - the store/route/identity updates on initial-sync frames.
// After cleanup() the pipeline is frozen: a dead or superseded connection
// never writes into the store or the cache.
// ============================================================================

import {
	type BridgeClient,
	cacheRecordsOfDocument,
	type Document,
	type PatchOp,
	planCacheWrites,
	type ServerPushMessage,
	statusHintOfDocument,
} from "../../../../src/core/index.ts";
import { writeRoute } from "../lib/routes.ts";
import { rememberAddress } from "../persist/addressIndex.ts";
import { getEntryCache } from "../persist/entryCache.ts";
import { getStore } from "../state/store.tsx";
import { promoteSessionCandidate } from "./sessionCandidate.ts";

// Last cache-written base per session (ADR 09): planCacheWrites only sees
// "unchanged" when before/after share entry references, which holds only for
// same-session documents evolved via applyPatch. Using the store's previous
// document as `before` made every session switch rewrite the entire new
// session — documents of different sessions share no references. Seeded at
// attach/promotion, set by the replace repair path, advanced on every delta
// write; a stale or failed write self-heals via the repair path. Module
// scope: both the boot path (sessionBoot) and this pipeline write it, and
// the tab has at most one live connection (staleness guards protect every
// writer).
export const cacheBase: { value: { sessionId: string; doc: Document } | null } = { value: null };

export interface ConnectionPipeline {
	/** Push handler for BridgeClient.onPush. No-op after cleanup. */
	onPush(push: ServerPushMessage): void;
	/** Tear down coalescing state + the visibility listener; freeze writes. */
	cleanup(): void;
}

export function createConnectionPipeline(client: BridgeClient): ConnectionPipeline {
	let disposed = false;

	// ── Patch coalescing ────────────────────────────────────────────────
	// The mirror is always current (BridgeClient applies patches before
	// onPush fires). Store writes are coalesced to one per animation
	// frame (visible) or ~1s (hidden), capping the urgent render rate at
	// the flush cadence rather than the token cadence. A `replace` push
	// flushes immediately (load-bearing: reconnect/session switch resets
	// state wholesale).
	let pendingOps: PatchOp[] | null = null;
	let rafId: number | null = null;
	let hideTimer: ReturnType<typeof setTimeout> | null = null;

	const cancelPending = () => {
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
		if (hideTimer !== null) {
			clearTimeout(hideTimer);
			hideTimer = null;
		}
	};

	const flush = (cacheMode: "delta" | "skip" = "delta") => {
		cancelPending();
		const ops = pendingOps;
		pendingOps = null;
		// Frozen pipeline: a dead or superseded connection must not write
		// its (frozen) mirror into the store.
		if (disposed) return;
		const store = getStore();
		if (ops) {
			for (const op of ops) {
				if (op.op === "move" && "from" in op && "path" in op) {
					const from = (op as { from: string }).from;
					const to = (op as { path: string }).path;
					const oldId = extractEntryId(from);
					const newId = extractEntryId(to);
					if (oldId && newId && oldId !== newId) {
						store.getState().migrateExpandKeys(oldId, newId);
						store.getState().migrateFocusedTurnId(oldId, newId);
					}
				}
			}
		}
		const after = client.mirror.document;
		store.getState().applyReplace(after);
		// Write-through (ADR 09): persist committed-entry deltas under the
		// active session, planned against the session's cache base.
		if (cacheMode === "delta") {
			const sessionId = store.getState().activeSessionId;
			if (sessionId) {
				const baseDoc: Document =
					cacheBase.value !== null && cacheBase.value.sessionId === sessionId
						? cacheBase.value.doc
						: { status: after.status, entries: {} };
				const writes = planCacheWrites(sessionId, baseDoc, after);
				cacheBase.value = { sessionId, doc: after };
				if (writes.length > 0) {
					void getEntryCache()
						.then((cache) => cache.writeEntries(sessionId, writes))
						.catch(() => {});
				}
			}
		}
	};

	const scheduleFlush = () => {
		if (document.hidden) {
			if (hideTimer === null) hideTimer = setTimeout(flush, 1000);
		} else if (rafId === null) {
			rafId = requestAnimationFrame(() => flush());
		}
	};

	const onVisibilityChange = () => {
		if (document.hidden) {
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			if (pendingOps !== null && hideTimer === null) {
				hideTimer = setTimeout(flush, 1000);
			}
		} else {
			if (hideTimer !== null) {
				clearTimeout(hideTimer);
				hideTimer = null;
			}
			if (pendingOps !== null) flush();
		}
	};

	// ── Push handler ───────────────────────────────────────────────────
	const onPush = (push: ServerPushMessage) => {
		if (disposed) return;
		const store = getStore();
		// ADR 13: while viewing through an alias (`/@latest`) the URL keeps the
		// alias form — address-bearing frames commit the store address only.

		// Project-scoped session-list refresh (ADR 11). The sidebar folder
		// cache is the only consumer: refresh a page that is already cached;
		// never load one just because the push arrived (folders fetch on
		// expand). Loading pages heal via their in-flight fetch.
		if (push.kind === "sessions_changed") {
			for (const row of push.sessions) rememberAddress(row.projectId, row.stem, row.sessionId);
			if (store.getState().sessionPages[push.projectId]?.kind === "ready") {
				store
					.getState()
					.setSessionPage(push.projectId, push.sessions, push.hasMore === true, push.nextCursor ?? null);
			}
			return;
		}

		// Global active/streaming snapshot.
		if (push.kind === "active_sessions_changed") {
			for (const row of push.sessions) rememberAddress(row.projectId, row.stem, row.sessionId);
			store.getState().setActiveSessions(push.sessions);
			return;
		}

		// Daemon-global pinned list (ADR 15): one concept, replaced wholesale.
		if (push.kind === "pinned_models_changed") {
			store.getState().setPinnedModels(push.pinnedModels);
			return;
		}

		// replace: flush barrier + cache repair (ADR 09). The mirror already
		// holds the snapshot. A replace always carries the session ref
		// (ADR 11) — it is an initial sync.
		if (push.kind === "replace") {
			flush("skip");
			const ref = push.session;
			store.getState().setActiveSessionId(ref.sessionId);
			store.getState().setCurrentSession(ref.projectId, ref.stem);
			rememberAddress(ref.projectId, ref.stem, ref.sessionId);
			if (!store.getState().addressViaAlias) {
				writeRoute({ kind: "session", projectId: ref.projectId, stem: ref.stem });
			}
			const doc = client.mirror.document;
			const repairRecords = cacheRecordsOfDocument(ref.sessionId, doc);
			// The repair rewrites the whole session by design — the snapshot
			// becomes the new cache base.
			cacheBase.value = { sessionId: ref.sessionId, doc };
			void getEntryCache()
				.then((cache) => cache.replaceSession(ref.sessionId, repairRecords, statusHintOfDocument(doc)))
				.catch(() => {});
			store.getState().bumpPullTick();
			return;
		}

		// Initial-sync delta (ADR 09): a patch frame carrying `session`. If a
		// candidate mirror is pending for that session, apply the delta to
		// the candidate and promote it atomically — the mirror's own
		// application ran against the old-session base and is discarded.
		if (push.kind === "patch" && push.session) {
			const ref = push.session;
			const promoted = promoteSessionCandidate(ref.sessionId, push.ops);
			if (promoted) {
				client.mirror.applyReplace(promoted.doc);
				// The candidate was seeded from the cached records — its
				// pre-promotion document IS the cache base, so the flush below
				// persists only the delta's new entries.
				cacheBase.value = { sessionId: ref.sessionId, doc: promoted.before };
			}
			store.getState().setActiveSessionId(ref.sessionId);
			store.getState().setCurrentSession(ref.projectId, ref.stem);
			rememberAddress(ref.projectId, ref.stem, ref.sessionId);
			if (!store.getState().addressViaAlias) {
				writeRoute({ kind: "session", projectId: ref.projectId, stem: ref.stem });
			}
			flush(); // barrier + delta write-through under the new session id
			store.getState().bumpPullTick();
			return;
		}

		// Live patch without an address: buffer ops, schedule a flush.
		if (push.kind === "patch") {
			if (pendingOps === null) pendingOps = [];
			for (const op of push.ops) pendingOps.push(op);
			scheduleFlush();
		}
	};

	document.addEventListener("visibilitychange", onVisibilityChange);

	return {
		onPush,
		cleanup() {
			disposed = true;
			document.removeEventListener("visibilitychange", onVisibilityChange);
			cancelPending();
			pendingOps = null;
		},
	};
}

function extractEntryId(path: string): string | null {
	const match = path.match(/^\/entries\/([^/]+)/);
	return match ? match[1] : null;
}

// ============================================================================
// connectionPipeline — per-connection push ingestion. One pipeline is created
// per WebSocket and owns:
//   - patch coalescing (store writes coalesced to one per animation frame
//     while visible, ~1s while hidden),
//   - the ADR 09 cache write-through (delta writes planned against the
//     session's cache base) and the full-replace repair path.
// Selection is the navigation reactor's (ADR 09/18's single-owner rule):
// address-bearing initial-sync frames and session_closed pushes are forwarded
// there (navigationInitialSync / navigationSessionClosed), and this module
// publishes the document, the revision, and the cache records for the
// observation the reactor names. After cleanup() the pipeline is frozen: a
// dead or superseded connection never writes into the store or the cache.
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
import { rememberAddress } from "../persist/addressIndex.ts";
import { getEntryCache } from "../persist/entryCache.ts";
import { getStore } from "../state/store.tsx";
import { cacheBase, navigationInitialSync, navigationSessionClosed } from "./navigation.ts";

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
	// state wholesale), as does any patch touching `/status` (see the
	// live-patch handler).
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
		pendingOps = null;
		// Frozen pipeline: a dead or superseded connection must not write
		// its (frozen) mirror into the store.
		if (disposed) return;
		const store = getStore();
		const after = client.mirror.document;
		// One store write: the document and the revision it was published with
		// describe the same mirror snapshot, so a same-shape replacement can
		// never pair new content with a stale revision (or vice versa).
		store.getState().applyReplace(after, client.mirror.revision);
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

		// Terminal ownership (host): the live runtime behind an address ended
		// (closeSession/archiveSession) and the server has already severed this
		// connection's attachment, so the document on screen can never progress
		// again. When it names the rendered Session, land on the Project home
		// like a failed open — the route, the address, and the session identity
		// all go, and a later command cannot reach a disposed runtime. A close of
		// some other Session changes nothing here: the list pushes cover it.
		if (push.kind === "session_closed") {
			navigationSessionClosed(push.projectId, push.stem);
			return;
		}

		// replace: flush barrier + cache repair (ADR 09). The mirror already
		// holds the snapshot. A replace always carries the session ref
		// (ADR 11) — it is an initial sync.
		if (push.kind === "replace") {
			flush("skip");
			// The address, the identity, and the route are the navigation
			// reactor's; this module publishes document and cache state for
			// the observation it names.
			navigationInitialSync(push.session, null);
			const ref = push.session;
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
			// Promotion and the address commit are the navigation reactor's
			// (it owns the candidate and decides whether this frame commits);
			// the flush below then publishes the document and writes the
			// delta through under the committed session id.
			navigationInitialSync(push.session, push.ops);
			flush(); // barrier + delta write-through under the new session id
			store.getState().bumpPullTick();
			return;
		}

		// Live patch without an address: buffer ops, then flush or schedule.
		// A patch touching /status is urgent — it flushes synchronously,
		// bypassing the coalescing timer: that timer (rAF visible, 1s hidden)
		// never fires in a backgrounded tab, so a coalesced status write
		// would defer the streaming→idle transition to the resume flush,
		// where document.hidden reads stale — losing the store-level
		// turn-completion notification (useStatusNotifications). Status
		// patches are rare (turn boundaries, status renames), so this costs
		// nothing against the token-append coalescing.
		if (push.kind === "patch") {
			if (pendingOps === null) pendingOps = [];
			for (const op of push.ops) pendingOps.push(op);
			// A live patch that replaced an entry the mirror already held
			// (sealing in place, or an authoritative rewrite) advanced the
			// mirror's revision; the flush publishes the document and its
			// revision together, and the projection re-runs on the revision —
			// the structural cache key cannot see a same-id content change.
			if (push.ops.some((op) => op.path.startsWith("/status"))) flush();
			else scheduleFlush();
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

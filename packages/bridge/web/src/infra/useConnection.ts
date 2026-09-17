// ============================================================================
// useConnection — WebSocket lifecycle + BridgeClient → store integration.
// Owns the transport and the connection state machine: connecting → connected
// | init_failed, and on drop → reconnecting → unreachable (after threshold).
// The URL (ADR 11) is the navigation source of truth: boot and every reconnect
// re-resolves `/`, `/<projectId>`, or `/<projectId>/<stem>`.
// ============================================================================

import { useCallback, useEffect, useRef } from "react";
import {
	BridgeClient,
	type BridgeTransport,
	type CacheEntryRecord,
	cacheRecordsOfDocument,
	computeCursor,
	type Document,
	type GetDaemonInfoReply,
	type JsonValue,
	type ListActiveSessionsReply,
	type PatchOp,
	planCacheWrites,
	type ServerPushMessage,
	type SessionStatusHint,
	seedDocument,
	statusHintOfDocument,
} from "../../../src/core/index.ts";
import { lookupSessionId, rememberAddress } from "./addressIndex.ts";
import { setGlobalClient } from "./client.ts";
import { getEntryCache } from "./entryCache.ts";
import { drainWantsOutbox } from "./pullLoop.ts";
import { parseRoute, writeRoute } from "./routes.ts";
import { promoteSessionCandidate } from "./sessionCandidate.ts";
import type { ConnectionState } from "./store.ts";
import { getStore } from "./store.tsx";
import { setWantsDrainer } from "./wants.ts";

const CONNECTION_TOAST_ID = "connection";
// After this many failed reconnect attempts, copy shifts to "Can't reach".
const UNREACHABLE_THRESHOLD = 5;
// If the init RPC (getDaemonInfo + listActiveSessions) doesn't resolve in this
// window, treat it as init_failed rather than hanging in "connecting".
const INIT_TIMEOUT_MS = 8000;

// Last cache-written base per session (ADR 09): planCacheWrites only sees
// "unchanged" when before/after share entry references, which holds only for
// same-session documents evolved via applyPatch. Using the store's previous
// document as `before` made every session switch rewrite the entire new
// session — documents of different sessions share no references. Seeded at
// attach/promotion, set by the replace repair path, advanced on every delta
// write; a stale or failed write self-heals via the repair path. Module scope:
// both the open path and the onPush handlers write it, and the tab has at most
// one live connection (stale-client guards protect every writer).
let cacheBase: { sessionId: string; doc: Document } | null = null;

// ---------------------------------------------------------------------------
// Transport adapter
// ---------------------------------------------------------------------------

class WsTransport implements BridgeTransport {
	private ws: WebSocket;
	onMessage: ((data: string) => void) | null = null;

	constructor(ws: WebSocket) {
		this.ws = ws;
		ws.onmessage = (ev) => {
			if (this.onMessage) this.onMessage(ev.data as string);
		};
	}

	send(data: string): void {
		if (this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(data);
		}
	}
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

function backoff(attempt: number): number {
	const base = 500;
	const cap = 5000;
	const jitter = Math.random();
	return Math.min(base * 2 ** attempt, cap) * (1 + jitter * 0.3);
}

// ---------------------------------------------------------------------------
// useConnection
// ---------------------------------------------------------------------------

export function useConnection(): { retry: () => void } {
	const clientRef = useRef<BridgeClient | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const disposedRef = useRef(false);
	const wasConnectedRef = useRef(false);
	// Reconnect attempt counter; 0 while connected. Drives the
	// connecting→unreachable threshold and backoff exponent.
	const attemptRef = useRef(0);

	/** A failed open falls back to the Project page (ADR 11): the stem no longer
	 * resolves (deleted file, or an unflushed session after a daemon restart),
	 * so the seeded cache/paint and any session identity must be dropped. */
	const fallbackToProjectPage = useCallback((projectId: string) => {
		getStore().getState().clearCurrentSession(projectId);
		writeRoute({ kind: "project", projectId });
	}, []);

	/**
	 * Open a session address, seeding the mirror from cache when the address's
	 * session id is known (ADR 09 §Client Restore Flow). Cold load without a
	 * remembered id: plain open, full replace. A failure (unknown stem, deleted
	 * file, unflushed session after restart) falls back to the Project page —
	 * the server left any previous attachment untouched, so the client must not
	 * claim the new address either.
	 */
	const openSessionAddress = useCallback(
		async (client: BridgeClient, projectId: string, stem: string) => {
			const store = getStore();
			store.getState().setCurrentSession(projectId, stem);
			const sessionId = lookupSessionId(projectId, stem);
			if (!sessionId) {
				const reply = await client.openSession(projectId, stem);
				if (clientRef.current !== client) return;
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
			if (clientRef.current !== client) return; // superseded mid-load
			const state = store.getState();
			const sameSession = state.activeSessionId === sessionId && Object.keys(state.document.entries).length > 0;
			const seed = sameSession ? state.document : seedDocument(records, hint ?? undefined);
			client.mirror.applyReplace(seed);
			// The seed mirrors the cache content — it becomes the session's cache
			// base so the initial-sync delta's flush persists only new entries.
			cacheBase = { sessionId, doc: seed };
			if (!sameSession && records.length > 0) {
				store.getState().applyReplace(seed);
			}
			const cursor = computeCursor(records);
			const reply = await client.openSession(projectId, stem, cursor ?? undefined);
			if (clientRef.current !== client) return;
			if (!reply.ok) fallbackToProjectPage(projectId);
		},
		[fallbackToProjectPage],
	);

	const initDaemonInfo = useCallback(
		async (client: BridgeClient) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const timeout = new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("daemon did not respond")), INIT_TIMEOUT_MS);
				});
				const [daemonReply, activeReply] = await Promise.race([
					Promise.all([client.getDaemonInfo(), client.listActiveSessions()]),
					timeout,
				]);

				// Stale-client guard: a superseded connection must not write into the store.
				if (clientRef.current !== client) return;

				const store = getStore();

				// Daemon info — Projects, models, thinking levels, dev mode
				const info = daemonReply as unknown as GetDaemonInfoReply;
				if (info.models) {
					store.getState().setModels(info.models, info.thinkingLevels ?? []);
				}
				store.getState().setProjects(info.projects ?? []);
				if (info.devMode) {
					store.getState().setDevMode(true);
					hookConsole(client);
				}

				// Global active/streaming snapshot
				const active = activeReply as unknown as ListActiveSessionsReply;
				const activeSessions = active.sessions ?? [];
				for (const row of activeSessions) rememberAddress(row.projectId, row.stem, row.sessionId);
				store.getState().setActiveSessions(activeSessions);

				// Sidebar folder pages are connection-scoped: a reconnect may be
				// talking to a restarted daemon, so drop them. Expanded folders see
				// the reset (new record object) and refetch through their effects.
				store.getState().resetSessionPages();

				// Route-driven open (ADR 11). The URL is read at boot and after
				// every reconnect; it is not a second live navigation machine.
				const route = parseRoute(window.location.pathname);
				if (route.kind === "session") {
					const known = (info.projects ?? []).some((p) => p.id === route.projectId);
					if (!known) {
						store.getState().clearCurrentSession();
						writeRoute({ kind: "launcher" });
					} else {
						await openSessionAddress(client, route.projectId, route.stem);
					}
				} else if (route.kind === "project") {
					const known = (info.projects ?? []).some((p) => p.id === route.projectId);
					if (!known) {
						store.getState().clearCurrentSession();
						writeRoute({ kind: "launcher" });
					} else {
						// The home is compose-only — bind the address; its sessions are
						// browsed from the sidebar, so there is no page fetch.
						store.getState().setCurrentSession(route.projectId, null);
					}
				} else {
					store.getState().clearCurrentSession();
					writeRoute({ kind: "launcher" });
				}

				if (clientRef.current !== client) return;

				// Success: mark connected, reset the doom counter, clear the toast.
				wasConnectedRef.current = true;
				attemptRef.current = 0;
				store.getState().dismissToast(CONNECTION_TOAST_ID);
				store.getState().setConnectionState({ kind: "connected" });
			} catch (err) {
				if (clientRef.current !== client) return;
				const msg = err instanceof Error ? err.message : String(err);
				getStore().getState().setConnectionState({ kind: "init_failed", error: msg });
				getStore().getState().pushToast(CONNECTION_TOAST_ID, `Daemon unresponsive: ${msg}`);
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
		[openSessionAddress],
	);

	const connect = useCallback(() => {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const wsUrl = `${protocol}//${window.location.host}`;
		const ws = new WebSocket(wsUrl);
		wsRef.current = ws;

		// Per-connection coalescing teardown. Populated by onopen (the flush /
		// visibility-listener closures live there, where `client` is in scope);
		// invoked by onclose so a dead/superseded socket never leaks its
		// listener or strands a pending rAF.
		let connectionCleanup: (() => void) | null = null;

		ws.onopen = () => {
			if (disposedRef.current || wsRef.current !== ws) {
				ws.close();
				return;
			}

			const transport = new WsTransport(ws);
			const client = new BridgeClient(transport);
			clientRef.current = client;
			setGlobalClient(client);

			// ── Patch coalescing ────────────────────────────────────────────
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
				// Stale connection: a superseded socket must not write its
				// (frozen) mirror into the store.
				if (clientRef.current !== client) return;
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
							cacheBase !== null && cacheBase.sessionId === sessionId
								? cacheBase.doc
								: { status: after.status, entries: {}, scopedModels: [] };
						const writes = planCacheWrites(sessionId, baseDoc, after);
						cacheBase = { sessionId, doc: after };
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

			connectionCleanup = () => {
				document.removeEventListener("visibilitychange", onVisibilityChange);
				cancelPending();
				pendingOps = null;
			};

			client.onPush = (push: ServerPushMessage) => {
				// Stale-client guard: a superseded connection must not write
				// its mirror into the store.
				if (clientRef.current !== client) return;
				const store = getStore();

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

				// replace: flush barrier + cache repair (ADR 09). The mirror already
				// holds the snapshot. A replace always carries the session ref
				// (ADR 11) — it is an initial sync.
				if (push.kind === "replace") {
					flush("skip");
					const ref = push.session;
					store.getState().setActiveSessionId(ref.sessionId);
					store.getState().setCurrentSession(ref.projectId, ref.stem);
					rememberAddress(ref.projectId, ref.stem, ref.sessionId);
					writeRoute({ kind: "session", projectId: ref.projectId, stem: ref.stem });
					const doc = client.mirror.document;
					const repairRecords = cacheRecordsOfDocument(ref.sessionId, doc);
					// The repair rewrites the whole session by design — the snapshot
					// becomes the new cache base.
					cacheBase = { sessionId: ref.sessionId, doc };
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
						cacheBase = { sessionId: ref.sessionId, doc: promoted.before };
					}
					store.getState().setActiveSessionId(ref.sessionId);
					store.getState().setCurrentSession(ref.projectId, ref.stem);
					rememberAddress(ref.projectId, ref.stem, ref.sessionId);
					writeRoute({ kind: "session", projectId: ref.projectId, stem: ref.stem });
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

			// Don't mark connected until the init RPC resolves — the WS being
			// open is necessary, not sufficient.
			void initDaemonInfo(client);
		};

		ws.onclose = () => {
			// Tear down this connection's coalescing state + visibility listener
			// before the early-return below skips reconnect.
			connectionCleanup?.();
			connectionCleanup = null;

			// Disposed or superseded socket: no state writes, no reconnect.
			if (disposedRef.current || wsRef.current !== ws) return;
			setGlobalClient(null);
			clientRef.current?.disconnect();
			clientRef.current = null;

			attemptRef.current += 1;
			const attempt = attemptRef.current;
			const unreachable = attempt >= UNREACHABLE_THRESHOLD;
			const wasConnected = wasConnectedRef.current;

			const store = getStore();
			let next: ConnectionState;
			if (unreachable) {
				next = { kind: "unreachable", attempt };
			} else if (wasConnected) {
				next = { kind: "reconnecting", attempt };
			} else {
				next = { kind: "connecting" };
			}
			store.getState().setConnectionState(next);

			if (wasConnected || unreachable) {
				const msg = unreachable ? "Can't reach pi-bridge — retrying" : "Reconnecting…";
				store.getState().pushToast(CONNECTION_TOAST_ID, msg);
			}

			const delay = backoff(attempt - 1);
			reconnectTimerRef.current = setTimeout(() => {
				connect();
			}, delay);
		};

		ws.onerror = () => {
			// onclose is the reliable signal; nothing to do here but guard.
			if (disposedRef.current || wsRef.current !== ws) return;
		};
	}, [initDaemonInfo]);

	// Manual retry from the Launcher / TopBar chip. If the WS is open
	// (init_failed), re-run init. Otherwise cancel the backoff and connect now.
	const retry = useCallback(() => {
		const client = clientRef.current;
		const ws = wsRef.current;
		if (client && ws && ws.readyState === WebSocket.OPEN) {
			void initDaemonInfo(client);
			return;
		}
		if (reconnectTimerRef.current) {
			clearTimeout(reconnectTimerRef.current);
			reconnectTimerRef.current = null;
		}
		attemptRef.current = 0;
		getStore().getState().setConnectionState({ kind: "connecting" });
		connect();
	}, [connect, initDaemonInfo]);

	useEffect(() => {
		disposedRef.current = false;
		setWantsDrainer(() => {
			void drainWantsOutbox();
		});
		connect();
		return () => {
			disposedRef.current = true;
			setWantsDrainer(null);
			if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
			wsRef.current?.close();
			clientRef.current?.disconnect();
			setGlobalClient(null);
		};
	}, [connect]);

	return { retry };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractEntryId(path: string): string | null {
	const match = path.match(/^\/entries\/([^/]+)/);
	return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Dev-mode console relay — hook console.* to send RPC to server
// ---------------------------------------------------------------------------

function hookConsole(client: BridgeClient): void {
	const levels = ["log", "warn", "error"] as const;
	for (const level of levels) {
		const original = console[level];
		console[level] = (...args: unknown[]) => {
			original(...args);
			client.console(
				level,
				args.map((a) => safeJsonValue(a)),
			);
		};
	}
}

function safeJsonValue(v: unknown): JsonValue {
	if (v === null || v === undefined) return null;
	if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
	if (v instanceof Error) return v.message;
	try {
		return JSON.parse(JSON.stringify(v)) as JsonValue;
	} catch {
		return String(v);
	}
}

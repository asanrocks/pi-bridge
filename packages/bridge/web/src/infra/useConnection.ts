// ============================================================================
// useConnection — WebSocket lifecycle + BridgeClient → store integration.
// Owns the transport and the connection state machine: connecting → connected
// | init_failed, and on drop → reconnecting → unreachable (after threshold).
// Auto-attaches to the sole live instance (T1: 1 instance) or to the tab's
// previously-attached instance (resume). Otherwise the Launcher shows.
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
	type InstanceInfo,
	type JsonValue,
	type ListSessionsReply,
	type PatchOp,
	planCacheWrites,
	type ServerPushMessage,
	type SessionInfo,
	type SessionStatusHint,
	seedDocument,
	statusHintOfDocument,
} from "../../../src/core/index.ts";
import { setGlobalClient } from "./client.ts";
import { getEntryCache, prepareSwitch } from "./entryCache.ts";
import { drainWantsOutbox } from "./pullLoop.ts";
import { discardSessionCandidate, promoteSessionCandidate } from "./sessionCandidate.ts";
import type { ConnectionState } from "./store.ts";
import { getStore } from "./store.tsx";
import { setWantsDrainer } from "./wants.ts";

const CONNECTION_TOAST_ID = "connection";
// After this many failed reconnect attempts, copy shifts to "Can't reach".
const UNREACHABLE_THRESHOLD = 5;
// If the init RPC (getDaemonInfo + listInstances) doesn't resolve in this
// window, treat it as init_failed rather than hanging in "connecting".
const INIT_TIMEOUT_MS = 8000;

// Last cache-written base per session (ADR 09): planCacheWrites only sees
// "unchanged" when before/after share entry references, which holds only for
// same-session documents evolved via applyPatch. Using the store's previous
// document as `before` made every session switch rewrite the entire new
// session — documents of different sessions share no references. Seeded at
// attach/promotion (the cache-derived seed doc), set by the replace repair
// path, advanced on every delta write; a stale or failed write self-heals via
// the repair path. Module scope: both attachInstance and the onPush handlers
// write it, and the tab has at most one live connection (stale-client guards
// already protect every writer).
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

	// Attach to an instance, seeding the mirror from cache when possible
	// (ADR 09 §Client Restore Flow). Cold load: seed mirror + paint from the
	// cached records. Reconnect to the same session: the in-memory document
	// is newer than the cache — keep it as the seed (delta adds are
	// overwrite-shaped, so a cache-lagging cursor stays safe).
	const attachInstance = useCallback(async (client: BridgeClient, instanceId: string, sessionId?: string) => {
		if (!sessionId) {
			await client.switchInstance(instanceId);
			return;
		}
		let records: CacheEntryRecord[] = [];
		let hint: SessionStatusHint | null = null;
		try {
			({ records, hint } = await (await getEntryCache()).loadSession(sessionId));
		} catch {
			// Cache read failure: plain attach, full replace.
		}
		if (clientRef.current !== client) return; // superseded mid-load
		const store = getStore();
		const state = store.getState();
		const sameSession = state.activeSessionId === sessionId && Object.keys(state.document.entries).length > 0;
		const seed = sameSession ? state.document : seedDocument(records, hint ?? undefined);
		client.mirror.applyReplace(seed);
		// The seed mirrors the cache content — it becomes the session's cache
		// base so the initial-sync delta's flush persists only new entries.
		cacheBase = { sessionId, doc: seed };
		if (!sameSession && records.length > 0) {
			// Immediate paint of the cached content before the server responds.
			store.getState().applyReplace(seed);
		}
		const cursor = computeCursor(records);
		await client.switchInstance(instanceId, cursor ?? undefined);
	}, []);

	const initDaemonInfo = useCallback(
		async (client: BridgeClient) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const timeout = new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("daemon did not respond")), INIT_TIMEOUT_MS);
				});
				const [daemonReply, managersReply] = await Promise.race([
					Promise.all([client.getDaemonInfo(), client.listInstances()]),
					timeout,
				]);

				// Stale-client guard: a superseded connection must not write into the store.
				if (clientRef.current !== client) return;

				const store = getStore();

				// Daemon info — models, thinking levels, cwd allowlist, dev mode
				const info = daemonReply as unknown as GetDaemonInfoReply;
				if (info.models) {
					store.getState().setModels(info.models, info.thinkingLevels ?? []);
				}
				if (info.cwdAllowlist) {
					store.getState().setCwdAllowlist(info.cwdAllowlist);
				}
				if (info.devMode) {
					store.getState().setDevMode(true);
					hookConsole(client);
				}

				// Instance list — pick what to attach to.
				const instancesResult = managersReply as unknown as { ok: boolean; instances: InstanceInfo[] };
				const instances = instancesResult.instances ?? [];
				const state = store.getState();
				const currentId = state.attachedInstanceId;
				const stillAlive = currentId !== null && instances.some((inst) => inst.instanceId === currentId);

				// Auto-attach: resume this tab's instance if still alive, else
				// attach the sole live instance (T1). At 0 instances, seed one per
				// allowlist cwd — each resuming its most recent prior session —
				// and attach to the last. The Launcher's empty state is pure
				// friction on the common path (you must create one to start anyway).
				// Skipped when launcher-pinned: the user deliberately returned to
				// the instance list — a reconnect must not attach over that choice.
				const allowlist = info.cwdAllowlist ?? [];
				let attachId: string | null = null;
				let seeded = false;
				if (!state.launcherPinned && stillAlive) {
					attachId = currentId;
					await attachInstance(
						client,
						currentId,
						instances.find((inst) => inst.instanceId === currentId)?.sessionId,
					);
				} else if (!state.launcherPinned && instances.length === 1) {
					attachId = instances[0].instanceId;
					await attachInstance(client, attachId, instances[0].sessionId);
				} else if (!state.launcherPinned && instances.length === 0 && allowlist.length > 0) {
					// newInstance starts a fresh session; listSessions is
					// server-scoped to the just-attached instance's cwd and
					// excludes the live fresh session, so sessions[0] is the
					// previous one — resume it. No-op on first use (empty list).
					let lastId: string | null = null;
					for (const cwd of allowlist) {
						const reply = await client.newInstance(cwd);
						if (clientRef.current !== client) return;
						const r = reply as unknown as { ok: boolean; instanceId?: string };
						if (!r?.ok || !r.instanceId) continue;
						const sessReply = await client.listSessions(1);
						if (clientRef.current !== client) return;
						const sessData = sessReply as unknown as ListSessionsReply;
						// sessionPath null = live stub row — not a switch target (ADR 09).
						if (sessData?.sessions?.[0]?.sessionPath) {
							const target = sessData.sessions[0];
							const cursor = await prepareSwitch(target.sessionId);
							if (clientRef.current !== client) return;
							await client.switchSession(target.sessionPath as string, cursor);
							if (clientRef.current !== client) return;
						}
						lastId = r.instanceId;
					}
					if (lastId) {
						attachId = lastId;
						seeded = true;
					}
				}

				if (clientRef.current !== client) return; // superseded mid-attach

				// Seeding changed the instance set — refetch so the store reflects
				// the new instances (the last is already attached via newInstance).
				let liveInstances = instances;
				if (seeded) {
					const freshReply = await client.listInstances();
					if (clientRef.current !== client) return;
					const freshData = freshReply as unknown as { ok: boolean; instances: InstanceInfo[] };
					if (freshData?.instances) liveInstances = freshData.instances;
				}

				if (attachId) {
					const sessReply = await client.listSessions(10);
					if (clientRef.current !== client) return;
					const sessData = sessReply as unknown as ListSessionsReply;
					if (sessData.sessions) {
						store.getState().replaceSessions(sessData.sessions as SessionInfo[], sessData.hasMore === true);
					}
				}

				store.getState().syncInstances({ instances: liveInstances, attachedInstanceId: attachId });

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
		[attachInstance],
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
			// onPush fires). We decouple *when* the store reads the mirror,
			// coalescing many patches into one store update per animation frame
			// (visible) or per ~1s (hidden). This caps the urgent render +
			// selector fan-out rate at the flush cadence, not the token cadence
			// — the dominant CPU sink during streaming. useDeferredValue (on
			// TextBlockView) keeps the expensive markdown subtree interruptible
			// regardless. A `replace` push flushes immediately (load-bearing:
			// reconnect/session switch resets state wholesale).
			// Last cache-written base per session — see the module-level declaration.
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

			// Drain pending patch ops: one migrateExpandKeys pass over the
			// batched move ops, then push the mirror's current document to the
			// store. The mirror already holds every applied patch, so this is a
			// single applyReplace regardless of how many patches coalesced.
			// `cacheMode "skip"` is for flushes whose before/after span sessions
			// (the replace path persists via replaceSession repair instead).
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
				// active session, planned against the session's cache base (see
				// cacheBase above). Cache failures never break the UI.
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

			// Arm the flush without arguments (rAF passes a timestamp).
			const scheduleFlush = () => {
				if (document.hidden) {
					// Hidden: rAF won't fire. Drain on a ~1s timer so the store
					// stays bounded-stale (lets useStatusNotifications catch a
					// turn that completes in the background) at ~0 render cost.
					if (hideTimer === null) hideTimer = setTimeout(flush, 1000);
				} else if (rafId === null) {
					// Visible: align the store write with paint. Multiple patches
					// in one frame coalesce into one store update.
					rafId = requestAnimationFrame(() => flush());
				}
			};

			const onVisibilityChange = () => {
				if (document.hidden) {
					// rAF is deferred (won't fire while hidden); cancel it and arm
					// the slow timer so pending work drains in the background
					// rather than waiting for refocus.
					if (rafId !== null) {
						cancelAnimationFrame(rafId);
						rafId = null;
					}
					if (pendingOps !== null && hideTimer === null) {
						hideTimer = setTimeout(flush, 1000);
					}
				} else {
					// Back to visible: cancel the slow timer and flush now so the
					// returning user sees the latest without a frame's delay. The
					// next patch arms a fresh rAF.
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

				// Sessions-changed push: upsert metadata, preserve loaded pages.
				if (push.kind === "sessions_changed") {
					store.getState().appendSessions(push.sessions, push.hasMore);
					return;
				}

				// Instance exit: clear instance state, show initial state.
				if (push.kind === "instance_exit") {
					discardSessionCandidate(); // a pending switch can never complete now
					store.getState().clearInstance();
					// Refresh instance list so the killed instance disappears from the sidebar.
					client.listInstances().then((reply) => {
						if (reply.ok) {
							const mData = reply as unknown as { instances: InstanceInfo[] };
							if (mData.instances) {
								store.getState().syncInstances({ instances: mData.instances });
							}
						}
					});
					return;
				}

				// replace: flush barrier + cache repair (ADR 09). The mirror already
				// holds the snapshot. A sessionId-bearing replace is an initial sync;
				// it sets the cache key and repairs that session's cached records.
				// Replace nulls lazy fields; bumpPullTick re-triggers want
				// registration so the pull loop re-fetches what's on screen.
				if (push.kind === "replace") {
					flush("skip");
					if (push.sessionId) {
						store.getState().setActiveSessionId(push.sessionId);
						const doc = client.mirror.document;
						const sessionId = push.sessionId;
						const repairRecords = cacheRecordsOfDocument(sessionId, doc);
						// The repair rewrites the whole session by design — the snapshot
						// becomes the new cache base.
						cacheBase = { sessionId, doc };
						void getEntryCache()
							.then((cache) => cache.replaceSession(sessionId, repairRecords, statusHintOfDocument(doc)))
							.catch(() => {});
					}
					store.getState().bumpPullTick();
					return;
				}

				// Initial-sync delta (ADR 09): a patch frame carrying sessionId.
				// If a candidate mirror is pending for that session, apply the
				// delta to the candidate and promote it atomically — the mirror's
				// own application ran against the old-session base and is
				// discarded. Without a candidate (reconnect/attach seeded the
				// mirror directly), the mirror application is already correct:
				// flush barrier only.
				if (push.kind === "patch" && push.sessionId) {
					const promoted = promoteSessionCandidate(push.sessionId, push.ops);
					if (promoted) {
						client.mirror.applyReplace(promoted.doc);
						// The candidate was seeded from the cached records — its
						// pre-promotion document IS the cache base, so the flush below
						// persists only the delta's new entries, not the whole session.
						cacheBase = { sessionId: push.sessionId, doc: promoted.before };
					}
					store.getState().setActiveSessionId(push.sessionId);
					flush(); // barrier + delta write-through under the new session id
					store.getState().bumpPullTick();
					return;
				}

				// patch: buffer ops for the move scan, schedule a coalesced flush.
				if (push.kind === "patch") {
					if (pendingOps === null) pendingOps = [];
					for (const op of push.ops) pendingOps.push(op);
					scheduleFlush();
				}
			};

			document.addEventListener("visibilitychange", onVisibilityChange);

			// Don't mark connected until the init RPC resolves — the WS being
			// open is necessary, not sufficient. State stays connecting/
			// reconnecting until init succeeds (→ connected) or fails (→ init_failed).
			void initDaemonInfo(client);
		};

		ws.onclose = () => {
			// Tear down this connection's coalescing state + visibility listener
			// before the early-return below skips reconnect. Prevents leaked
			// listeners and stray flushes on a dead/superseded socket.
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

			// Toast only once we've been connected (or after the threshold on a
			// first-load failure) — avoid spamming a normal first-attempt.
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

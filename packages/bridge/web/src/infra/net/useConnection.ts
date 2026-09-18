// ============================================================================
// useConnection — WebSocket lifecycle + the connection state machine:
// connecting → connected | init_failed, and on drop → reconnecting →
// unreachable (after threshold). The URL (ADR 11) is the navigation source
// of truth: boot and every reconnect re-resolves `/`, `/<projectId>`, or
// `/<projectId>/<stem>`.
//
// The per-connection work lives in sibling modules:
//   - connectionTransport — WebSocket adapter + reconnect backoff
//   - connectionPipeline  — push ingestion, patch coalescing, ADR 09 cache
//                           write-through/repair, candidate promotion
//   - sessionBoot         — route-driven session open with cache seeding
//   - devConsole          — dev-mode console relay
// ============================================================================

import { useCallback, useEffect, useRef } from "react";
import { BridgeClient, type GetDaemonInfoReply, type ListActiveSessionsReply } from "../../../../src/core/index.ts";
import { parseRoute, writeRoute } from "../lib/routes.ts";
import { rememberAddress } from "../persist/addressIndex.ts";
import type { ConnectionState } from "../state/store.ts";
import { getStore } from "../state/store.tsx";
import { setGlobalClient } from "./client.ts";
import { createConnectionPipeline } from "./connectionPipeline.ts";
import { backoff, WsTransport } from "./connectionTransport.ts";
import { hookConsole } from "./devConsole.ts";
import { flushPullQueue } from "./pullLoop.ts";
import { setDrainer } from "./pullQueue.ts";
import { openSessionAddress } from "./sessionBoot.ts";

const CONNECTION_TOAST_ID = "connection";
// After this many failed reconnect attempts, copy shifts to "Can't reach".
const UNREACHABLE_THRESHOLD = 5;
// If the init RPC (getDaemonInfo + listActiveSessions) doesn't resolve in this
// window, treat it as init_failed rather than hanging in "connecting".
const INIT_TIMEOUT_MS = 8000;

export function useConnection(): { retry: () => void } {
	const clientRef = useRef<BridgeClient | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const disposedRef = useRef(false);
	const wasConnectedRef = useRef(false);
	// Reconnect attempt counter; 0 while connected. Drives the
	// connecting→unreachable threshold and backoff exponent.
	const attemptRef = useRef(0);

	const initDaemonInfo = useCallback(async (client: BridgeClient) => {
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
					await openSessionAddress(client, route.projectId, route.stem, () => clientRef.current !== client);
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
	}, []);

	const connect = useCallback(() => {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const wsUrl = `${protocol}//${window.location.host}`;
		const ws = new WebSocket(wsUrl);
		wsRef.current = ws;

		// Per-connection teardown. Populated by onopen (the pipeline's cleanup
		// lives there, where `client` is in scope); invoked by onclose so a
		// dead/superseded socket never leaks its listener or strands a pending
		// flush.
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

			// Push ingestion + coalescing + cache write-through, frozen at cleanup.
			const pipeline = createConnectionPipeline(client);
			client.onPush = pipeline.onPush;
			connectionCleanup = pipeline.cleanup;

			// Don't mark connected until the init RPC resolves — the WS being
			// open is necessary, not sufficient.
			void initDaemonInfo(client);
		};

		ws.onclose = () => {
			// Tear down this connection's pipeline before the early-return
			// below skips reconnect.
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
		setDrainer(() => {
			void flushPullQueue();
		});
		connect();
		return () => {
			disposedRef.current = true;
			setDrainer(null);
			if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
			wsRef.current?.close();
			clientRef.current?.disconnect();
			setGlobalClient(null);
		};
	}, [connect]);

	return { retry };
}

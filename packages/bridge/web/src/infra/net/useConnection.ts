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
//                           write-through/repair
//   - navigation          — the wire half of boot: route-driven opens, alias
//                           resolution, initial-sync commit, fallbacks
//   - sessionBoot         — cache-first local restore, before the wire
//   - devConsole          — dev-mode console relay
// ============================================================================

import { useCallback, useEffect, useRef } from "react";
import { BridgeClient, type GetDaemonInfoReply } from "../../../../src/core/index.ts";
import { parseRoute } from "../lib/routes.ts";
import type { ConnectionState } from "../state/store.ts";
import { getStore } from "../state/store.tsx";
import { createBrowserFlushScheduler } from "./browserScheduler.ts";
import { setGlobalClient } from "./client.ts";
import { createConnectionPipeline } from "./connectionPipeline.ts";
import { backoff, WsTransport } from "./connectionTransport.ts";
import { hookConsole, unhookConsole } from "./devConsole.ts";
import {
	navigationBoot,
	navigationBootLatest,
	navigationLauncher,
	navigationLocalSeed,
	navigationProject,
} from "./navigation.ts";
import { cancelPullRetry, flushPullQueue } from "./pullLoop.ts";
import { setDrainer } from "./pullQueue.ts";
import { restoreLocalSession } from "./sessionBoot.ts";

// After this many failed reconnect attempts, state shifts to "unreachable".
const UNREACHABLE_THRESHOLD = 5;
// If the init RPC (getDaemonInfo + listQueue) doesn't resolve in this
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
			const [daemonReply] = await Promise.race([Promise.all([client.getDaemonInfo()]), timeout]);

			// Stale-client guard: a superseded connection must not write into the store.
			if (clientRef.current !== client) return;

			const store = getStore();

			// Daemon info — Projects, models, thinking levels, dev mode
			const info = daemonReply as unknown as GetDaemonInfoReply;
			if (info.models) {
				store
					.getState()
					.setModels(info.models, info.thinkingLevels ?? [], info.pinnedModels ?? [], info.visibleModels ?? []);
			}
			store.getState().setProjects(info.projects ?? []);
			if (info.devMode) {
				store.getState().setDevMode(true);
				hookConsole(client);
			}

			// The queue is not fetched here: the Connection's first push is its
			// snapshot (ADR 24), so a reconnect cannot pair a query reply with a
			// delta the browser already applied.

			// Sidebar folder pages are connection-scoped: a reconnect may be
			// talking to a restarted daemon, so drop them. Expanded folders see
			// the reset (new record object) and refetch through their effects.
			store.getState().resetSessionPages();

			// Route-driven open (ADR 11). The URL is read at boot and after
			// every reconnect; it is not a second live navigation machine. Each
			// transition is the navigation reactor's: staging, the open RPC,
			// the initial-sync commit, and the fallback all run there, so a
			// reconnect superseding this connection's work is one epoch
			// comparison inside the reactor instead of a per-await guard here.
			const route = parseRoute(window.location.pathname);
			if (route.kind === "session") {
				const known = (info.projects ?? []).some((p) => p.id === route.projectId);
				if (known) await navigationBoot({ projectId: route.projectId, stem: route.stem });
				else await navigationLauncher("boot");
			} else if (route.kind === "alias") {
				// ADR 13: resolve the alias once per boot/reconnect — the URL
				// keeps the alias form while the store holds the resolved
				// address. The alias's position is its scope: the root form spans
				// Projects, a Project's `@latest` resolves inside it and lands on
				// that Project's home when it has no Session.
				const scoped = route.projectId === null || (info.projects ?? []).some((p) => p.id === route.projectId);
				if (route.alias === "latest" && scoped) await navigationBootLatest(route.projectId);
				else await navigationLauncher("boot");
			} else if (route.kind === "project") {
				const known = (info.projects ?? []).some((p) => p.id === route.projectId);
				if (known) await navigationProject(route.projectId, "boot");
				else await navigationLauncher("boot");
			} else {
				await navigationLauncher("boot");
			}

			if (clientRef.current !== client) return;

			// Success: mark connected and reset the doom counter. The down-state
			// affordances (TopBar chip / Launcher panel) react to the state alone.
			wasConnectedRef.current = true;
			attemptRef.current = 0;
			store.getState().setConnectionState({ kind: "connected" });
		} catch (err) {
			if (clientRef.current !== client) return;
			const msg = err instanceof Error ? err.message : String(err);
			getStore().getState().setConnectionState({ kind: "init_failed", error: msg });
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
			const client = new BridgeClient(transport, {
				onProtocolError: (message) => {
					// Never silently tolerated: a frame the client cannot decode means
					// the mirror may have missed a live patch, so the socket closes and
					// the reconnect's initial sync repairs the stream. The toast names
					// the reload as the fix — the app and the daemon ship together, so
					// a repeated violation is version skew.
					getStore()
						.getState()
						.pushToast(
							"protocol-error",
							`Incompatible message from the daemon (${message}). Reconnecting — if it repeats, reload the page.`,
						);
					ws.close();
				},
			});
			clientRef.current = client;
			setGlobalClient(client);

			// Push ingestion + coalescing + cache write-through, frozen at cleanup.
			// A revision gap in the queue is unrecoverable on this socket, so the
			// owner replaces the connection and the new snapshot repairs it.
			const pipeline = createConnectionPipeline(client, createBrowserFlushScheduler(), {
				onResyncNeeded: (reason) => {
					getStore()
						.getState()
						.pushToast("queue-resync", `Out of sync with the daemon (${reason}). Reconnecting.`);
					ws.close();
				},
			});
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
			// The console relay targets this connection's client; a reconnect
			// re-hooks it (once — the hook never nests) when init reports dev
			// mode again. Until then, nothing is relayed through a dead socket.
			unhookConsole();

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
		// Cache-first boot: restore the route's session from the local cache
		// in parallel with the first connect, so the conversation paints before
		// the wire answers. The restore's race guard keeps the wire
		// authoritative; with no local truth the address stays unclaimed and
		// the Launcher's down states show while connecting.
		const route = parseRoute(window.location.pathname);
		if (route.kind === "session") {
			// Value-only restore (ADR 19): the read produces the seed, and the
			// view actor decides whether it becomes visible.
			void restoreLocalSession(route.projectId, route.stem).then((seed) => {
				if (seed !== null) void navigationLocalSeed(seed);
			});
		}
		connect();
		return () => {
			disposedRef.current = true;
			setDrainer(null);
			if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
			cancelPullRetry();
			wsRef.current?.close();
			clientRef.current?.disconnect();
			setGlobalClient(null);
			unhookConsole();
		};
	}, [connect]);

	return { retry };
}

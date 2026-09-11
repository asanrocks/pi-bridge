// Shared WS-pair + frame helpers for Connection-level tests
// (connection-daemon.test.ts, initial-sync-integration.test.ts).

import WebSocket, { WebSocketServer } from "ws";
import type { PrefixCursor, SessionInfo } from "../../src/core/index.ts";
import type { Connection, DaemonVerbs } from "../../src/host/connection.ts";

/** Create an in-process WebSocket pair (server + client). */
export function createWsPair(): Promise<{ serverWs: WebSocket; clientWs: WebSocket }> {
	return new Promise((resolve) => {
		const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => {
			const addr = wss.address();
			if (!addr || typeof addr === "string") throw new Error("no address");
			const port = addr.port;

			const clientWs = new WebSocket(`ws://127.0.0.1:${port}`);

			wss.once("connection", (serverWs) => {
				// Close the server once we have the pair
				wss.close();
				resolve({ serverWs, clientWs });
			});
		});
	});
}

/** Collect frames received on a WebSocket. */
export function collectFrames(ws: WebSocket): unknown[] {
	const frames: unknown[] = [];
	ws.on("message", (data) => {
		try {
			frames.push(JSON.parse(data.toString()));
		} catch {
			// ignore
		}
	});
	return frames;
}

export function waitForFrame(frames: unknown[], pred: (f: unknown) => boolean, timeout = 5000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const existing = frames.find(pred);
		if (existing) return resolve(existing);

		const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), timeout);
		const interval = setInterval(() => {
			const match = frames.find(pred);
			if (match) {
				clearTimeout(timer);
				clearInterval(interval);
				resolve(match);
			}
		}, 50);
	});
}

/** Poll a condition (manager-side state, not frames). */
export function waitFor(cond: () => boolean, timeout = 5000, what = "condition"): Promise<void> {
	return new Promise((resolve, reject) => {
		if (cond()) return resolve();
		const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeout);
		const interval = setInterval(() => {
			if (cond()) {
				clearTimeout(timer);
				clearInterval(interval);
				resolve();
			}
		}, 20);
	});
}

const stubSession: SessionInfo = {
	sessionId: "s1",
	sessionPath: "/tmp/s1.jsonl",
	name: "Session 1",
	timestamp: "2024-01-01T00:00:00Z",
	messageCount: 5,
};

export const mockDaemonVerbs: DaemonVerbs = {
	listSessions: async () => ({ sessions: [stubSession], hasMore: false }),
	getDaemonInfo: () => ({
		models: [{ provider: "faux", id: "faux-1", name: "Faux 1", reasoning: true }],
		thinkingLevels: ["off", "low", "medium", "high"],
		cwdAllowlist: [],
		devMode: false,
	}),
	listFiles: () => [],
	listInstances: () => [],
	switchInstance: async (
		_instanceId: string,
		_conn: Connection,
		_cursor?: PrefixCursor | null,
	): Promise<{ ok: boolean }> => ({ ok: true }),
	newInstance: async () => ({ ok: true, instanceId: "test-mgr" }),
	killInstance: async () => ({ ok: true }),
};

// Shared WS-pair + frame helpers for Connection-level tests
// (connection-daemon.test.ts, initial-sync-integration.test.ts).

import WebSocket, { WebSocketServer } from "ws";
import { filterPatchForSocket, type PrefixCursor, type SessionInfo, type SessionRef } from "../../src/core/index.ts";
import type { Connection } from "../../src/host/connection.ts";
import type { DaemonVerbs } from "../../src/host/connection-verbs.ts";
import type { Manager } from "../../src/host/manager.ts";
import { createSessionActor } from "../../src/host/session-actor.ts";
import { bindSessionCommands } from "../../src/host/session-commands.ts";
import type { WorkerObservation } from "../../src/host/worker-contract.ts";

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

/** Resolve once the socket is open. Needed by tests that send without first
 * awaiting a server-initiated frame (which otherwise gives the socket time). */
export function waitForOpen(ws: WebSocket): Promise<void> {
	if (ws.readyState === ws.OPEN) return Promise.resolve();
	return new Promise((resolve) => ws.once("open", () => resolve()));
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

/** Attach a hand-built Manager to a Connection through the real attachment
 * seam: one observation over a Session actor, exactly as the Worker installs
 * one. Tests exercise the Connection protocol, not the Worker. */
export async function attachTestManager(
	conn: Connection,
	manager: Manager,
	ref: SessionRef,
	cursor: PrefixCursor | null = null,
): Promise<{ close: () => void }> {
	const actor = createSessionActor({
		manager,
		ref,
		authorization: { incarnation: "test", generation: 1 },
	});
	const capability = actor.capability();
	const admission = actor.admission();
	const target = {
		projectId: ref.projectId,
		stem: ref.stem,
		sessionId: ref.sessionId,
		cwd: manager.cwd,
		worker: { id: "test-worker", incarnation: "test", generation: 1 },
		activation: 1,
	} as const;
	let endStream: (() => void) | null = null;
	// One observation's lazy demand, filtered here exactly as the Worker does
	// it: the Connection holds no subscription set of its own.
	const demand = new Set<string>();
	await conn.attach(async (sink) => {
		endStream = () => sink({ kind: "closed", address: { projectId: ref.projectId, stem: ref.stem } });
		const observation = capability.observe(
			{
				onPatch: (patch) => {
					const ops = filterPatchForSocket([...patch.ops], demand);
					if (ops.length > 0) sink({ kind: "patch", ops });
				},
				onInitialSync: (frame) => {
					demand.clear();
					if (frame.kind === "replace")
						sink({ kind: "replace", session: frame.session, document: frame.document });
					else sink({ kind: "patch", session: frame.session, ops: frame.ops });
				},
			},
			cursor,
		);
		const stream: WorkerObservation = {
			id: "test-observation",
			target,
			pull: async (requests) => {
				const values = await capability.pull([...requests]);
				// A live value becomes this observation's demand, exactly as the
				// Worker's observation does it.
				for (const value of values) if (value.live) demand.add(value.fieldPath);
				return values;
			},
			release: async () => {
				await observation.release();
				await capability.release();
			},
		};
		return {
			target,
			observation: stream,
			commands: bindSessionCommands(target, {
				prompt: (text, images) => admission.prompt(text, images),
				abort: () => admission.abort(),
				discardSteer: () => admission.discardSteer(),
				compact: (customInstructions) => admission.compact(customInstructions),
				renameSession: (name) => admission.renameSession(name),
				setLabel: (entryId, label) => admission.setLabel(entryId, label),
				navigate: (entryId) => admission.navigate(entryId),
				recoverTurn: () => admission.recoverTurn(),
				pull: (requests) => stream.pull(requests),
			}),
		};
	});
	return { close: () => endStream?.() };
}

export const mockSessionRef: SessionRef = { projectId: "proj", sessionId: "s1", stem: "2024-01-01_s1" };

const stubSession: SessionInfo = {
	projectId: "proj",
	sessionId: "s1",
	stem: "2024-01-01_s1",
	location: "archive",
	name: "Session 1",
	timestamp: "2024-01-01T00:00:00Z",
	messageCount: 5,
};

export const mockDaemonVerbs: DaemonVerbs = {
	listSessions: async () => ({ sessions: [stubSession], hasMore: false }),
	listQueue: async () => [],
	setSessionLocation: async () => ({ ok: true }),
	getDaemonInfo: async () => ({
		projects: [{ id: "proj", cwd: "/proj", defaultModel: null, defaultThinkingLevel: null }],
		models: [{ provider: "faux", id: "faux-1", name: "Faux 1", reasoning: true }],
		pinnedModels: [],
		visibleModels: [],
		thinkingLevels: ["off", "low", "medium", "high"],
		devMode: false,
	}),
	setPinnedModels: async () => {},
	asrCredentials: async () => ({ kind: "device", deviceId: "mock-device" }),
	textPolish: async (text: string) => `polished: ${text}`,
	openSession: async () => ({ ok: true, session: mockSessionRef }),
	newSession: async () => ({ ok: true, session: mockSessionRef }),
	detach: () => {},
	trashSession: async () => ({ ok: true }),
	sessionsChanged: () => {},
	listFiles: async () => [],
	readFile: () => {
		throw new Error("readFile not wired in mock");
	},
	listDirectory: () => {
		throw new Error("listDirectory not wired in mock");
	},
	gitShow: () => {
		throw new Error("gitShow not wired in mock");
	},
	gitBase: () => {
		throw new Error("gitBase not wired in mock");
	},
	gitDiff: () => {
		throw new Error("gitDiff not wired in mock");
	},
};

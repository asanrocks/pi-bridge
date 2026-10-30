// ============================================================================
// trace-harness — the shared fixture for the cross-layer suites
// (lifecycle-trace.test.ts, load-bounds.test.ts): the real Daemon over
// faux-provider Managers, a real BridgeClient on a real WebSocket, the real
// connection pipeline (injected flush scheduler), and the real navigation
// actor.
// ============================================================================

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { FauxResponseStep } from "@earendil-works/pi-ai/compat";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, vi } from "vitest";
import WebSocket from "ws";
import type { Document, Entry, SessionRef } from "../../src/core/index.ts";
import { BridgeClient, type BridgeTransport, initFromEntries, isEntrySealed } from "../../src/core/index.ts";
import type { Manager } from "../../src/host/index.ts";
import { createManager, Daemon } from "../../src/host/index.ts";
import { createConnectionPipeline, type FlushScheduler } from "../../web/src/infra/net/connectionPipeline.ts";
import { navigationOpen, resetNavigationForTests } from "../../web/src/infra/net/navigation.ts";
import { getStore } from "../../web/src/infra/state/store.ts";

const FIXTURE = new URL("../fixtures/before-compaction.jsonl", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Host side: the real Daemon over faux-provider Managers
// ---------------------------------------------------------------------------

/** Encode the cwd the way pi's getDefaultSessionDir does (agentDir/sessions/--cwd--). */
export function sessionDirFor(cwd: string, agentDir: string): string {
	const safePath = `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return join(resolve(agentDir), "sessions", safePath);
}

/** Install the fixture under a fresh durable session id: the daemon rejects
 * two addresses claiming one id at startup. */
export function installFixture(dest: string, sessionId: string): void {
	const lines = readFileSync(FIXTURE, "utf8").split("\n");
	const header = JSON.parse(lines[0] as string) as Record<string, unknown>;
	header.id = sessionId;
	lines[0] = JSON.stringify(header);
	writeFileSync(dest, lines.join("\n"));
}

export interface TraceDaemon {
	daemon: Daemon;
	port: number;
	projectId: string;
	/** The stem each fixture was installed under. */
	stems: string[];
	/** The Manager the factory built per stem (the canonical Documents). */
	managerOf(stem: string): Manager | undefined;
	/** Disposals per stem. */
	disposeCount(stem: string): number;
	/** Every patch the host emitted, with its ops (wire-cost diagnostics). */
	hostPatches(): Array<{ stem: string; ops: Array<{ op: string; path: string }> }>;
	/** Script the faux provider's response queue. */
	setResponses(steps: FauxResponseStep[]): void;
	cleanup(): Promise<void>;
}

export async function startTraceDaemon(
	stems: string[],
	opts?: { tokensPerSecond?: number; customTools?: NonNullable<Parameters<typeof createManager>[0]>["customTools"] },
): Promise<TraceDaemon> {
	const root = join(tmpdir(), `pi-bridge-trace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(root, "agent");
	const projectCwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectCwd, { recursive: true });
	const sessionDir = sessionDirFor(projectCwd, agentDir);
	mkdirSync(sessionDir, { recursive: true });
	let fixtureCounter = 0;
	for (const stem of stems)
		installFixture(join(sessionDir, `${stem}.jsonl`), `trace-${++fixtureCounter}-${Date.now()}`);

	const faux = registerFauxProvider({
		models: [{ id: "faux-1", reasoning: true }],
		tokensPerSecond: opts?.tokensPerSecond,
	});
	const authStorage = AuthStorage.inMemory();
	const model = faux.getModel();
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage });
	await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			baseUrl: m.baseUrl,
		})),
	});

	const managers = new Map<string, Manager>();
	const hostPatchLog: Array<{ stem: string; ops: Array<{ op: string; path: string }> }> = [];
	const disposals = new Map<string, number>();
	const managerFactory = async (factoryOpts: Parameters<typeof createManager>[0]) => {
		const manager = await createManager({
			...factoryOpts,
			modelRuntime,
			model,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } } as Record<string, unknown>),
			customTools: opts?.customTools,
			gitStamps: false,
		});
		const sessionPath = factoryOpts?.sessionPath;
		const stem = sessionPath !== undefined ? basename(sessionPath, ".jsonl") : null;
		if (stem !== null) {
			managers.set(stem, manager);
			manager.onPatch((patch) => {
				hostPatchLog.push({
					stem,
					ops: patch.ops.map((op) => ({ op: op.op, path: op.op === "move" ? op.from : op.path })),
				});
			});
			disposals.set(stem, 0);
			const inner = manager.dispose.bind(manager);
			manager.dispose = async () => {
				disposals.set(stem, (disposals.get(stem) ?? 0) + 1);
				await inner();
			};
		}
		return manager;
	};

	const daemon = new Daemon();
	await daemon.start({
		agentDir,
		allow: [projectCwd],
		managerFactory,
		modelRuntime,
		port: 0,
		idleGcMs: 60_000,
		unflushedIdleGcMs: 60_000,
	});

	const address = daemon.address;
	if (address === null) throw new Error("daemon did not start");

	return {
		daemon,
		port: address.port,
		projectId: basename(projectCwd),
		stems,
		managerOf: (stem) => managers.get(stem),
		disposeCount: (stem) => disposals.get(stem) ?? 0,
		setResponses: (steps) => faux.setResponses(steps),
		hostPatches: () => hostPatchLog,
		async cleanup() {
			await daemon.dispose();
			faux.unregister();
			if (root.length > 0) rmSync(root, { recursive: true, force: true });
		},
	};
}

// ---------------------------------------------------------------------------
// Client side: the real BridgeClient, pipeline, and navigation actor
// ---------------------------------------------------------------------------

interface ManualScheduler {
	scheduler: FlushScheduler;
	flushFrame(): void;
}

export function manualScheduler(): ManualScheduler {
	let frame: (() => void) | null = null;
	const scheduler: FlushScheduler = {
		hidden: () => false,
		onVisibilityChange: () => () => {},
		scheduleFrame(flush: () => void) {
			frame = flush;
			return () => {
				frame = null;
			};
		},
	};
	return {
		scheduler,
		flushFrame: () => {
			const f = frame;
			frame = null;
			f?.();
		},
	};
}

export interface TraceClient {
	client: BridgeClient;
	scheduler: ManualScheduler;
	/** Parsed frames received on the socket, in order. */
	frames: Array<Record<string, unknown>>;
	/** Bytes of each received frame, in order (wire-cost measurements). */
	frameSizes: number[];
	close(): void;
}

export async function connectClient(
	port: number,
	opts?: { lookupSessionId?: (projectId: string, stem: string) => string | undefined },
): Promise<TraceClient> {
	const frames: Array<Record<string, unknown>> = [];
	const frameSizes: number[] = [];
	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	const transport: BridgeTransport = {
		send: (data) => ws.send(data),
		onMessage: null,
	};
	const client = new BridgeClient(transport);
	ws.on("message", (data) => {
		frameSizes.push((data as { length: number }).length);
		try {
			frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
		} catch {
			// non-JSON frames are not interesting here
		}
		transport.onMessage?.(data.toString());
	});
	// The socket must be open before the first RPC leaves (ws.send during
	// CONNECTING throws).
	await new Promise<void>((resolveOpen) => ws.once("open", () => resolveOpen()));
	const scheduler = manualScheduler();
	const pipeline = createConnectionPipeline(client, scheduler.scheduler);
	client.onPush = pipeline.onPush;
	resetNavigationForTests({
		getClient: () => client,
		...(opts?.lookupSessionId ? { lookupSessionId: opts.lookupSessionId } : {}),
	});
	return {
		client,
		scheduler,
		frames,
		frameSizes,
		close: () => {
			pipeline.cleanup();
			ws.close();
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function resetStoreState(): void {
	const g = globalThis as unknown as { window?: unknown };
	g.window = { location: { pathname: "/" }, history: { replaceState: vi.fn() } };
	getStore().setState({
		currentProjectId: null,
		currentStem: null,
		activeSessionId: null,
		document: initFromEntries([]),
		renderLeafId: null,
		addressViaAlias: false,
	});
}

export function waitFor(cond: () => boolean, what: string, timeout = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		if (cond()) return resolve();
		const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeout);
		const interval = setInterval(() => {
			if (cond()) {
				clearTimeout(timer);
				clearInterval(interval);
				resolve();
			}
		}, 10);
	});
}

/** The convergence oracle: the mirror projects the canonical Document —
 * same entries, same seal state and file position, and equal eager text
 * (lazy fields are withheld until pulled, so they are compared only when
 * the mirror holds a value). */
export function assertMirrorProjectsCanonical(canonical: Document, mirror: Document, label: string): void {
	const canonicalIds = Object.keys(canonical.entries).sort();
	expect(Object.keys(mirror.entries).sort(), `${label}: entry ids`).toEqual(canonicalIds);
	for (const id of canonicalIds) {
		const entry = canonical.entries[id] as Entry;
		const projected = mirror.entries[id] as Entry;
		expect(projected.kind, `${label}: ${id} kind`).toBe(entry.kind);
		expect(isEntrySealed(projected), `${label}: ${id} seal state`).toBe(isEntrySealed(entry));
		if (isEntrySealed(entry) && isEntrySealed(projected)) {
			expect(projected.ord, `${label}: ${id} ord`).toBe(entry.ord);
		}
		if (entry.kind === "message" && projected.kind === "message") {
			const texts = entry.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
			const projectedTexts = projected.content
				.filter((b) => b.type === "text")
				.map((b) => (b as { text: string }).text);
			expect(projectedTexts, `${label}: ${id} text`).toEqual(texts);
		}
	}
	expect(mirror.status.isStreaming, `${label}: streaming`).toBe(canonical.status.isStreaming);
	expect(mirror.status.leafId, `${label}: leaf`).toBe(canonical.status.leafId);
}

export async function openAndCommit(projectId: string, stem: string): Promise<SessionRef> {
	const opened = navigationOpen({ projectId, stem });
	await waitFor(() => getStore().getState().currentStem === stem, `commit of ${stem}`);
	const result = await opened;
	expect(result.ok, result.error ?? "open failed").toBe(true);
	const s = getStore().getState();
	expect(s.currentProjectId).toBe(projectId);
	expect(s.activeSessionId).not.toBeNull();
	return { projectId, sessionId: s.activeSessionId as string, stem };
}

import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { basename, dirname, extname, isAbsolute, join, sep } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	findInitialModel,
	getAgentDir,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type WebSocket, WebSocketServer } from "ws";
import type {
	Content,
	Document,
	ModelInfo,
	ModelRef,
	PrefixCursor,
	ProjectInfo,
	SessionInfo,
	SessionListCursor,
	SessionRef,
} from "../core/index.ts";
import { Connection, type DaemonVerbs } from "./connection.ts";
import embeddedAssets from "./embedded-assets.ts";
import { TrafficLogger } from "./logger.ts";
import { createManager, type Manager } from "./manager.ts";
import {
	buildProjects,
	containedSessionFile,
	isContained,
	normalizeStem,
	type ProjectConfig,
	resolveStemPath,
	stemFromSessionPath,
} from "./projects.ts";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".png": "image/png",
	".svg": "image/svg+xml",
	".json": "application/json",
	".map": "application/json",
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_PORT_RANGE = { start: 33334, end: 33340 }; // [33334, 33340)
/** First page size for `sessions_changed` refreshes. */
const SESSION_PAGE_SIZE = 10;
/**
 * Activation GC policy (ADR 11). A durable or empty session is collected after
 * the idle delay; an entry-bearing unflushed session only after the longer cap,
 * because collecting it drops its non-durable entries. Not user-configurable;
 * injectable for tests.
 */
const DEFAULT_IDLE_GC_MS = 5 * 60_000;
const DEFAULT_UNFLUSHED_IDLE_GC_MS = 30 * 60_000;

export interface DaemonOptions {
	agentDir?: string;
	port?: number;
	webRoot?: string;
	logPath?: string;
	dev?: boolean;
	/** `--allow` entries: `<path>` or `<id>=<path>` (ADR 11). Defaults to
	 * `[process.cwd()]`. Duplicate ids and shared session storage are rejected. */
	allow?: string[];
	/** Injectable Manager factory (default: createManager). Test seam. */
	managerFactory?: (opts: Parameters<typeof createManager>[0]) => Promise<Manager>;
	/** Injectable embedded web assets (default: the bundle-time module).
	 * Test seam for the embedded (single-file) serving path. */
	embeddedAssets?: Record<string, string>;
	/** Shared model runtime (for tests). */
	modelRuntime?: ModelRuntime;
	/** Idle GC delays in ms (ADR 11). Test seam. */
	idleGcMs?: number;
	unflushedIdleGcMs?: number;
}

interface FileMeta {
	sessionId: string;
	name?: string;
	firstMessageText?: string;
	messageCount?: number;
}

interface Activation {
	id: string;
	ref: SessionRef;
	manager: Manager;
	/** Attached Connections. GC is gated on this being empty. */
	connections: Set<Connection>;
	gcTimer: ReturnType<typeof setTimeout> | null;
	collecting: Promise<void> | null;
	lastStreaming: boolean;
}

interface ScanEntry {
	stem: string;
	abs: string;
	sortTimeMs: number;
	active?: Activation;
}

export class Daemon {
	private projects = new Map<string, ProjectConfig>();
	/** Per-project settings (pi resolves defaults from the Project cwd's
	 * settings.json — the default model can differ per Project). */
	private projectSettings = new Map<string, SettingsManager>();
	private connections = new Set<Connection>();
	private activations = new Map<string, Activation>();
	private activationByAddress = new Map<string, string>();
	private pendingActivations = new Map<string, Promise<Activation>>();
	private sessionOwnerById = new Map<string, { projectId: string; stem: string }>();
	private connectionActivation = new Map<Connection, Activation>();
	private wss: WebSocketServer | null = null;
	private httpServer: HttpServer | null = null;
	private port: number | undefined;
	private webRoot: string | undefined;
	private embeddedAssets: Record<string, string> | null = null;
	private logger: TrafficLogger | null = null;
	private devMode = false;
	private agentDir: string = "";
	private managerFactory: NonNullable<DaemonOptions["managerFactory"]> = createManager;
	private modelRuntime!: ModelRuntime;
	private idleGcMs = DEFAULT_IDLE_GC_MS;
	private unflushedIdleGcMs = DEFAULT_UNFLUSHED_IDLE_GC_MS;

	/** Per-file mtime cache: only re-read session files whose mtime changed. */
	private sessionMetaCache = new Map<string, { mtimeMs: number; meta: FileMeta }>();

	async start(options: DaemonOptions = {}): Promise<void> {
		this.port = options.port;
		this.webRoot = options.webRoot;
		this.agentDir = options.agentDir ?? getAgentDir();
		this.devMode = options.dev ?? false;
		this.idleGcMs = options.idleGcMs ?? DEFAULT_IDLE_GC_MS;
		this.unflushedIdleGcMs = options.unflushedIdleGcMs ?? DEFAULT_UNFLUSHED_IDLE_GC_MS;

		// Injectable embedded assets (test seam); otherwise the bundled web
		// assets serve when no --web-root is given (single-file distribution).
		// Computed before Projects: reserved project-id derivation reads the
		// asset surface.
		if (options.embeddedAssets) {
			this.embeddedAssets = options.embeddedAssets;
		} else if (!options.webRoot && Object.keys(embeddedAssets).length > 0) {
			this.embeddedAssets = embeddedAssets as Record<string, string>;
		}

		// Projects are static daemon configuration (ADR 11). Invalid ids,
		// duplicate ids, shared session storage, and web-asset collisions fail
		// startup.
		const projects = buildProjects(options.allow ?? [process.cwd()], this.agentDir, this.reservedProjectIds());
		this.projects = new Map(projects.map((p) => [p.id, p]));
		for (const project of projects) {
			try {
				this.projectSettings.set(project.id, SettingsManager.create(project.cwd, this.agentDir));
			} catch {
				// Unreadable settings degrade to the model-runtime defaults below.
			}
		}
		// Duplicate session ids are unsupported input: fail startup rather than
		// serve two addresses that would collide in the activation registry.
		this.assertNoSessionIdConflicts();

		if (options.logPath) {
			this.logger = TrafficLogger.open(options.logPath);
		}

		// Injectable deps (test seam)
		this.modelRuntime =
			options.modelRuntime ?? (await ModelRuntime.create({ authPath: join(this.agentDir, "auth.json") }));
		this.managerFactory = options.managerFactory ?? createManager;

		// Load extensions onto the daemon's modelRuntime so they are visible
		// in getDaemonInfo before any session is activated.
		await this.loadExtensions();

		// No auto-created activations — created on demand via openSession/newSession.

		await this.startServer();
	}

	/** Returns the address the server is listening on, or null if not started. */
	get address(): { port: number; host: string } | null {
		if (!this.httpServer) return null;
		const addr = this.httpServer.address() as AddressInfo;
		return { port: addr.port, host: addr.address };
	}

	async dispose(): Promise<void> {
		await this.stopServer();
		if (this.logger) {
			this.logger.dispose();
			this.logger = null;
		}
		const managers: Manager[] = [];
		const pendingCollections: Promise<void>[] = [];
		for (const a of this.activations.values()) {
			if (a.gcTimer) clearTimeout(a.gcTimer);
			// A mid-collection activation already owns its disposal; awaiting it
			// avoids a concurrent double-dispose, then it drops out of the map.
			if (a.collecting) pendingCollections.push(a.collecting);
			else managers.push(a.manager);
		}
		this.activations.clear();
		this.activationByAddress.clear();
		this.pendingActivations.clear();
		this.sessionOwnerById.clear();
		this.connectionActivation.clear();
		await Promise.all(pendingCollections);
		for (const mgr of managers) {
			await mgr.dispose();
		}
	}

	/** First path segments a Project id must not collide with: real files win
	 * over routes in the HTTP server, so a same-named Project's page would be
	 * unreachable (`/assets/...` serves the file, never the shell). Derived
	 * from the actual asset surface — the web root's entries when serving
	 * from disk, the embedded asset keys otherwise — plus `assets` (vite's
	 * output dir, present in every build). */
	private reservedProjectIds(): Set<string> {
		const reserved = new Set<string>(["assets"]);
		const root = this.webRoot ?? join(import.meta.dirname, "../../dist/web");
		try {
			for (const name of readdirSync(root)) reserved.add(name);
		} catch {
			// No web root on disk (embedded-only distribution) — the embedded
			// keys below are the surface.
		}
		if (this.embeddedAssets) {
			for (const key of Object.keys(this.embeddedAssets)) reserved.add(key.split("/")[0]);
		}
		return reserved;
	}

	/**
	 * Load disk extensions (agentDir, cwd, settings) onto the daemon's shared
	 * modelRuntime so extension-registered providers are visible in
	 * getDaemonInfo before any session exists.
	 */
	private async loadExtensions(): Promise<void> {
		try {
			const cwd = process.cwd();
			const settingsManager = SettingsManager.create(cwd, this.agentDir);
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: this.agentDir,
				settingsManager,
			});
			await resourceLoader.reload();
			const extensionsResult = resourceLoader.getExtensions();
			for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations) {
				this.modelRuntime.registerProvider(name, config);
			}
			for (const { provider } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
				this.modelRuntime.registerNativeProvider(provider);
			}
			this.modelRuntime.setProxyResolvers(extensionsResult.runtime.proxyResolvers);
		} catch (error) {
			console.error(`Daemon: extension load failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// ── Session scanning ──────────────────────────────────────────────────

	/**
	 * Startup check (ADR 11): a `sessionId` claimed by two distinct
	 * `(projectId, stem)` addresses is unsupported input. Header-only read, so
	 * a large history costs one short read per file, not a full parse.
	 */
	private assertNoSessionIdConflicts(): void {
		const owners = new Map<string, string>();
		for (const project of this.projects.values()) {
			let rels: string[];
			try {
				rels = readdirSync(project.sessionDir, { recursive: true }) as string[];
			} catch {
				continue;
			}
			for (const rel of rels) {
				if (!rel.endsWith(".jsonl")) continue;
				// A symlinked `.jsonl` that escapes the namespace must not leak a
				// foreign session id into the conflict registry.
				const real = containedSessionFile(project.sessionDir, join(project.sessionDir, rel));
				if (real === null) continue;
				const sessionId = readSessionHeaderId(real);
				if (sessionId === null) continue;
				const stem = rel.split(sep).join("/").slice(0, -".jsonl".length);
				const address = `${project.id}/${stem}`;
				const owner = owners.get(sessionId);
				if (owner !== undefined && owner !== address) {
					throw new Error(`Duplicate session id "${sessionId}" in ${owner} and ${address}`);
				}
				owners.set(sessionId, address);
			}
		}
	}

	/** Recursively discover session files plus live (possibly unflushed)
	 * activations, keyed by stem. Active entries win over disk rows. */
	private scanProjectSessions(project: ProjectConfig): ScanEntry[] {
		const byStem = new Map<string, ScanEntry>();

		let rels: string[] = [];
		try {
			rels = readdirSync(project.sessionDir, { recursive: true }) as string[];
		} catch {
			rels = [];
		}
		for (const rel of rels) {
			if (!rel.endsWith(".jsonl")) continue;
			// Containment first: statSync follows symlinks, so a symlinked file
			// pointing outside the namespace would otherwise expose foreign
			// metadata (name, first message) in listSessions (ADR 11 boundary).
			const real = containedSessionFile(project.sessionDir, join(project.sessionDir, rel));
			if (real === null) continue;
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(real);
			} catch {
				continue;
			}
			const stem = rel.split(sep).join("/").slice(0, -".jsonl".length);
			byStem.set(stem, { stem, abs: real, sortTimeMs: st.mtimeMs });
		}

		for (const activation of this.activations.values()) {
			if (activation.ref.projectId !== project.id) continue;
			// A collecting activation is mid-disposal: it is no longer active, but
			// its address stays reserved (see maybeCollect). A durable file still
			// appears through the disk scan above; an unflushed one disappears.
			if (activation.collecting !== null) continue;
			const abs = activation.manager.sessionFile;
			let sortTimeMs = Date.parse(activation.manager.createdAt);
			if (existsSync(abs)) {
				try {
					sortTimeMs = statSync(abs).mtimeMs;
				} catch {
					// fall back to the header creation time
				}
			}
			byStem.set(activation.ref.stem, { stem: activation.ref.stem, abs, sortTimeMs, active: activation });
		}

		return [...byStem.values()];
	}

	private async listSessionsFor(
		projectId: string,
		max?: number,
		cursor?: SessionListCursor | null,
	): Promise<{ sessions: SessionInfo[]; hasMore: boolean; nextCursor?: SessionListCursor }> {
		const project = this.projects.get(projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);

		const all = this.scanProjectSessions(project);
		// Total order: sort time desc, then canonical stem desc (ADR 11).
		all.sort((a, b) => {
			if (a.sortTimeMs !== b.sortTimeMs) return b.sortTimeMs - a.sortTimeMs;
			if (a.stem === b.stem) return 0;
			return a.stem < b.stem ? 1 : -1;
		});
		const after = cursor
			? all.filter(
					(e) => e.sortTimeMs < cursor.sortTimeMs || (e.sortTimeMs === cursor.sortTimeMs && e.stem < cursor.stem),
				)
			: all;

		const limit = max !== undefined && max > 0 ? max : after.length;
		const sliced = after.slice(0, limit);
		const hasMore = after.length > sliced.length;
		const sessions = sliced.map((e) => this.toSessionInfo(project, e));
		const last = sliced[sliced.length - 1];
		return {
			sessions,
			hasMore,
			nextCursor: last ? { sortTimeMs: last.sortTimeMs, stem: last.stem } : undefined,
		};
	}

	/** Global active/streaming snapshot over the activation registry. */
	listActiveSessions(): SessionInfo[] {
		const out: SessionInfo[] = [];
		for (const activation of this.activations.values()) {
			if (activation.collecting !== null) continue;
			const project = this.projects.get(activation.ref.projectId);
			if (!project) continue;
			const abs = activation.manager.sessionFile;
			let sortTimeMs = Date.parse(activation.manager.createdAt);
			if (existsSync(abs)) {
				try {
					sortTimeMs = statSync(abs).mtimeMs;
				} catch {
					// fall back to the header creation time
				}
			}
			out.push(this.toSessionInfo(project, { stem: activation.ref.stem, abs, sortTimeMs, active: activation }));
		}
		out.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
		return out;
	}

	private toSessionInfo(project: ProjectConfig, entry: ScanEntry): SessionInfo {
		const activation = entry.active;
		// A durable file is the metadata source even while active; only an
		// unflushed activation has no file to read, so its document is used.
		const durable = existsSync(entry.abs);
		const meta = durable ? this.readFileMeta(entry.abs) : null;
		if (!meta && !activation) {
			// Unreadable file: surface a minimal row rather than dropping it.
			return {
				projectId: project.id,
				sessionId: entry.stem,
				stem: entry.stem,
				active: false,
				isStreaming: false,
				timestamp: new Date(entry.sortTimeMs).toISOString(),
			};
		}
		const doc = activation?.manager.document;
		return {
			projectId: project.id,
			sessionId: meta?.sessionId ?? activation?.ref.sessionId ?? entry.stem,
			stem: entry.stem,
			active: activation !== undefined,
			isStreaming: activation ? activation.manager.document.status.isStreaming : false,
			name: meta?.name ?? (doc ? doc.status.name || undefined : undefined),
			timestamp: new Date(entry.sortTimeMs).toISOString(),
			firstMessageText: meta?.firstMessageText ?? (doc ? firstUserText(doc) : undefined),
			messageCount: meta?.messageCount ?? (doc ? doc.status.stats.messages || undefined : undefined),
		};
	}

	private readFileMeta(filePath: string): FileMeta | null {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(filePath).mtimeMs;
		} catch {
			return null;
		}
		const cached = this.sessionMetaCache.get(filePath);
		if (cached && cached.mtimeMs === mtimeMs) return cached.meta;
		const meta = parseSessionFile(filePath);
		if (meta) this.sessionMetaCache.set(filePath, { mtimeMs, meta });
		return meta;
	}

	// ── Activation lifecycle (ADR 11) ─────────────────────────────────────

	/**
	 * Reserve the activation for `(projectId, stem)`: an existing live
	 * activation (cancelling its GC timer), an in-flight creation, or a new
	 * activation. A collecting activation is awaited and the reservation
	 * retried, so a GC racing an open never disposes a reattached session.
	 */
	private async reserveActivation(project: ProjectConfig, stem: string, abs: string): Promise<Activation> {
		const key = addressKey(project.id, stem);
		for (;;) {
			const existingId = this.activationByAddress.get(key);
			if (existingId !== undefined) {
				const activation = this.activations.get(existingId);
				if (activation && activation.collecting === null) {
					this.cancelGc(activation);
					return activation;
				}
				if (activation?.collecting) {
					await activation.collecting;
					continue;
				}
			}
			const pending = this.pendingActivations.get(key);
			if (pending) return pending;

			const promise = this.createActivation(project, stem, abs, key);
			this.pendingActivations.set(key, promise);
			try {
				return await promise;
			} finally {
				this.pendingActivations.delete(key);
			}
		}
	}

	private async createActivation(project: ProjectConfig, stem: string, abs: string, key: string): Promise<Activation> {
		if (!existsSync(abs)) throw new Error(`No such session: ${stem}`);
		const manager = await this.managerFactory({
			cwd: project.cwd,
			agentDir: this.agentDir,
			modelRuntime: this.modelRuntime,
			sessionPath: abs,
		});
		const sessionId = manager.liveSessionId;
		const owner = this.sessionOwnerById.get(sessionId);
		if (owner && (owner.projectId !== project.id || owner.stem !== stem)) {
			await manager.dispose();
			throw new Error(`Session id is already addressed as ${owner.projectId}/${owner.stem}`);
		}
		return this.registerActivation(manager, { projectId: project.id, sessionId, stem }, key);
	}

	private registerActivation(manager: Manager, ref: SessionRef, key: string): Activation {
		const activation: Activation = {
			id: randomUUID(),
			ref,
			manager,
			connections: new Set(),
			gcTimer: null,
			collecting: null,
			lastStreaming: manager.document.status.isStreaming,
		};
		this.activations.set(activation.id, activation);
		this.activationByAddress.set(key, activation.id);
		this.sessionOwnerById.set(ref.sessionId, { projectId: ref.projectId, stem: ref.stem });

		manager.onSettled(() => {
			// The first settle after newSession flushes the file — rescan so the
			// session moves to mtime ordering and its metadata appears.
			this.broadcastSessionsChanged(ref.projectId);
			this.broadcastActiveSessions();
		});
		manager.onPatch(() => {
			const streaming = manager.document.status.isStreaming;
			if (streaming !== activation.lastStreaming) {
				activation.lastStreaming = streaming;
				this.broadcastActiveSessions();
			}
		});

		this.broadcastActiveSessions();
		return activation;
	}

	/**
	 * Idle collection. The eligibility check and the disposal share the
	 * activation's `collecting` reservation, so a concurrent `openSession`
	 * cannot dispose an activation it has just reattached.
	 */
	private armGc(activation: Activation): void {
		if (activation.gcTimer !== null || activation.collecting !== null) return;
		if (activation.connections.size > 0) return;
		const durable = existsSync(activation.manager.sessionFile);
		const empty = Object.keys(activation.manager.document.entries).length === 0;
		const delay = durable || empty ? this.idleGcMs : this.unflushedIdleGcMs;
		activation.gcTimer = setTimeout(() => {
			activation.gcTimer = null;
			void this.maybeCollect(activation);
		}, delay);
	}

	private cancelGc(activation: Activation): void {
		if (activation.gcTimer !== null) {
			clearTimeout(activation.gcTimer);
			activation.gcTimer = null;
		}
	}

	private async maybeCollect(activation: Activation): Promise<void> {
		if (activation.collecting !== null || activation.connections.size > 0) return;
		const status = activation.manager.document.status;
		if (status.isStreaming || status.isCompacting) {
			this.armGc(activation);
			return;
		}
		await this.collectActivation(activation);
	}

	/** Dispose `activation` under its `collecting` reservation. Shared by idle
	 * GC (via maybeCollect, after eligibility checks) and the explicit
	 * closeSession verb (no eligibility checks — a close is a user-initiated
	 * kill, so streaming state and attachments do not defer it). */
	private async collectActivation(activation: Activation): Promise<void> {
		if (activation.collecting !== null) {
			await activation.collecting;
			return;
		}
		this.cancelGc(activation);
		activation.collecting = this.disposeActivation(activation).finally(() => {
			activation.collecting = null;
			this.broadcastActiveSessions();
		});
		await activation.collecting;
	}

	private async disposeActivation(activation: Activation): Promise<void> {
		// Dispose first, then release the address. Releasing it before disposal
		// would let a concurrent openSession create a second activation for a
		// session whose first Manager is still shutting down, violating the
		// ADR 11 exclusivity invariant. The address (and its pending-open
		// promise) stays reserved for the whole disposal.
		await activation.manager.dispose();
		this.activations.delete(activation.id);
		const key = addressKey(activation.ref.projectId, activation.ref.stem);
		if (this.activationByAddress.get(key) === activation.id) this.activationByAddress.delete(key);
		const owner = this.sessionOwnerById.get(activation.ref.sessionId);
		if (owner && owner.projectId === activation.ref.projectId && owner.stem === activation.ref.stem) {
			this.sessionOwnerById.delete(activation.ref.sessionId);
		}
		// Sever the Connection→activation mappings so a later detach/release on
		// a still-attached Connection cannot arm GC on the disposed activation.
		// The Connections keep their last-received document (ADR 11 defers a
		// per-attachment death push) until they navigate or reconnect.
		for (const conn of activation.connections) {
			this.connectionActivation.delete(conn);
		}
		activation.connections.clear();
	}

	private attachConnection(conn: Connection, activation: Activation, cursor: PrefixCursor | null): void {
		// A socket that closed while its openSession/newSession RPC was in
		// flight: the close handler already ran (and released nothing — the
		// connection was not yet attached), so attaching now would pin the
		// activation forever with an unreleasable Connection. Arm GC instead;
		// the orphaned activation collects on the normal idle path.
		if (conn.isDisposed) {
			this.armGc(activation);
			return;
		}
		this.releaseConnection(conn);
		conn.attach(activation.manager, activation.ref, cursor);
		activation.connections.add(conn);
		this.connectionActivation.set(conn, activation);
		this.cancelGc(activation);
	}

	private releaseConnection(conn: Connection): void {
		const activation = this.connectionActivation.get(conn);
		if (!activation) return;
		this.connectionActivation.delete(conn);
		activation.connections.delete(conn);
		if (activation.connections.size === 0) this.armGc(activation);
	}

	// ── Broadcasts ────────────────────────────────────────────────────────

	private broadcastSessionsChanged(projectId: string): void {
		void this.listSessionsFor(projectId, SESSION_PAGE_SIZE)
			.then((page) => {
				const frame: Record<string, unknown> = {
					kind: "sessions_changed",
					projectId,
					sessions: page.sessions,
					hasMore: page.hasMore,
				};
				if (page.nextCursor) frame.nextCursor = page.nextCursor;
				for (const conn of this.connections) conn.push(frame);
			})
			.catch(() => {
				// A failed refresh is recoverable: the client still holds a
				// previous page and will re-query on the next navigation.
			});
	}

	private broadcastActiveSessions(): void {
		const frame: Record<string, unknown> = { kind: "active_sessions_changed", sessions: this.listActiveSessions() };
		for (const conn of this.connections) conn.push(frame);
	}

	// ── Daemon verbs (called by Connection) ───────────────────────────────

	private daemonVerbs: DaemonVerbs = {
		listSessions: (projectId, max, cursor) => this.listSessionsFor(projectId, max, cursor),

		listActiveSessions: () => this.listActiveSessions(),

		openSession: async (projectId, stem, conn, cursor) => {
			try {
				const project = this.projects.get(projectId);
				if (!project) return { ok: false, error: `Unknown project: ${projectId}` };
				const normalized = normalizeStem(stem);
				const abs = resolveStemPath(project.sessionDir, normalized);
				const activation = await this.reserveActivation(project, normalized, abs);
				this.attachConnection(conn, activation, cursor ?? null);
				return { ok: true, session: activation.ref };
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},

		newSession: async (projectId, conn, text, options) => {
			const { images, model, thinkingLevel } = options ?? {};
			try {
				const project = this.projects.get(projectId);
				if (!project) return { ok: false, error: `Unknown project: ${projectId}` };
				const manager = await this.managerFactory({
					cwd: project.cwd,
					agentDir: this.agentDir,
					modelRuntime: this.modelRuntime,
				});
				let stem: string;
				try {
					stem = stemFromSessionPath(project.sessionDir, manager.sessionFile);
				} catch (err) {
					await manager.dispose();
					throw err;
				}
				const key = addressKey(projectId, stem);
				if (this.activationByAddress.has(key)) {
					await manager.dispose();
					throw new Error(`Session already active: ${stem}`);
				}
				const activation = this.registerActivation(
					manager,
					{ projectId, sessionId: manager.liveSessionId, stem },
					key,
				);
				// Pre-session choices from the Project home (ADR 12 slice): apply the
				// picked model and thinking level, then admit the first prompt (with
				// its attachments) before the attach — the client's initial sync
				// carries the in-flight turn on the chosen model, and no empty
				// session exists while the user types. A refused admission or
				// unknown model (no model, no auth) disposes the fresh activation —
				// nothing empty survives to idle-collect later. Patches streamed
				// between admission and attach are covered by the initial sync (the
				// Document is canonical).
				try {
					if (model) await manager.setModel(model.provider, model.modelId);
					if (thinkingLevel) await manager.setThinkingLevel(thinkingLevel);
					await manager.promptAdmitted(text, images);
				} catch (err) {
					await this.collectActivation(activation);
					throw err;
				}
				this.attachConnection(conn, activation, null);
				return { ok: true, session: activation.ref };
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},

		detach: (conn) => {
			this.releaseConnection(conn);
			conn.detach();
		},

		closeSession: async (projectId, stem) => {
			try {
				const project = this.projects.get(projectId);
				if (!project) return { ok: false, error: `Unknown project: ${projectId}` };
				const normalized = normalizeStem(stem);
				const activationId = this.activationByAddress.get(addressKey(projectId, normalized));
				const activation = activationId !== undefined ? this.activations.get(activationId) : undefined;
				if (!activation || activation.collecting !== null) {
					return { ok: false, error: `Session is not active: ${normalized}` };
				}
				await this.collectActivation(activation);
				// Refresh the Project's first page everywhere: the kill's flush
				// (and an unflushed session's disappearance) reorders history.
				this.broadcastSessionsChanged(projectId);
				return { ok: true };
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},

		sessionsChanged: (projectId) => this.broadcastSessionsChanged(projectId),

		listFiles: (prefix: string, projectId: string): Array<{ path: string; isDirectory: boolean }> => {
			const project = this.projects.get(projectId);
			if (!project) throw new Error(`Unknown project: ${projectId}`);
			return listFiles(prefix, project.cwd);
		},

		readFile: (path: string, cwd?: string) => readHostFile(path, cwd ?? process.cwd()),

		gitShow: (commit: string, cwd?: string) => runGitShow(commit, cwd ?? process.cwd()),

		getDaemonInfo: async () => {
			const runtime = this.modelRuntime;
			let models: ModelInfo[] = [];
			if (runtime) {
				models = runtime.getAvailableSnapshot().map((m) => ({
					provider: m.provider,
					providerName: runtime.getProvider(m.provider)?.name,
					id: m.id,
					name: m.name ?? m.id,
					reasoning: m.reasoning ?? false,
					supportedThinkingLevels: getSupportedThinkingLevels(m),
					contextWindow: m.contextWindow,
				}));
			}
			const projects: ProjectInfo[] = await Promise.all(
				[...this.projects.values()].map(async (p) => {
					const defaults = await this.projectDefaults(p.id);
					return {
						id: p.id,
						cwd: p.cwd,
						defaultModel: defaults.model,
						defaultThinkingLevel: defaults.thinkingLevel,
					};
				}),
			);
			return { projects, models, thinkingLevels: THINKING_LEVELS, devMode: this.devMode };
		},
	};

	/** The model and thinking level a fresh session in `projectId` resolves
	 * to — the same `findInitialModel` call a fresh Manager's session performs
	 * (scopedModels empty, not continuing, the Project's settings), so the
	 * reported defaults match what `newSession` without `model`/
	 * `thinkingLevel` actually runs on. */
	private async projectDefaults(projectId: string): Promise<{ model: ModelRef | null; thinkingLevel: string | null }> {
		const settings = this.projectSettings.get(projectId);
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			...(settings
				? {
						defaultProvider: settings.getDefaultProvider(),
						defaultModelId: settings.getDefaultModel(),
						defaultThinkingLevel: settings.getDefaultThinkingLevel(),
						modelThinkingLevels: settings.getAllModelThinkingLevels(),
					}
				: {}),
			modelRuntime: this.modelRuntime,
		});
		return {
			model: result.model ? { provider: result.model.provider, modelId: result.model.id } : null,
			thinkingLevel: result.model ? result.thinkingLevel : null,
		};
	}

	// ── Server ────────────────────────────────────────────────────────────

	/** Try to serve an embedded asset; returns true if served. */
	private tryServeEmbedded(path: string, res: ServerResponse): boolean {
		if (!this.embeddedAssets) return false;
		// Normalize: strip leading /, default / → index.html
		let key = path === "/" ? "index.html" : path.replace(/^\//, "");
		// SPA routes have no embedded asset of their own — they serve the shell
		// and the client resolves the address (ADR 11).
		if (this.isAppRoute(path)) key = "index.html";
		const encoded = this.embeddedAssets[key];
		if (!encoded) return false;

		const ext = extname(key);
		const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
		const content = Buffer.from(encoded, "base64");
		res.writeHead(200, { "Content-Type": contentType });
		res.end(content);
		return true;
	}

	/** Probe whether a port is available on :: by creating a temporary listener. */
	private async probePort(port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const server = createNetServer();
			server.once("error", () => {
				server.close(() => resolve(false));
			});
			server.listen(port, "::", () => {
				server.close(() => resolve(true));
			});
		});
	}

	/** Known application routes serve index.html (ADR 11): `/<projectId>` is
	 * the Project's home and `/<projectId>/<stem...>` one session. The first
	 * segment must be a configured Project id — ids match `[a-z0-9-]`, so no
	 * percent-decoding is needed and an encoded segment simply doesn't match.
	 * Real files win over routes (assets are tried first), which is why ids
	 * colliding with root asset names are rejected at startup; unknown paths
	 * stay 404. */
	private isAppRoute(path: string): boolean {
		const first = path.replace(/^\//, "").split("/")[0];
		return first !== "" && this.projects.has(first);
	}

	private async startServer(): Promise<void> {
		const root = this.webRoot ?? join(import.meta.dirname, "../../dist/web");

		this.httpServer = createServer((req, res) => {
			let path = req.url?.split("?")[0] ?? "/";
			if (path === "/") path = "/index.html";

			// Try embedded assets first (single-file distribution)
			if (this.tryServeEmbedded(path, res)) return;

			const filePath = join(root, path);

			// Path-boundary containment: `join()` resolves literal `..`
			// components, and a plain string-prefix check would pass
			// `<parentOfRoot>/root-x/...` against root `/.../root` — exposing
			// sibling directories of webRoot (ADR 11 security boundary rule).
			if (!isContained(root, filePath)) {
				res.writeHead(403);
				res.end("Forbidden");
				return;
			}

			// SPA routes: serve the shell; the client resolves the address.
			if (this.isAppRoute(path)) {
				const indexPath = join(root, "index.html");
				if (existsSync(indexPath)) {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(readFileSync(indexPath));
					return;
				}
			}

			if (!existsSync(filePath)) {
				res.writeHead(404);
				res.end("Not found");
				return;
			}

			const ext = extname(filePath);
			const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
			const content = readFileSync(filePath);
			res.writeHead(200, { "Content-Type": contentType });
			res.end(content);
		});

		const wss = new WebSocketServer({ server: this.httpServer });
		this.wss = wss;

		wss.on("connection", (ws: WebSocket) => {
			const conn = new Connection(ws, this.daemonVerbs, this.logger, this.devMode);
			this.connections.add(conn);

			ws.on("close", () => {
				this.releaseConnection(conn);
				conn.dispose();
				this.connections.delete(conn);
			});
		});

		// When no explicit port, probe the default range for a semi-deterministic port.
		if (this.port === undefined) {
			for (let p = DEFAULT_PORT_RANGE.start; p < DEFAULT_PORT_RANGE.end; p++) {
				if (await this.probePort(p)) {
					this.port = p;
					break;
				}
			}
		}

		return new Promise((resolve) => {
			this.httpServer!.listen(this.port ?? 0, "::", () => {
				resolve();
			});
		});
	}

	private async stopServer(): Promise<void> {
		if (!this.wss) return;
		for (const ws of this.wss.clients) {
			ws.close();
		}
		this.wss.close();
		this.wss = null;
		this.connections.clear();
		if (this.httpServer) {
			return new Promise((resolve) => {
				this.httpServer!.close(() => resolve());
			});
		}
	}
}

// ── Session address key ──────────────────────────────────────────────────

function addressKey(projectId: string, stem: string): string {
	return `${projectId}\0${stem}`;
}

// ── Lightweight session file parser (avoids SessionManager.list re-read) ─

interface FileSessionEntry {
	type?: string;
	id?: string;
	name?: string;
	message?: { role?: string; content?: unknown; timestamp?: number };
	timestamp?: string;
	[key: string]: unknown;
}

/** Cap for the header-only scan. A pi session header is a single short line. */
const HEADER_SCAN_BYTES = 64 * 1024;

/** Read just the session id from a file's first line, or null. */
function readSessionHeaderId(filePath: string): string | null {
	let fd: number | undefined;
	try {
		const st = statSync(filePath);
		const len = Math.min(st.size, HEADER_SCAN_BYTES);
		const buf = Buffer.alloc(len);
		fd = openSync(filePath, "r");
		readSync(fd, buf, 0, len, 0);
		const firstLine = buf.toString("utf8").split("\n", 1)[0]?.trim();
		if (!firstLine) return null;
		const entry = JSON.parse(firstLine) as FileSessionEntry;
		if (entry.type !== "session") return null;
		return typeof entry.id === "string" ? entry.id : null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function parseSessionFile(filePath: string): FileMeta | null {
	try {
		const content = readFileSync(filePath, "utf8");
		const lines = content.split("\n");

		let sessionId: string | null = null;
		let name: string | undefined;
		let firstMessageText: string | undefined;
		let messageCount = 0;
		let foundHeader = false;

		for (const raw of lines) {
			const line = raw.trim();
			if (!line) continue;
			try {
				const entry = JSON.parse(line) as FileSessionEntry;

				if (!foundHeader) {
					if (entry.type !== "session") return null;
					// Durable session id from the header (ADR 09) — the client cache
					// key. Never the file path: paths change across session dirs.
					sessionId = typeof entry.id === "string" ? entry.id : null;
					foundHeader = true;
					continue;
				}

				if (entry.type === "session_info") {
					if (entry.name !== undefined) {
						name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
					}
				}

				if (entry.type !== "message") continue;
				messageCount++;

				if (!firstMessageText) {
					const msg = entry.message;
					if (msg?.role === "user") {
						firstMessageText = extractSimpleText(msg.content);
					}
				}
			} catch {
				// skip malformed lines
			}
		}

		if (!foundHeader) return null;

		return {
			sessionId: sessionId ?? basename(filePath),
			name,
			firstMessageText: firstMessageText || undefined,
			messageCount: messageCount || undefined,
		};
	} catch {
		return null;
	}
}

function extractSimpleText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const item of content) {
			const block = item as { type?: string; text?: string; thinking?: string };
			if (block.type === "text") {
				if (block.text) parts.push(block.text);
			} else if (block.type === "thinking") {
				if (block.thinking) parts.push(block.thinking);
			}
		}
		return parts.join(" ");
	}
	return "";
}

// ── Document-derived metadata (unflushed active sessions) ────────────────

const PREVIEW_MAX = 120;

/** First user-message text from a live document, clamped to one line. */
function firstUserText(doc: Document): string | undefined {
	let first: string | undefined;
	let firstTs = "";
	for (const entry of Object.values(doc.entries)) {
		if (entry.kind !== "message" || entry.role !== "user") continue;
		const ts = entry.timestamp ?? "";
		if (first !== undefined && firstTs !== "" && ts >= firstTs) continue;
		const text = extractFirstText(entry.content);
		if (text) {
			first = text;
			firstTs = ts;
		}
	}
	return first ? clampPreview(first) : undefined;
}

function extractFirstText(content: Content[]): string | undefined {
	for (const block of content) {
		if (block.type === "text" && block.text) return block.text;
	}
	return undefined;
}

function clampPreview(text: string): string {
	const single = text.replace(/\s+/g, " ").trim();
	if (single.length <= PREVIEW_MAX) return single;
	return `${single.slice(0, PREVIEW_MAX - 1)}…`;
}

// ── File reads (web viewer) ───────────────────────────────────────────────

/** Byte cap for viewer reads. Larger files return a prefix with truncated=true
 * — the viewer is a human reading surface, not a data channel, and an
 * unbounded reply would stall the socket on huge files. */
export const MAX_READ_FILE_BYTES = 256 * 1024;

/** Read a file fresh from disk for the `readFile` verb. Relative paths (and
 * `~`) resolve against the session's Project cwd; throws on missing paths /
 * non-files so the Connection converts the message into an `ok:false` reply.
 * Exported for Connection-level tests (the DaemonVerbs seam takes the same
 * function). */
export function readHostFile(
	rawPath: string,
	cwd: string,
): { path: string; content: string; truncated: boolean; bytes: number } {
	let p = rawPath;
	if (p.startsWith("~")) {
		p = (process.env.HOME ?? process.env.USERPROFILE ?? "") + p.slice(1);
	}
	const abs = isAbsolute(p) ? p : join(cwd, p);
	const st = statSync(abs);
	if (!st.isFile()) throw new Error(`Not a file: ${abs}`);

	const len = Math.min(st.size, MAX_READ_FILE_BYTES);
	const buf = Buffer.alloc(len);
	const fd = openSync(abs, "r");
	try {
		readSync(fd, buf, 0, len, 0);
	} finally {
		closeSync(fd);
	}
	return {
		path: abs,
		content: buf.toString("utf8"),
		truncated: st.size > MAX_READ_FILE_BYTES,
		bytes: st.size,
	};
}

// ── Git show (ADR 10 v2 change-card expansion) ──────────────────────────

/** Byte cap for `git show` output. Same rationale as MAX_READ_FILE_BYTES:
 a human reading surface, not a data channel. */
export const MAX_GIT_SHOW_BYTES = 128 * 1024;

/** Hard lifetime for the `git show` spawn, so a hanging git (interactive
 * hooks, exotic filters) cannot stall the RPC. */
const GIT_SHOW_TIMEOUT_MS = 5000;

/** Strict commit-id check before any spawn — the value arrives from the
 * wire, and `execFile` passes it as one argv entry, but it is also
 * interpolated into a git revision expression, so only a known-shape
 * object id is acceptable. */
const GIT_COMMIT_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** Run `git show --stat --no-color <commit>` in `cwd`. Exported for
 * Connection-level tests (the DaemonVerbs seam takes the same function).
 * Throws on non-hex commits, spawn failures, timeouts, and exit-nonzero
 * (unreachable commits — rebased/reset away — included), so the Connection
 * converts the message into an `ok:false` reply. */
export async function runGitShow(commit: string, cwd: string): Promise<{ output: string; truncated: boolean }> {
	if (!GIT_COMMIT_RE.test(commit)) throw new Error("Invalid commit id");
	return new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			["show", "--stat", "--no-color", commit],
			{ cwd, timeout: GIT_SHOW_TIMEOUT_MS, maxBuffer: MAX_GIT_SHOW_BYTES * 2, windowsHide: true },
			(err, stdout) => {
				if (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
					return;
				}
				const buf = Buffer.from(stdout, "utf8");
				resolve({
					output: buf.subarray(0, MAX_GIT_SHOW_BYTES).toString("utf8"),
					truncated: buf.length > MAX_GIT_SHOW_BYTES,
				});
			},
		);
		// execFile's timeout kills the child; the callback still fires with
		// an error, so no extra bookkeeping is needed.
		void child;
	});
}

// ── File path completion ─────────────────────────────────────────────────

const MAX_COMPLETIONS = 40;

function listFiles(prefix: string, cwd: string): Array<{ path: string; isDirectory: boolean }> {
	let searchDir: string;
	let fileFilter: string;

	if (prefix === "" || prefix === "./" || prefix === ".") {
		searchDir = cwd;
		fileFilter = "";
	} else if (prefix.startsWith("~")) {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "/";
		const rest = prefix.slice(1);
		if (rest === "" || rest === "/") {
			searchDir = home + rest;
			fileFilter = "";
		} else {
			searchDir = dirname(home + rest);
			fileFilter = basename(rest);
		}
	} else if (prefix.endsWith("/")) {
		searchDir = isAbsolute(prefix) ? prefix : join(cwd, prefix);
		fileFilter = "";
	} else {
		const dir = dirname(prefix);
		fileFilter = basename(prefix);
		searchDir = dir === "." ? cwd : isAbsolute(dir) ? dir : join(cwd, dir);
	}

	try {
		const entries = readdirSync(searchDir, { withFileTypes: true });
		const results: Array<{ path: string; isDirectory: boolean }> = [];

		for (const entry of entries) {
			if (entry.name.startsWith(".") && !fileFilter.startsWith(".")) continue;
			if (fileFilter && !entry.name.toLowerCase().startsWith(fileFilter.toLowerCase())) continue;

			let isDirectory = entry.isDirectory();
			if (!isDirectory && entry.isSymbolicLink()) {
				try {
					isDirectory = statSync(join(searchDir, entry.name)).isDirectory();
				} catch {
					// broken symlink
				}
			}

			const entryPath =
				prefix.endsWith("/") || prefix === ""
					? prefix + entry.name
					: prefix.slice(0, prefix.lastIndexOf("/") + 1) + entry.name;

			results.push({ path: entryPath, isDirectory });
			if (results.length >= MAX_COMPLETIONS) break;
		}

		results.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
			return a.path.localeCompare(b.path);
		});

		return results;
	} catch {
		return [];
	}
}

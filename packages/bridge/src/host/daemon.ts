import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	findInitialModel,
	getAgentDir,
	ModelRuntime,
	resolveModelScopeWithDiagnostics,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type WebSocket, WebSocketServer } from "ws";
import type {
	Content,
	DirectoryEntry,
	DirectoryListing,
	Document,
	GitDiffFileStat,
	GitDiffFileStatus,
	ModelInfo,
	ModelRef,
	PinnedModelInfo,
	PrefixCursor,
	ProjectInfo,
	SessionInfo,
	SessionListCursor,
	SessionRef,
	SnapshotFile,
} from "../core/index.ts";
import { Connection, type DaemonVerbs } from "./connection.ts";
import embeddedAssets from "./embedded-assets.ts";
import { TrafficLogger } from "./logger.ts";
import { createManager, type Manager } from "./manager.ts";
import { resolveVisibleModelKeys } from "./model-visibility.ts";
import {
	archiveStemFile,
	buildProjects,
	containedSessionFile,
	isArchivedStem,
	isContained,
	normalizeStem,
	type ProjectConfig,
	resolveStemPath,
	stemFromSessionPath,
} from "./projects.ts";
import { readBridgeSettings } from "./settings.ts";

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
	lastMessageText?: string;
	lastActivityAt?: string;
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
	/** Daemon-wide global settings (cwd-independent): the `enabledModels` scope
	 * reported by `getDaemonInfo` for the Project home's Pinned group. */
	private globalSettings: SettingsManager | null = null;
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
		// Global settings are cwd-independent; created even when no Projects are
		// configured so `getDaemonInfo` can still report the global model scope.
		try {
			this.globalSettings = SettingsManager.create(process.cwd(), this.agentDir);
		} catch {
			this.globalSettings = null;
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
				const stem = rel.split(sep).join("/").slice(0, -".jsonl".length);
				// Archived sessions are outside discovery, so they must not
				// participate in the uniqueness invariant either: a manual copy into
				// `.archive/` would otherwise fail daemon startup.
				if (isArchivedStem(stem)) continue;
				// A symlinked `.jsonl` that escapes the namespace must not leak a
				// foreign session id into the conflict registry.
				const real = containedSessionFile(project.sessionDir, join(project.sessionDir, rel));
				if (real === null) continue;
				const sessionId = readSessionHeaderId(real);
				if (sessionId === null) continue;
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
			const stem = rel.split(sep).join("/").slice(0, -".jsonl".length);
			// The archive prefix is a storage namespace, not discovery: an
			// archived session is not listed and has no address.
			if (isArchivedStem(stem)) continue;
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
		const live = doc ? documentSummary(doc) : undefined;
		return {
			projectId: project.id,
			sessionId: meta?.sessionId ?? activation?.ref.sessionId ?? entry.stem,
			stem: entry.stem,
			active: activation !== undefined,
			isStreaming: activation ? activation.manager.document.status.isStreaming : false,
			name: meta?.name ?? (doc ? doc.status.name || undefined : undefined),
			timestamp: new Date(entry.sortTimeMs).toISOString(),
			firstMessageText: meta?.firstMessageText ?? live?.firstMessageText,
			// The live preview/activity win over the last flush for an active row;
			// an inactive row has only the file scan.
			lastMessageText: live?.lastMessageText ?? meta?.lastMessageText,
			lastActivityAt: live?.lastActivityAt ?? meta?.lastActivityAt,
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

	/** Resolve pi's global `enabledModels` scope into the pinned list (ADR 15).
	 * Project-level overrides are intentionally ignored: pinned models is one
	 * daemon-global concept, not a per-Project setting. */
	private async resolvePinnedModels(): Promise<PinnedModelInfo[]> {
		const patterns = this.globalSettings?.getGlobalSettings().enabledModels;
		if (!patterns || patterns.length === 0) return [];
		const { scopedModels: resolved } = await resolveModelScopeWithDiagnostics(patterns, this.modelRuntime);
		return resolved.map((sm) => ({
			provider: sm.model.provider,
			id: sm.model.id,
			name: sm.model.name ?? sm.model.id,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	/** Push the daemon-global pinned list to every Connection (ADR 15). */
	private async broadcastPinnedModels(): Promise<void> {
		const frame: Record<string, unknown> = {
			kind: "pinned_models_changed",
			pinnedModels: await this.resolvePinnedModels(),
		};
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

		archiveSession: async (projectId, stem) => {
			try {
				const project = this.projects.get(projectId);
				if (!project) return { ok: false, error: `Unknown project: ${projectId}` };
				// Rejects the archive prefix itself, so an archived stem can never be
				// re-addressed (see ARCHIVE_DIR).
				const normalized = normalizeStem(stem);
				// Close first, unconditionally: disposal finalizes an in-flight turn,
				// which can create or advance the file, so the move must follow it.
				// A dormant session has no activation — the close is then a no-op and
				// only the move remains.
				const activationId = this.activationByAddress.get(addressKey(projectId, normalized));
				const activation = activationId !== undefined ? this.activations.get(activationId) : undefined;
				if (activation) await this.collectActivation(activation);
				archiveStemFile(project.sessionDir, normalized);
				// The row leaves the history pages. A live session's row already left
				// the active snapshot via collectActivation's broadcast.
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

		readFile: (path: string, state?: string) => readFileAtSnapshot(path, state ?? "worktree"),

		listDirectory: (path: string, state?: string) => listDirectory(path, state ?? "worktree"),

		gitShow: (commit: string, cwd?: string) => runGitShow(commit, cwd ?? process.cwd()),

		gitBase: (directory: string, commit: string) => resolveGitBase(directory, commit),

		gitDiff: (directory: string, oldState: string, newState: string) => runGitDiff(oldState, newState, directory),

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
			// The pinned list is daemon-global (ADR 15): pi's global `enabledModels`,
			// never a project override.
			const pinnedModels = await this.resolvePinnedModels();
			// Bridge settings own the picker's "normal" tier (ADR 15). Resolve the
			// patterns host-side so the client needs no glob engine; an absent or
			// empty scope means "everything normal".
			const visiblePatterns = readBridgeSettings(this.agentDir).visibleModels ?? [];
			const visibleModels = visiblePatterns.length > 0 ? resolveVisibleModelKeys(visiblePatterns, models) : [];

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
			return {
				projects,
				models,
				pinnedModels,
				visibleModels,
				thinkingLevels: THINKING_LEVELS,
				devMode: this.devMode,
			};
		},

		setModelPinned: async (provider: string, modelId: string, pinned: boolean) => {
			const settings = this.globalSettings;
			if (!settings) throw new Error("No global settings available");
			// Resolve the raw scope to concrete ids (pi's TUI normalizes globs the
			// same way on save), then add or remove this one model.
			const patterns = settings.getGlobalSettings().enabledModels ?? [];
			const { scopedModels: resolved } = await resolveModelScopeWithDiagnostics(patterns, this.modelRuntime);
			const key = `${provider}/${modelId}`;
			const ids = resolved.map((sm) => `${sm.model.provider}/${sm.model.id}`);
			const next = pinned
				? ids.some((id) => id.toLowerCase() === key.toLowerCase())
					? ids
					: [...ids, key]
				: ids.filter((id) => id.toLowerCase() !== key.toLowerCase());
			settings.setEnabledModels(next.length > 0 ? next : undefined);
			await settings.flush();
			await this.broadcastPinnedModels();
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
		let lastMessageText: string | undefined;
		let lastActivityAt: string | undefined;
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

				if (typeof entry.timestamp === "string" && entry.timestamp) {
					if (!lastActivityAt || entry.timestamp > lastActivityAt) lastActivityAt = entry.timestamp;
				}

				if (entry.type !== "message") continue;
				messageCount++;

				const msg = entry.message;
				if (msg?.role === "user" && !firstMessageText) {
					firstMessageText = extractSimpleText(msg.content);
				}
				// Most recent user/assistant text; thinking and tool-result blocks are
				// ignored so the preview matches the live-document extractor.
				if (msg?.role === "user" || msg?.role === "assistant") {
					const text = firstTextBlock(msg.content);
					if (text) lastMessageText = text;
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
			lastMessageText: lastMessageText ? clampPreview(lastMessageText) : undefined,
			lastActivityAt,
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

/** First `text` block of a durable message content. Thinking blocks are
 * ignored so the preview matches the live-document extractor. */
function firstTextBlock(content: unknown): string | undefined {
	if (typeof content === "string") return content || undefined;
	if (Array.isArray(content)) {
		for (const item of content) {
			const block = item as { type?: string; text?: string };
			if (block.type === "text" && block.text) return block.text;
		}
	}
	return undefined;
}

// ── Document-derived metadata (unflushed active sessions) ────────────────

const PREVIEW_MAX = 120;

/** Launcher-facing summary derived from a live Document (an unflushed or
 * active Session): the first user text, the most recent user/assistant message
 * text, and the latest entry timestamp. Text is clamped to one line. */
function documentSummary(doc: Document): {
	firstMessageText?: string;
	lastMessageText?: string;
	lastActivityAt?: string;
} {
	let first: string | undefined;
	let firstTs = "";
	let last: string | undefined;
	let lastTs: string | undefined;
	let lastActivityAt: string | undefined;
	for (const entry of Object.values(doc.entries)) {
		const ts = entry.timestamp ?? "";
		if (ts && (!lastActivityAt || ts > lastActivityAt)) lastActivityAt = ts;
		if (entry.kind !== "message") continue;
		const text = extractFirstText(entry.content);
		if (!text) continue;
		if (entry.role === "user" && (first === undefined || firstTs === "" || ts < firstTs)) {
			first = text;
			firstTs = ts;
		}
		if (lastTs === undefined || ts >= lastTs) {
			last = text;
			lastTs = ts;
		}
	}
	return {
		firstMessageText: first ? clampPreview(first) : undefined,
		lastMessageText: last ? clampPreview(last) : undefined,
		lastActivityAt,
	};
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

// ── Snapshot reads (viewer + review payloads) ─────────────────────────────

/** Byte cap for snapshot reads. Larger content returns a prefix with
 * `truncated=true` — this is a human reading surface, not a data channel, and
 * an unbounded reply would stall the socket on huge files. A truncated
 * snapshot cannot be diffed; the review surface refuses it rather than
 * rendering a phantom tail. */
export const MAX_READ_FILE_BYTES = 256 * 1024;

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

// ── Review surface: diff + file-at-commit queries over the stamp timeline ──

/** Cap on changed files one diff directive returns; the remainder is reported
 * through `filesOmitted`. Keeps a pathological diff (a mass rename, a bad
 * commit) from crossing the wire and rendering as an unbounded review. */
export const MAX_DIFF_FILES = 2000;

/** Byte cap on each diff directive stream. `MAX_DIFF_FILES` bounds the
 * *returned* list, but a byte-truncated numstat cannot supply an exact
 * `filesOmitted`, so this is a memory guard whose breach is an error rather
 * than a silently partial review. Sized far above a realistic diff: one
 * numstat record is a few dozen bytes, so 16 MiB is hundreds of thousands of
 * changed files. */
const MAX_DIFF_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Review-state selector: a pinned object id, or the "head"/"index"/
 * "worktree" sentinels (see GitDiffState). Validated before any spawn. */
const GIT_DIFF_STATE_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|head|index|worktree)$/;

/** Map a validated non-index review state to its git revision argument.
 * "index" is not a revision: it selects the staged tree, which the argv
 * builder expresses with `--cached`. */
function diffStateArg(state: string): string {
	return state === "head" ? "HEAD" : state;
}

/** Validate a review path (from the wire). A `~`-rooted path is expanded by
 * the caller; anything else must be absolute (ADR 14), with no NUL and no
 * option-style leading dash, so it can safely be interpolated into a git
 * argument. */
function validateAbsolutePath(path: string): void {
	if (path === "" || path.includes("\0") || path.startsWith("-")) throw new Error("Invalid path");
}

/** Shared git-diff argv prefix. Fixed flags keep the output deterministic:
 * repo config cannot inject external diff drivers, textconv filters, color
 * codes, or `diff.relative` path rewriting; -M keeps rename detection on
 * regardless of git version. `--relative` (given explicitly, so it overrides
 * `diff.relative` config) makes every path relative to the process cwd — the
 * browser's `absDirectory` — and scopes the directive to that subtree, so
 * changes outside it are not listed. `--literal-pathspecs` is a global
 * option, so it precedes the subcommand. */
const GIT_DIFF_FLAGS = [
	"--literal-pathspecs",
	"diff",
	"--no-color",
	"--no-ext-diff",
	"--no-textconv",
	"--relative",
	"-M",
];

/** The directive argv for one state pair. Three trees make this a matrix
 * rather than a symmetric pair: `--cached` compares against the staged tree,
 * and an index-valued base is the reverse of the canonical commit → index
 * diff. `--relative` (in GIT_DIFF_FLAGS) scopes the result to the cwd subtree
 * and makes every path relative to it. */
function gitDiffArgv(oldState: string, newState: string, format: "numstat" | "raw"): string[] {
	const argv = [...GIT_DIFF_FLAGS, format === "raw" ? "--raw" : "--numstat", "-z"];
	if (oldState === "index") {
		// index → worktree is plain `git diff`; index → head/commit is the
		// reverse of `git diff --cached`.
		if (newState === "worktree") return argv;
		argv.push("--cached", "-R", diffStateArg(newState));
		return argv;
	}
	if (newState === "index") {
		argv.push("--cached", diffStateArg(oldState));
		return argv;
	}
	argv.push(diffStateArg(oldState));
	// "worktree" is expressed by omitting the second revision.
	if (newState !== "worktree") argv.push(diffStateArg(newState));
	return argv;
}

/** Run a git command with a bounded lifetime and a byte-capped stdout.
 * Streams (unlike execFile's maxBuffer, which kills with an error), so an
 * oversized diff truncates cleanly instead of failing: once the cap is hit
 * the child is killed and the exit code is no longer meaningful. Other
 * nonzero exits and spawn failures reject, except the codes listed in
 * `allowExitCodes` — `git diff --no-index` exits 1 whenever the paths differ,
 * which is its normal success path. */
function execGitCapped(
	argv: string[],
	cwd: string,
	cap = MAX_GIT_SHOW_BYTES,
	allowExitCodes: readonly number[] = [0],
): Promise<{ output: string; truncated: boolean }> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", argv, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const chunks: Buffer[] = [];
		let total = 0;
		let truncated = false;
		let failure: Error | null = null;
		let stderrTail = "";
		let exitCode: number | null = 0;
		let settled = false;
		let forceKillTimer: NodeJS.Timeout | undefined;
		// SIGTERM first, then SIGKILL: a child that ignores the graceful signal
		// must not leave the promise (and the RPC) pending forever.
		const killHard = () => {
			child.kill("SIGTERM");
			forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
		};
		const timer = setTimeout(() => {
			failure = new Error("git timed out");
			killHard();
		}, GIT_SHOW_TIMEOUT_MS);
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			fn();
		};
		child.stdout!.on("data", (chunk: Buffer) => {
			if (truncated || total >= cap) {
				if (!truncated) {
					truncated = true;
					killHard();
				}
				return;
			}
			if (total + chunk.length > cap) {
				chunks.push(chunk.subarray(0, cap - total));
				truncated = true;
				killHard();
				return;
			}
			chunks.push(chunk);
			total += chunk.length;
		});
		child.stderr!.on("data", (chunk: Buffer) => {
			if (stderrTail.length < 2048) stderrTail += chunk.toString("utf8");
		});
		child.on("error", (err) => {
			failure = err;
			killHard();
		});
		child.on("close", (code) => {
			exitCode = code;
			if (failure) {
				finish(() => reject(failure!));
				return;
			}
			const output = Buffer.concat(chunks).toString("utf8");
			if (truncated) finish(() => resolve({ output, truncated: true }));
			else if (exitCode === null || !allowExitCodes.includes(exitCode))
				finish(() => reject(new Error(stderrTail.trim() || `git exited ${exitCode}`)));
			else finish(() => resolve({ output, truncated: false }));
		});
	});
}

/** One numstat record before the raw directive supplies its status. */
interface NumstatRecord {
	path: string;
	oldPath?: string;
	additions: number;
	deletions: number;
	binary: boolean;
}

/** Parse `git diff --numstat -z` output. Regular records are
 * `adds\tdels\tpath\0`; rename/copy records carry the source in two extra
 * NUL-separated tokens (`adds\tdels\t\0src\0dst\0`). Binary files report
 * `-` counts. Only the first two tabs are separators: a filename may itself
 * contain a tab, and splitting on every tab would truncate it. */
function parseNumstat(output: string): NumstatRecord[] {
	const files: NumstatRecord[] = [];
	const tokens = output.split("\0");
	for (let i = 0; i < tokens.length; i++) {
		const record = tokens[i]!;
		const firstTab = record.indexOf("\t");
		const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
		if (secondTab === -1) continue;
		const addsRaw = record.slice(0, firstTab);
		const delsRaw = record.slice(firstTab + 1, secondTab);
		const path = record.slice(secondTab + 1);
		const binary = addsRaw === "-" || delsRaw === "-";
		const additions = binary ? 0 : Number(addsRaw) || 0;
		const deletions = binary ? 0 : Number(delsRaw) || 0;
		if (path === "") {
			// Rename/copy: the empty path announces two more NUL tokens.
			const src = tokens[++i];
			const dst = tokens[++i];
			if (src === undefined || dst === undefined || dst === "") continue;
			files.push({ path: dst, oldPath: src, additions, deletions, binary });
			continue;
		}
		files.push({ path, additions, deletions, binary });
	}
	return files;
}

/** Cap on untracked files one review directive lists. git's own diff omits
 * untracked paths, so the host enumerates them separately; the count is
 * bounded and the remainder reported as `untrackedOmitted` rather than
 * silently dropped. Untracked entries carry no line counts — content comes
 * from the payload fetch, so no per-file `--no-index` spawn is needed. */
export const MAX_UNTRACKED_FILES = 200;

/** Byte cap on the untracked listing itself, so a pathological tree cannot
 * stream an unbounded path list through the RPC. */
const MAX_UNTRACKED_LIST_BYTES = 4 * 1024 * 1024;

/** Untracked, non-ignored files as Project-cwd-relative paths, in git's
 * sorted order. Without `--full-name`, `ls-files` reports cwd-relative paths
 * and only paths under cwd — the same base as the tracked numstat
 * (`git diff --relative`). */
async function listUntracked(cwd: string): Promise<string[]> {
	const listing = await execGitCapped(
		["ls-files", "--others", "--exclude-standard", "-z"],
		cwd,
		MAX_UNTRACKED_LIST_BYTES,
	);
	const tokens = listing.output.split("\0").filter((p) => p !== "");
	// A byte-truncated listing can end mid-path: the last token is a fragment.
	if (listing.truncated) tokens.pop();
	return tokens;
}

/** Change kind from git's raw status letter (`--raw`). */
function parseRawStatus(code: string): GitDiffFileStatus {
	switch (code.charAt(0)) {
		case "A":
			return "added";
		case "M":
			return "modified";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "C":
			return "copied";
		case "T":
			return "typechange";
		case "U":
			return "unmerged";
		default:
			return "unknown";
	}
}

/** Parse `git diff --raw -z`: one `:oldmode newmode oldoid newoid status\0`
 * header per path, followed by the path — or, for a rename/copy, the source
 * path first and the destination second. Keyed by destination path. */
function parseRawStatuses(output: string): Map<string, { status: GitDiffFileStatus; oldPath?: string }> {
	const statuses = new Map<string, { status: GitDiffFileStatus; oldPath?: string }>();
	const tokens = output.split("\0");
	for (let i = 0; i < tokens.length; i++) {
		const header = tokens[i]!;
		if (!header.startsWith(":")) continue;
		const status = parseRawStatus(header.split(" ")[4] ?? "");
		const first = tokens[++i];
		if (first === undefined || first === "") continue;
		if (status === "renamed" || status === "copied") {
			const destination = tokens[++i];
			if (destination === undefined || destination === "") continue;
			statuses.set(destination, { status, oldPath: first });
			continue;
		}
		statuses.set(first, { status });
	}
	return statuses;
}

/** The diff *directive*: which files differ between two review states, with
 * git's line counts, statuses, binary flags, and rename pairs — never patch
 * text. Paths are relative to `absDirectory`, so they resolve through
 * `readFileAtSnapshot` like every other path in the protocol. Content is
 * fetched per file, so the renderer diffs whole snapshots instead of parsing
 * git's patch format. Untracked files belong to a worktree-side diff (git's
 * own diff omits them) and are listed without counts. Exported for
 * Connection-level tests (the same seam as runGitShow). Throws on invalid
 * states, spawn failures, timeouts, and exit-nonzero (unreachable commits
 * included). */
export async function runGitDiff(
	oldState: string,
	newState: string,
	absDirectory: string,
): Promise<{ files: GitDiffFileStat[]; filesOmitted?: number; untrackedOmitted: number }> {
	if (!GIT_DIFF_STATE_RE.test(oldState) || !GIT_DIFF_STATE_RE.test(newState)) throw new Error("Invalid diff states");
	if (oldState === "worktree") throw new Error("Invalid diff states");
	if (oldState === "index" && newState === "index") throw new Error("Invalid diff states");
	if (!isAbsolute(absDirectory)) throw new Error("Invalid directory");
	// Two directives, two parsers: numstat is the authority for which files are
	// listed (one record per file, so the argv is not byte-capped — the list is
	// exact and only the *returned* slice is capped), and raw supplies the
	// status letters. The worktree can drift between the spawns; the browser
	// does not claim they are one atomic observation.
	const [stat, raw] = await Promise.all([
		execGitCapped(gitDiffArgv(oldState, newState, "numstat"), absDirectory, MAX_DIFF_OUTPUT_BYTES),
		execGitCapped(gitDiffArgv(oldState, newState, "raw"), absDirectory, MAX_DIFF_OUTPUT_BYTES),
	]);
	// numstat is the file list, so a byte-truncated stream cannot yield an exact
	// `filesOmitted` (the records past the cut are uncountable) and is refused
	// instead of reported as a partial list. Raw is only the status letters: a
	// truncated tail leaves those paths `unknown`, which the renderer already
	// treats as an uncolored row.
	if (stat.truncated) throw new Error("Diff is too large to list");
	const statuses = parseRawStatuses(raw.output);
	const records = parseNumstat(stat.output);
	const files: GitDiffFileStat[] = records.slice(0, MAX_DIFF_FILES).map((record) => ({
		...record,
		status: statuses.get(record.path)?.status ?? "unknown",
	}));
	const filesOmitted = Math.max(0, records.length - MAX_DIFF_FILES);
	let untrackedOmitted = 0;
	if (newState === "worktree") {
		const untracked = await listUntracked(absDirectory);
		untrackedOmitted = Math.max(0, untracked.length - MAX_UNTRACKED_FILES);
		for (const path of untracked.slice(0, MAX_UNTRACKED_FILES)) {
			files.push({ path, status: "added", additions: 0, deletions: 0, binary: false, untracked: true });
		}
	}
	if (filesOmitted > 0) return { files, filesOmitted, untrackedOmitted };
	return { files, untrackedOmitted };
}

// ── Snapshot content (the payload half of the review surface) ────────────

/** True when the bytes look binary: a NUL in the first 8 KB, git's own
 * heuristic. */
function looksBinary(buf: Buffer): boolean {
	return buf.subarray(0, 8192).includes(0);
}

/** True when a state resolves to a tree; distinguishes "path not in this
 * tree" from "this state does not exist" after a failed object read. Peels to
 * `^{tree}`, not `^{commit}`: a commit peels to its tree, and the empty-tree
 * oid a root-commit review uses as its baseline is already one (ADR 14), so
 * both are states a path lookup can legitimately miss in. */
async function treeResolves(rev: string, cwd: string): Promise<boolean> {
	try {
		await execGitCapped(["rev-parse", "--verify", "--quiet", `${rev}^{tree}`], cwd);
		return true;
	} catch {
		return false;
	}
}

/** True when the index is listable. Paired with `treeResolves` so a failed
 * `cat-file` can be told apart: an index that reads fine but lacks the path
 * (or holds it unmerged, with no stage-0 blob) is `absent`, while an index
 * that cannot be read at all stays an error. */
async function indexResolves(root: string, rel: string): Promise<boolean> {
	try {
		await execGitCapped(["ls-files", "-z", "--cached", "--", rel === "" ? "." : rel], root, MAX_DIRECTORY_LIST_BYTES);
		return true;
	} catch {
		return false;
	}
}

/** The worktree half of the snapshot read: a direct, capped filesystem read.
 * Missing, non-file, or unreadable paths are `absent`. */
function readWorktreeAt(abs: string): SnapshotFile {
	try {
		const st = statSync(abs);
		if (!st.isFile()) return { kind: "absent", state: "worktree", path: abs };
		const len = Math.min(st.size, MAX_READ_FILE_BYTES);
		const buf = Buffer.alloc(len);
		const fd = openSync(abs, "r");
		try {
			readSync(fd, buf, 0, len, 0);
		} finally {
			closeSync(fd);
		}
		if (looksBinary(buf)) return { kind: "binary", state: "worktree", path: abs, bytes: st.size };
		return {
			kind: "file",
			state: "worktree",
			path: abs,
			content: buf.toString("utf8"),
			truncated: st.size > MAX_READ_FILE_BYTES,
			bytes: st.size,
		};
	} catch {
		return { kind: "absent", state: "worktree", path: abs };
	}
}

// ── Repository browser (ADR 14): absolute-path reads and listings ────────

/** Cap on entries one directory listing returns; the remainder is reported
 * through `omitted`. */
export const MAX_DIRECTORY_ENTRIES = 2000;

/** Byte cap on one staged-path listing. A directory with more staged content
 * than this is refused rather than silently reported as complete, because a
 * truncated flat path list cannot be converted into a trustworthy child set. */
const MAX_DIRECTORY_LIST_BYTES = 8 * 1024 * 1024;

/** Nearest existing directory at or above an absolute path, so git can be
 * asked about a file (or a path whose file is gone) from a directory that is
 * still there. */
function nearestExistingAncestor(abs: string): string | null {
	let current = abs;
	for (;;) {
		try {
			if (statSync(current).isDirectory()) return current;
		} catch {
			// Missing or unreadable: keep walking up.
		}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/** Repository root containing `absPath`, or null when it is outside a
 * repository. */
async function repoRootFor(absPath: string): Promise<string | null> {
	const start = nearestExistingAncestor(absPath);
	if (start === null) return null;
	try {
		const { output } = await execGitCapped(["rev-parse", "--show-toplevel"], start);
		const root = output.trim();
		return root === "" ? null : root;
	} catch {
		return null;
	}
}

/** `absPath` relative to `root` with forward slashes; null when outside.
 * The empty string is the repository root itself. */
function repoRelativePath(root: string, absPath: string): string | null {
	const rel = relative(root, absPath).split(sep).join("/");
	if (rel === ".." || rel.startsWith("../")) return null;
	return rel === "." ? "" : rel;
}

/** Expand a leading `~` — the one non-absolute form accepted from the wire.
 * Markdown links use it and the client has no HOME to expand it with. */
function expandTilde(path: string): string {
	if (path !== "~" && !path.startsWith("~/") && !path.startsWith("~\\")) return path;
	return (process.env.HOME ?? process.env.USERPROFILE ?? "") + path.slice(1);
}

/** Read one path at one repository state (ADR 14). Worktree reads
 * hit the filesystem; head/index/commit reads translate the path to a
 * repository-relative one and read git's tree or index. A path outside a
 * repository has no snapshot view: it is `absent`, not an error. Throws on an
 * invalid state, a relative path, or a spawn/timeout failure. */
export async function readFileAtSnapshot(path: string, state: string): Promise<SnapshotFile> {
	const absPath = expandTilde(path);
	validateAbsolutePath(absPath);
	if (!isAbsolute(absPath)) throw new Error("Invalid path");
	if (state === "worktree") return readWorktreeAt(absPath);
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64}|head|index)$/.test(state)) throw new Error("Invalid snapshot state");
	const root = await repoRootFor(absPath);
	const rel = root === null ? null : repoRelativePath(root, absPath);
	if (root === null || rel === null) return { kind: "absent", state, path: absPath };
	// `<rev>:<path>` resolves from the repository root; `:<path>` reads the index.
	const rev = state === "index" ? `:${rel}` : `${diffStateArg(state)}:${rel}`;
	let output: string;
	let truncated: boolean;
	try {
		// `cat-file blob` (rather than `show`) rejects a tree with a nonzero
		// exit, so asking to read a directory is `absent`, matching the
		// worktree side instead of returning git's tree listing as content.
		({ output, truncated } = await execGitCapped(["cat-file", "blob", rev], root, MAX_READ_FILE_BYTES));
	} catch (err) {
		// A nonzero exit means the path is absent from that tree — unless the
		// state itself does not resolve, which is a real failure (an unreachable
		// recorded commit, an unreadable index).
		const stateResolves =
			state === "index" ? await indexResolves(root, rel) : await treeResolves(diffStateArg(state), root);
		if (stateResolves) return { kind: "absent", state, path: absPath };
		throw err;
	}
	if (output.includes("\u0000")) {
		return { kind: "binary", state, path: absPath, bytes: Buffer.byteLength(output, "utf8") };
	}
	return {
		kind: "file",
		state,
		path: absPath,
		content: output,
		truncated,
		bytes: Buffer.byteLength(output, "utf8"),
	};
}

/** List one absolute directory's immediate children at one repository state
 * (ADR 14). Live listings read the filesystem; head/index/commit listings read
 * git's tree or index. A missing directory — or a snapshot state for a path
 * outside a repository — is `absent`, not an error. `.git` is never listed:
 * it is machine state, not project content. Throws on an invalid state, a
 * relative path, a spawn/timeout failure, or a staged listing over the byte
 * cap. */
export async function listDirectory(path: string, state: string): Promise<DirectoryListing> {
	const absPath = expandTilde(path);
	validateAbsolutePath(absPath);
	if (!isAbsolute(absPath)) throw new Error("Invalid path");
	if (state === "worktree") return listWorktreeDirectory(absPath);
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64}|head|index)$/.test(state)) throw new Error("Invalid snapshot state");
	const root = await repoRootFor(absPath);
	const rel = root === null ? null : repoRelativePath(root, absPath);
	if (root === null || rel === null) return { path: absPath, state, entries: [], omitted: 0, absent: true };
	if (state === "index") return listIndexDirectory(root, absPath, rel);
	return listTreeDirectory(root, absPath, rel, state);
}

/** Sort (directories first, then name), cap, and report the remainder. */
function finishListing(path: string, state: string, entries: DirectoryEntry[]): DirectoryListing {
	entries.sort((a, b) => {
		if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	const omitted = Math.max(0, entries.length - MAX_DIRECTORY_ENTRIES);
	return { path, state, entries: entries.slice(0, MAX_DIRECTORY_ENTRIES), omitted, absent: false };
}

/** The live half of `listDirectory`. A symlink to a directory is a directory. */
function listWorktreeDirectory(abs: string): DirectoryListing {
	let dirents: Dirent[];
	try {
		dirents = readdirSync(abs, { withFileTypes: true });
	} catch {
		return { path: abs, state: "worktree", entries: [], omitted: 0, absent: true };
	}
	const entries: DirectoryEntry[] = [];
	for (const dirent of dirents) {
		if (dirent.name === ".git") continue;
		let isDirectory = dirent.isDirectory();
		if (!isDirectory && dirent.isSymbolicLink()) {
			try {
				isDirectory = statSync(join(abs, dirent.name)).isDirectory();
			} catch {
				// Broken symlink: keep it as a file.
			}
		}
		entries.push({ name: dirent.name, path: join(abs, dirent.name), isDirectory });
	}
	return finishListing(abs, "worktree", entries);
}

/** A commit/head listing: `git ls-tree` is already non-recursive, so it
 * returns exactly the immediate children. */
async function listTreeDirectory(root: string, abs: string, rel: string, state: string): Promise<DirectoryListing> {
	const rev = diffStateArg(state);
	const revPath = rel === "" ? `${rev}:` : `${rev}:${rel}`;
	let output: string;
	try {
		({ output } = await execGitCapped(["ls-tree", "-z", revPath], root, Number.MAX_SAFE_INTEGER));
	} catch (err) {
		// A directory missing from this tree is `absent`; an unresolvable
		// state is an error (a missing git object is not an empty directory).
		if (await treeResolves(rev, root)) return { path: abs, state, entries: [], omitted: 0, absent: true };
		throw err;
	}
	const entries: DirectoryEntry[] = [];
	for (const token of output.split("\0")) {
		if (token === "") continue;
		const tab = token.indexOf("\t");
		if (tab === -1) continue;
		const type = token.slice(0, tab).split(" ")[1];
		const name = token.slice(tab + 1);
		// A tree is a directory; a submodule gitlink ("commit") is one too.
		entries.push({ name, path: join(abs, name), isDirectory: type === "tree" || type === "commit" });
	}
	return finishListing(abs, state, entries);
}

/** An index listing. The index holds no tree objects, so immediate children
 * are derived from the flat staged path list: its sorted order groups a
 * directory's children together, so the first path component after the
 * requested directory names them. */
async function listIndexDirectory(root: string, abs: string, rel: string): Promise<DirectoryListing> {
	const { output, truncated } = await execGitCapped(
		["ls-files", "-z", "--cached", "--stage", "--", rel === "" ? "." : rel],
		root,
		MAX_DIRECTORY_LIST_BYTES,
	);
	if (truncated) throw new Error("Directory listing is too large");
	const prefix = rel === "" ? "" : `${rel}/`;
	const children = new Map<string, boolean>();
	for (const token of output.split("\0")) {
		if (token === "") continue;
		const tab = token.indexOf("\t");
		if (tab === -1) continue;
		const path = token.slice(tab + 1);
		if (!path.startsWith(prefix)) continue;
		const rest = path.slice(prefix.length);
		if (rest === "") continue;
		const slash = rest.indexOf("/");
		const name = slash === -1 ? rest : rest.slice(0, slash);
		children.set(name, slash !== -1 || children.get(name) === true);
	}
	if (children.size === 0) return { path: abs, state: "index", entries: [], omitted: 0, absent: true };
	const entries: DirectoryEntry[] = [...children].map(([name, isDirectory]) => ({
		name,
		path: join(abs, name),
		isDirectory,
	}));
	return finishListing(abs, "index", entries);
}

/** Resolve the comparison base for reviewing one commit (ADR 14): the first
 * parent, or the repository's empty-tree oid for a root commit. The empty
 * tree is an internal diff base — it is not a commit and never a picker
 * value; clients only see it as the `baseline` of a commit review. Throws on
 * an invalid directory/commit, an unreachable commit, or a spawn failure. */
export async function resolveGitBase(directory: string, commit: string): Promise<{ baseline: string }> {
	if (!isAbsolute(directory) || directory.includes("\0")) throw new Error("Invalid directory");
	if (!GIT_COMMIT_RE.test(commit)) throw new Error("Invalid commit");
	// `^{commit}` distinguishes an unreachable commit (exit 1) from an existing
	// one; `^` then fails only for a root commit, whose base is the empty tree.
	const resolved = await execGitCapped(
		["rev-parse", "--verify", "--quiet", `${commit}^{commit}`],
		directory,
		MAX_GIT_SHOW_BYTES,
		[0, 1],
	);
	if (resolved.output.trim() === "") throw new Error("Unreachable commit");
	const parent = await execGitCapped(
		["rev-parse", "--verify", "--quiet", `${commit}^`],
		directory,
		MAX_GIT_SHOW_BYTES,
		[0, 1],
	);
	const parentOid = parent.output.trim();
	if (parentOid !== "") return { baseline: parentOid };
	// Empty stdin (stdio "ignore") makes hash-object emit the empty tree oid
	// for this repository's hash algorithm — sha1 or sha256, never hardcoded.
	const empty = await execGitCapped(["hash-object", "-t", "tree", "--stdin"], directory);
	return { baseline: empty.output.trim() };
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
		} else if (rest.endsWith("/")) {
			// A trailing slash names a directory itself; dirname would strip
			// the empty final component and list the parent instead.
			searchDir = (home + rest).replace(/\/+$/, "");
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
				prefix.endsWith("/") || prefix === "" || prefix === "~"
					? (prefix === "~" ? "~/" : prefix) + entry.name
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

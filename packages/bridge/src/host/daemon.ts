import { Buffer } from "node:buffer";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { basename, extname, join, sep } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	DEFAULT_THINKING_LEVEL,
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
	Document,
	ModelInfo,
	ModelRef,
	PinnedModelInfo,
	ProjectInfo,
	SessionInfo,
	SessionListCursor,
} from "../core/index.ts";
import type { ActivationRecord } from "./activation-registry.ts";
import type { AsrCredentialProvider } from "./asr-credentials.ts";
import { createAsrCredentialProvider } from "./asr-credentials.ts";
import { type AssetSource, createDiskAssetSource, createEmbeddedAssetSource } from "./asset-source.ts";
import { Connection, type DaemonVerbs } from "./connection.ts";
import embeddedAssets from "./embedded-assets.ts";
import { createLocalExecutionLink, type ExecutionLink } from "./execution-link.ts";
import { createLifecycleScope } from "./lifecycle-scope.ts";
import { TrafficLogger } from "./logger.ts";
import { createManager, type Manager } from "./manager.ts";
import { resolveVisibleModelKeys } from "./model-visibility.ts";
import {
	archiveStemFile,
	buildProjects,
	containedSessionFile,
	isArchivedStem,
	normalizeStem,
	type ProjectConfig,
	resolveStemPath,
} from "./projects.ts";
import { listDirectory, listFiles, readFileAtSnapshot, resolveGitBase, runGitDiff, runGitShow } from "./repository.ts";
import { DEFAULT_IDLE_GC_MS, DEFAULT_UNFLUSHED_IDLE_GC_MS } from "./session-actor.ts";
import { readBridgeSettings } from "./settings.ts";
import { createTextPolishProvider, TEXT_POLISH_IDENTITY_ENV, type TextPolishProvider } from "./text-polish.ts";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".png": "image/png",
	".svg": "image/svg+xml",
	".json": "application/json",
	// The install manifest. Chromium rejects a manifest served as
	// `application/octet-stream`, which is the fallthrough, and then silently
	// reports the app as non-installable.
	".webmanifest": "application/manifest+json",
	".map": "application/json",
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_PORT_RANGE = { start: 33334, end: 33340 }; // [33334, 33340)
/** First page size for `sessions_changed` refreshes. */
const SESSION_PAGE_SIZE = 10;
/**
 * Activation GC policy (ADR 11), defaulted from the Session actor's policy
 * constants and passed through the execution link. Not user-configurable;
 * injectable for tests.
 */

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

interface ScanEntry {
	stem: string;
	abs: string;
	sortTimeMs: number;
	active?: ActivationRecord;
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
	/** The execution link: everything that runs a Session (the
	 * Activation registry, Manager creation, per-session choreography) sits
	 * behind this interface, so the Daemon depends on the contract, not on
	 * execution locality. Constructed in start(); null before it, so a failed
	 * startup can still be disposed. */
	private execution: ExecutionLink | null = null;
	private wss: WebSocketServer | null = null;
	private httpServer: HttpServer | null = null;
	private port: number | undefined;
	private webRoot: string | undefined;
	private assetSource!: AssetSource;
	private staticRoots = new Set<string>();
	private logger: TrafficLogger | null = null;
	private devMode = false;
	private agentDir: string = "";
	private managerFactory: NonNullable<DaemonOptions["managerFactory"]> = createManager;
	private modelRuntime!: ModelRuntime;
	private idleGcMs = DEFAULT_IDLE_GC_MS;
	private unflushedIdleGcMs = DEFAULT_UNFLUSHED_IDLE_GC_MS;
	/** Dictation credentials (device registration or SAMI minting). Created with
	 * the Daemon so a provider failure never outlives one request; it reads the
	 * access key from the environment at construction. */
	private asrCredentials: AsrCredentialProvider = createAsrCredentialProvider();
	/** Draft rewriting through the upstream text-polish service. The identity path
	 * is resolved lazily against `agentDir`. */
	private textPolish: TextPolishProvider = createTextPolishProvider({
		identityPath: () => this.textPolishIdentityPath(),
	});

	/** Per-file mtime cache: only re-read session files whose mtime changed. */
	private sessionMetaCache = new Map<string, { mtimeMs: number; meta: FileMeta }>();
	/** Serialized daemon-global settings mutations (see setModelPinned):
	 * `setModelPinned` is a read-modify-write over the global `enabledModels`
	 * scope, so two concurrent pin writes each read the pre-write list and
	 * the later flush silently drops the earlier update. Mutations run one at
	 * a time, in arrival order, across every Connection; the scope's chain
	 * swallows rejections so a failed mutation cannot stall later ones. */
	private settingsMutations = createLifecycleScope();

	async start(options: DaemonOptions = {}): Promise<void> {
		// pi-core is always offline in the bridge: the daemon owns no background
		// network work. pi reads these variables at call time (tool binary
		// downloads, catalog and package refreshes), so writing them before the
		// ModelRuntime and extensions are created covers the whole embedded runtime.
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";

		this.port = options.port;
		this.webRoot = options.webRoot;
		this.agentDir = options.agentDir ?? getAgentDir();
		this.devMode = options.dev ?? false;
		this.idleGcMs = options.idleGcMs ?? DEFAULT_IDLE_GC_MS;
		this.unflushedIdleGcMs = options.unflushedIdleGcMs ?? DEFAULT_UNFLUSHED_IDLE_GC_MS;

		// Injectable embedded assets (test seam); otherwise the bundled web
		// assets serve when no --web-root is given (single-file distribution).
		const embedded =
			options.embeddedAssets ??
			(!options.webRoot && Object.keys(embeddedAssets).length > 0
				? (embeddedAssets as Record<string, string>)
				: null);
		this.assetSource = embedded
			? createEmbeddedAssetSource(embedded)
			: createDiskAssetSource(this.webRoot ?? join(import.meta.dirname, "../../dist/web"));
		// A Project id may not collide with a top-level asset name: the server
		// would serve the asset instead of the Project's page. `assets` is
		// vite's output dir, present in every build.
		this.staticRoots = new Set(["assets", ...this.assetSource.rootNames()]);

		// Projects are static daemon configuration (ADR 11). Invalid ids,
		// duplicate ids, shared session storage, and web-asset collisions fail
		// startup.
		const projects = buildProjects(options.allow ?? [process.cwd()], this.agentDir, this.staticRoots);
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

		// The execution link owns Activation lifetime and the per-session
		// choreography; the daemon keeps only the pushes and the Manager factory
		// seam. Constructed before the server so no socket can arrive first.
		this.execution = createLocalExecutionLink({
			openManager: (project, abs) =>
				this.managerFactory({
					cwd: project.cwd,
					agentDir: this.agentDir,
					modelRuntime: this.modelRuntime,
					sessionPath: abs,
				}),
			createManager: (project) =>
				this.managerFactory({
					cwd: project.cwd,
					agentDir: this.agentDir,
					modelRuntime: this.modelRuntime,
				}),
			idleGcMs: this.idleGcMs,
			unflushedIdleGcMs: this.unflushedIdleGcMs,
			requestedThinkingLevel: (projectId, provider, modelId) =>
				this.requestedThinkingLevel(projectId, provider, modelId),
			onSettled: (ref) => {
				// The first settle after newSession flushes the file — rescan so
				// the session moves to mtime ordering and its metadata appears.
				this.broadcastSessionsChanged(ref.projectId);
				this.broadcastActiveSessions();
			},
			onStreamingChange: () => this.broadcastActiveSessions(),
			onRegistryChange: () => this.broadcastActiveSessions(),
		});

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

	/** Stop serving and drain. Idempotent. The connection set is snapshotted
	 * first: every Connection's transition drain is awaited after the server
	 * stops, so an attachment transition still in flight when the socket
	 * closed settles before the daemon's teardown returns — the runtime
	 * doc's claim is now a fact the teardown enforces. */
	async dispose(): Promise<void> {
		const connections = [...this.connections];
		await this.stopServer();
		// Connection teardown: dispose is idempotent — the socket-close
		// handler already started it for sockets that dropped — and resolves
		// once each Connection's admitted transitions settled (a queued one
		// is refused with "connection closed"; the registry refuses to attach
		// a disposed Connection either way).
		await Promise.allSettled(connections.map((conn) => conn.dispose()));
		if (this.logger) {
			this.logger.dispose();
			this.logger = null;
		}
		if (this.execution) await this.execution.dispose();
		// Refuse further settings mutations and wait out an in-flight flush, so
		// a disposed daemon has no write landing after dispose() returns.
		await this.settingsMutations.close();
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

		for (const activation of this.execution!.live()) {
			if (activation.ref.projectId !== project.id) continue;
			const abs = activation.actor.manager.sessionFile;
			let sortTimeMs = Date.parse(activation.actor.manager.createdAt);
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

	/** Global active/streaming snapshot over the execution link. */
	listActiveSessions(): SessionInfo[] {
		const out: SessionInfo[] = [];
		for (const activation of this.execution!.live()) {
			const project = this.projects.get(activation.ref.projectId);
			if (!project) continue;
			const abs = activation.actor.manager.sessionFile;
			let sortTimeMs = Date.parse(activation.actor.manager.createdAt);
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
		const doc = activation?.actor.manager.document;
		const live = doc ? documentSummary(doc) : undefined;
		return {
			projectId: project.id,
			sessionId: meta?.sessionId ?? activation?.ref.sessionId ?? entry.stem,
			stem: entry.stem,
			active: activation !== undefined,
			isStreaming: activation ? activation.actor.manager.document.status.isStreaming : false,
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

	/** Where the text-polish guest identity lives: the operator's override, else a
	 * file beside the bridge settings. Never inside a Project: it is a daemon
	 * credential (a private key), not repository content. */
	private textPolishIdentityPath(): string {
		const override = process.env[TEXT_POLISH_IDENTITY_ENV];
		if (override !== undefined && override !== "") return override;
		return join(this.agentDir, "bridge", "wxime-identity.json");
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
				// Reserve and attach as one execution operation: a close that lands
				// between them re-reserves instead of pinning a disposed Manager.
				const activation = await this.execution!.open(conn, project, normalized, abs, cursor ?? null);
				return { ok: true, session: activation.ref };
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},

		newSession: async (projectId, conn, text, options) => {
			try {
				const project = this.projects.get(projectId);
				if (!project) return { ok: false, error: `Unknown project: ${projectId}` };
				// The whole Manager-owning phase — creation, registration, the
				// pre-attach choices, and the attach — runs inside the execution
				// link, so a factory that completes after shutdown began is disposed
				// within the operation the link's drain awaits.
				const activation = await this.execution!.create(conn, project, text, options);
				return { ok: true, session: activation.ref };
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},

		detach: (conn) => {
			this.execution!.release(conn);
		},

		closeSession: async (projectId, stem) => {
			try {
				const project = this.projects.get(projectId);
				if (!project) return { ok: false, error: `Unknown project: ${projectId}` };
				const normalized = normalizeStem(stem);
				// Wait out a creation in flight for the address: the Activation it is
				// building is the one this kill must reach, and reporting "not
				// active" while a Manager is still being constructed would leave the
				// address live right after a successful close.
				const activation = await this.execution!.awaitSettled(projectId, normalized);
				if (!activation || activation.collecting !== null) {
					return { ok: false, error: `Session is not active: ${normalized}` };
				}
				await this.execution!.collect(activation);
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
				// Wait out a creation in flight for the address before closing and
				// moving the file: the completing creation would otherwise register a
				// Manager for an address whose file had already been archived.
				const activation = await this.execution!.awaitSettled(projectId, normalized);
				// Close first, unconditionally: disposal finalizes an in-flight turn,
				// which can create or advance the file, so the move must follow it.
				// A dormant session has no activation — the close is then a no-op and
				// only the move remains.
				if (activation) await this.execution!.collect(activation);
				archiveStemFile(project.sessionDir, normalized);
				// The row leaves the history pages. A live session's row already left
				// the active snapshot via the collection broadcast.
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

		// The browser cannot mint a SAMI token or register a device; it gets the
		// result and never the access key. See asr-credentials.ts.
		asrCredentials: () => this.asrCredentials.get(),

		// The browser cannot speak the polish protocol either (AES-ECB, secp128r1
		// ECDH, signed headers); only the draft crosses this socket. See
		// text-polish.ts.
		textPolish: (text: string) => this.textPolish.polish(text),

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

		setModelPinned: (provider: string, modelId: string, pinned: boolean) => {
			// One mutation at a time, in arrival order, across every Connection —
			// see settingsMutations. The scope's chain swallows rejections so a
			// failed mutation cannot stall later ones; the caller still sees the
			// error reply.
			return this.settingsMutations.run(async (): Promise<void> => {
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
			});
		},
	};

	/** The model and thinking level a fresh session in `projectId` resolves
	 * to — the same `findInitialModel` call a fresh Manager's session performs
	 * (scopedModels empty, not continuing, the Project's settings). The level
	 * is the pre-clamp resolution (per-model override for the default model,
	 * else the settings default, else `DEFAULT_THINKING_LEVEL`); the client
	 * clamps it to the displayed model's supported levels, which is what the
	 * session runs at (`createAgentSession` clamps the same way at creation).
	 * A `newSession` model pick resolves its own level through
	 * `requestedThinkingLevel`, so a display for a picked model matches the run
	 * except when the pick has a per-model override of its own — the one known
	 * gap, documented on `ProjectInfo.defaultThinkingLevel`. */
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

	/** The thinking level a fresh session on `provider/modelId` resolves to
	 * before clamping to the model's supported levels: the per-model override,
	 * else the Project's settings default, else `DEFAULT_THINKING_LEVEL` — the
	 * chain `createAgentSession` applies for a session created on that model.
	 * `newSession` uses it for a model pick without an explicit level, so the
	 * level the Project home displayed is the level the session runs at
	 * (`manager.setThinkingLevel` clamps to the picked model). */
	private requestedThinkingLevel(projectId: string, provider: string, modelId: string): string {
		const settings = this.projectSettings.get(projectId);
		return (
			settings?.getModelThinkingLevel(provider, modelId) ??
			settings?.getDefaultThinkingLevel() ??
			DEFAULT_THINKING_LEVEL
		);
	}

	// ── Server ────────────────────────────────────────────────────────────

	/** Serve the shell: the client resolves the address (ADR 11). */
	private serveShell(res: ServerResponse): void {
		const shell = this.assetSource.read("/index.html");
		if (shell.kind !== "file") {
			res.writeHead(404);
			res.end("Not found");
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
		res.end(shell.content);
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

	private async startServer(): Promise<void> {
		this.httpServer = createServer((req, res) => {
			const path = req.url?.split("?")[0] || "/";
			const first = path.split("/")[1] ?? "";

			// Paths under the asset surface are resources: a miss is a 404, and
			// traversal (`..`) under a root is rejected by the source's containment
			// check before any read (ADR 11 security boundary rule). Everything
			// else is a client address — hand back the shell and let the SPA route
			// it (ADR 11).
			if (first === "" || !this.staticRoots.has(first)) {
				this.serveShell(res);
				return;
			}

			const read = this.assetSource.read(path);
			if (read.kind === "forbidden") {
				res.writeHead(403);
				res.end("Forbidden");
				return;
			}
			if (read.kind === "missing") {
				res.writeHead(404);
				res.end("Not found");
				return;
			}

			const headers: Record<string, string> = {
				"Content-Type": MIME_TYPES[extname(path)] ?? "application/octet-stream",
			};
			// Vite content-hashes everything under `assets/`; the shell and the
			// install metadata must revalidate — `index.html` so a redeploy isn't
			// masked by a stale shell, `sw.js` so worker update checks see a new
			// version promptly, and `manifest.webmanifest`/`favicon.svg` so a
			// renamed app or a changed icon actually lands on an installed client.
			// `/icons/*` are unhashed build output: a day of staleness is harmless
			// and saves the refetch, and a real icon change ships under a new name.
			if (path.startsWith("/assets/")) headers["Cache-Control"] = "public, max-age=31536000, immutable";
			else if (path.startsWith("/icons/")) headers["Cache-Control"] = "public, max-age=86400";
			else if (
				path === "/index.html" ||
				path === "/sw.js" ||
				path === "/manifest.webmanifest" ||
				path === "/favicon.svg"
			)
				headers["Cache-Control"] = "no-cache";
			res.writeHead(200, headers);
			res.end(read.content);
		});

		const wss = new WebSocketServer({ server: this.httpServer });
		this.wss = wss;

		wss.on("connection", (ws: WebSocket) => {
			const conn = new Connection(ws, this.daemonVerbs, this.logger, this.devMode);
			this.connections.add(conn);

			ws.on("close", () => {
				this.execution!.release(conn);
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

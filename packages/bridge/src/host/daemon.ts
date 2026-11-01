import { createServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { extname, join } from "node:path";
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
	ModelInfo,
	ModelRef,
	PinnedModelInfo,
	ProjectInfo,
	SessionInfo,
	SessionListCursor,
	SessionRef,
} from "../core/index.ts";
import type { AsrCredentialProvider } from "./asr-credentials.ts";
import { createAsrCredentialProvider } from "./asr-credentials.ts";
import { type AssetSource, createDiskAssetSource, createEmbeddedAssetSource } from "./asset-source.ts";
import { Connection } from "./connection.ts";
import type { DaemonVerbs } from "./connection-verbs.ts";
import embeddedAssets from "./embedded-assets.ts";
import { createLifecycleScope } from "./lifecycle-scope.ts";
import { TrafficLogger } from "./logger.ts";
import { createManager, type Manager } from "./manager.ts";
import { resolveVisibleModelKeys } from "./model-visibility.ts";
import { buildProjects, type ProjectConfig } from "./projects.ts";
import { listDirectory, listFiles, readFileAtSnapshot, resolveGitBase, runGitDiff, runGitShow } from "./repository.ts";
import { DEFAULT_IDLE_GC_MS, DEFAULT_UNFLUSHED_IDLE_GC_MS } from "./session-actor.ts";
import { bindWorkerCommands } from "./session-commands.ts";
import { readBridgeSettings } from "./settings.ts";
import { createTextPolishProvider, TEXT_POLISH_IDENTITY_ENV, type TextPolishProvider } from "./text-polish.ts";
import type { ObservedSession, SessionTarget, WorkerEvent, WorkerObservationSink } from "./worker-contract.ts";
import { createLocalWorker, type LocalWorker } from "./worker-local.ts";

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

export class Daemon {
	private projects = new Map<string, ProjectConfig>();
	/** Per-project settings (pi resolves defaults from the Project cwd's
	 * settings.json — the default model can differ per Project). */
	private projectSettings = new Map<string, SettingsManager>();
	/** Daemon-wide global settings (cwd-independent): the `enabledModels` scope
	 * reported by `getDaemonInfo` for the Project home's Pinned group. */
	private globalSettings: SettingsManager | null = null;
	private connections = new Set<Connection>();
	/** The Worker this Daemon routes execution to: Projects, Session storage,
	 * the Activation registry, and pi runtimes. Constructed in start(); null
	 * before it, so a failed startup can still be disposed. The Daemon reaches
	 * it only through the Worker service contract, so the process boundary is
	 * a deployment choice rather than an architecture change. */
	private worker: LocalWorker | null = null;
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

		if (options.logPath) {
			this.logger = TrafficLogger.open(options.logPath);
		}

		// Injectable deps (test seam)
		this.modelRuntime =
			options.modelRuntime ?? (await ModelRuntime.create({ authPath: join(this.agentDir, "auth.json") }));
		this.managerFactory = options.managerFactory ?? createManager;

		// The Worker owns the Projects, Session storage, Activation lifetime, and
		// pi runtimes; the Daemon keeps the asset surface, the Connections, and
		// delivery. Constructed before the server so no socket can arrive first.
		// Its constructor validates the Project set (duplicate ids, shared
		// storage, duplicated durable session ids) and fails startup.
		const worker = createLocalWorker({
			projects,
			agentDir: this.agentDir,
			modelRuntime: this.modelRuntime,
			managerFactory: this.managerFactory,
			idleGcMs: this.idleGcMs,
			unflushedIdleGcMs: this.unflushedIdleGcMs,
			requestedThinkingLevel: (projectId, provider, modelId) =>
				this.requestedThinkingLevel(projectId, provider, modelId),
		});
		worker.onEvent((event) => this.onWorkerEvent(event));
		this.worker = worker;

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
		if (this.worker) await this.worker.dispose();
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

	/** A Worker-reported state change, broadcast to every browser. The Worker
	 * computes the payload (the page, the active snapshot) because it owns the
	 * Documents those rows describe; the Daemon only addresses the frames. */
	private onWorkerEvent(event: WorkerEvent): void {
		if (event.kind === "sessions_changed") {
			this.pushSessionsChanged(event.projectId, event.page.sessions, event.page.hasMore, event.page.nextCursor);
			return;
		}
		if (event.kind === "active_sessions_changed") {
			this.broadcastActiveSessions(event.sessions);
			return;
		}
		// A terminal Worker: the Daemon can serve no Session for it. Until the
		// remote link exists there is nothing to withdraw — surface the reason.
		console.error(`Daemon: worker unavailable: ${event.reason}`);
	}

	/** The global active/streaming snapshot: the Worker owns the Documents
	 * those rows describe, so it computes the rows. */
	listActiveSessions(): Promise<SessionInfo[]> {
		return this.worker!.listActiveSessions();
	}

	// ── Broadcasts ────────────────────────────────────────────────────────

	/** Push one Project's refreshed first page to every browser. */
	private pushSessionsChanged(
		projectId: string,
		sessions: SessionInfo[],
		hasMore: boolean,
		nextCursor?: SessionListCursor,
	): void {
		const frame: Record<string, unknown> = { kind: "sessions_changed", projectId, sessions, hasMore };
		if (nextCursor) frame.nextCursor = nextCursor;
		for (const conn of this.connections) conn.push(frame);
	}

	/** Refresh and push one Project's first page (a close or an archive changed
	 * its ordering; a rename rewrites its row). */
	private broadcastSessionsChanged(projectId: string): void {
		void this.worker
			?.listSessions(projectId, SESSION_PAGE_SIZE)
			.then((page) => this.pushSessionsChanged(projectId, page.sessions, page.hasMore, page.nextCursor))
			.catch(() => {
				// A failed refresh is recoverable: the client still holds a
				// previous page and will re-query on the next navigation.
			});
	}

	private broadcastActiveSessions(sessions: SessionInfo[]): void {
		const frame: Record<string, unknown> = { kind: "active_sessions_changed", sessions };
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

	/** Attach `conn` to one Worker observation: the Connection mints the
	 * attachment generation and supplies the frame sink before the observation
	 * exists, so the initial sync it emits during acquisition already belongs to
	 * the new attachment. The returned target is what its session verbs address. */
	private async attach(
		conn: Connection,
		open: (sink: WorkerObservationSink) => Promise<ObservedSession>,
	): Promise<SessionTarget> {
		return conn.attach(async (sink) => {
			const observed = await open(sink);
			// The commands name the target this observation serves: a later
			// transition cannot retarget them, and the Worker refuses a target
			// whose Activation ended instead of reaching its successor.
			return {
				target: observed.target,
				observation: observed.observation,
				commands: bindWorkerCommands(this.worker!, observed.target, observed.observation),
			};
		});
	}

	private daemonVerbs: DaemonVerbs = {
		listSessions: (projectId, max, cursor) => this.worker!.listSessions(projectId, max, cursor ?? null),

		listActiveSessions: () => this.worker!.listActiveSessions(),

		openSession: async (projectId, stem, conn, cursor) => {
			try {
				if (!this.projects.has(projectId)) return { ok: false, error: `Unknown project: ${projectId}` };
				const target = await this.attach(conn, (sink) =>
					this.worker!.observeSession({ projectId, stem }, { cursor: cursor ?? null, sink }),
				);
				return { ok: true, session: sessionRefOf(target) };
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},

		newSession: async (projectId, conn, text, options) => {
			try {
				if (!this.projects.has(projectId)) return { ok: false, error: `Unknown project: ${projectId}` };
				const target = await this.attach(conn, (sink) =>
					this.worker!.createSession(projectId, { text, ...options, sink }),
				);
				return { ok: true, session: sessionRefOf(target) };
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},

		detach: (conn) => {
			conn.detach();
		},

		closeSession: async (projectId, stem) => {
			try {
				if (!this.projects.has(projectId)) return { ok: false, error: `Unknown project: ${projectId}` };
				await this.worker!.closeSession({ projectId, stem });
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
				if (!this.projects.has(projectId)) return { ok: false, error: `Unknown project: ${projectId}` };
				await this.worker!.archiveSession({ projectId, stem });
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
				// Disposing the Connection releases its observation, which is what
				// ends its attachment (and lets the Activation idle out).
				void conn.dispose();
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

/** The wire identity of an addressed Session: the address plus the durable id
 * the Worker resolved. */
function sessionRefOf(target: SessionTarget): SessionRef {
	return { projectId: target.projectId, stem: target.stem, sessionId: target.sessionId };
}

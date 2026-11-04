import { createServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { extname, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type WebSocket, WebSocketServer } from "ws";
import type { SessionInfo, SessionListCursor, SessionRef } from "../core/index.ts";
import type { AsrCredentialProvider } from "./asr-credentials.ts";
import { createAsrCredentialProvider } from "./asr-credentials.ts";
import { type AssetSource, createDiskAssetSource, createEmbeddedAssetSource } from "./asset-source.ts";
import { Connection } from "./connection.ts";
import type { DaemonVerbs } from "./connection-verbs.ts";
import { type DaemonSocket, startDaemonSocket } from "./daemon-socket.ts";
import embeddedAssets from "./embedded-assets.ts";
import { TrafficLogger } from "./logger.ts";
import type { createManager, Manager } from "./manager.ts";
import { setDaemonTitle } from "./process-title.ts";
import { buildProjects } from "./projects.ts";
import { bindWorkerCommands } from "./session-commands.ts";
import { createTextPolishProvider, TEXT_POLISH_IDENTITY_ENV, type TextPolishProvider } from "./text-polish.ts";
import type { WorkerHello } from "./worker-client.ts";
import type {
	ObservedSession,
	SessionTarget,
	WorkerEvent,
	WorkerInfo,
	WorkerObservationSink,
} from "./worker-contract.ts";
import { adoptWorkerHost, createWorkerHost, type WorkerHost, type WorkerHostMode } from "./worker-host.ts";
import { WORKER_REJECTED_CLOSE_CODE } from "./worker-protocol.ts";

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
	 * `[process.cwd()]`. Used by the in-process and spawn Worker modes; a
	 * connected Worker brings its own Project set. */
	allow?: string[];
	/** How the Daemon obtains its Workers. Default: one in-process Worker over
	 * `allow`. Several registrations may serve different Projects; the accepted
	 * set becomes the routing table. */
	workerModes?: WorkerHostMode[];
	/** Bind this UNIX socket and accept Worker registrations on it. This is the
	 * discovery address a local Worker dials, so `pi-bridge` in another terminal
	 * can join a running Daemon with no port or URL. Omitted: no dial-in
	 * registrations, which is what a test or an embedder that supplies
	 * `workerModes` wants. */
	registrationSocketPath?: string;
	/** Injectable Manager factory (in-process Worker only). Test seam. */
	managerFactory?: (opts: Parameters<typeof createManager>[0]) => Promise<Manager>;
	/** Injectable embedded web assets (default: the bundle-time module).
	 * Test seam for the embedded (single-file) serving path. */
	embeddedAssets?: Record<string, string>;
	/** Shared model runtime (in-process Worker only; tests). */
	modelRuntime?: ModelRuntime;
	/** Idle GC delays in ms (ADR 11). Test seam. */
	idleGcMs?: number;
	unflushedIdleGcMs?: number;
}

export class Daemon {
	private connections = new Set<Connection>();
	/** Every accepted Worker registration. The Daemon holds no Project
	 * configuration of its own: the routing table below is the join of what the
	 * Workers advertised and this Daemon accepted. */
	private workers: WorkerHost[] = [];
	/** The routing table: a Project id is served by exactly one Worker. Claiming
	 * is atomic across registrations, so `/<projectId>` is never ambiguous. */
	private routes = new Map<string, WorkerHost>();
	/** Each Worker's last reported active/streaming snapshot. The browser store
	 * replaces its list on every push, so a push carries the aggregate rather
	 * than one Worker's slice. */
	private activeByHost = new Map<WorkerHost, SessionInfo[]>();
	private wss: WebSocketServer | null = null;
	private httpServer: HttpServer | null = null;
	/** The dial-in registration listener, when one was requested. */
	private registrationSocket: DaemonSocket | null = null;
	private port: number | undefined;
	private webRoot: string | undefined;
	private assetSource!: AssetSource;
	private staticRoots = new Set<string>();
	private logger: TrafficLogger | null = null;
	private devMode = false;
	private agentDir: string = "";
	/** Dictation credentials (device registration or SAMI minting). Created with
	 * the Daemon so a provider failure never outlives one request; it reads the
	 * access key from the environment at construction. Daemon-global, not
	 * Project state: the browser cannot mint or register. */
	private asrCredentials: AsrCredentialProvider = createAsrCredentialProvider();
	/** Draft rewriting through the upstream text-polish service. The identity path
	 * is resolved lazily against `agentDir`. Daemon-global for the same reason:
	 * the browser cannot speak the upstream protocol. */
	private textPolish: TextPolishProvider = createTextPolishProvider({
		identityPath: () => this.textPolishIdentityPath(),
	});
	/** True once `dispose` began: the Worker link closing during a clean
	 * shutdown is expected, not a withdrawal. */
	private disposing = false;

	/** The Worker serving one Project, or undefined when the registration does
	 * not cover it. */
	private route(projectId: string): WorkerHost | undefined {
		return this.routes.get(projectId);
	}

	/** The Worker serving one Project; throws for an unroutable address. */
	private requirement(projectId: string): WorkerHost {
		const host = this.route(projectId);
		if (host === undefined) throw new Error(`Unknown project: ${projectId}`);
		return host;
	}

	/** Every registered Worker, or an empty list once drained. */
	private get services(): WorkerHost[] {
		return this.workers;
	}

	/** Publish this Daemon's half of the process title: how many Worker
	 * registrations it routes. The Worker half, when this process hosts one,
	 * arrives from the same title owner and the two compose into
	 * `daemon+worker`. */
	private publishTitle(): void {
		setDaemonTitle({ workers: this.workers.length });
	}

	async start(options: DaemonOptions = {}): Promise<void> {
		// The Worker establishes pi-core's offline mode (it is the half that
		// creates runtimes and extensions), so a standalone Worker process is
		// covered by the same rule as an embedded one.

		this.port = options.port;
		this.webRoot = options.webRoot;
		this.agentDir = options.agentDir ?? getAgentDir();
		this.devMode = options.dev ?? false;

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

		if (options.logPath) {
			this.logger = TrafficLogger.open(options.logPath);
		}

		// The Worker modes decide who owns Project configuration and Session
		// storage. In-process and spawn build their set from `--allow`; a connected
		// Worker advertises its own, and each handshake is validated before any
		// route exists.
		const allow = options.allow ?? [process.cwd()];
		const modes: WorkerHostMode[] = options.workerModes ?? [
			{ kind: "in-process", projects: buildProjects(allow, this.agentDir, this.staticRoots) },
		];

		// The Worker owns Projects, Session storage, the Activation lifetime, pi
		// runtimes, the model catalogue, settings, and the repository surface. The
		// Daemon keeps the asset surface, the Connections, delivery, and the two
		// daemon-global credential services (ASR, text polish).
		await this.startWorkers(modes, options);

		// The dial-in listener is bound before the web listener: a Worker that
		// joins this process should be routable before a browser is told the
		// Daemon exists.
		if (options.registrationSocketPath !== undefined) {
			this.registrationSocket = await startDaemonSocket({
				socketPath: options.registrationSocketPath,
				onWorker: (ws, hello) => this.acceptWorkerSocket(ws, hello),
				webAddress: () => this.webUrl,
			});
		}

		await this.startServer();
	}

	/**
	 * Create every registration, claiming its Project names atomically. A
	 * registration is accepted only if every Project it advertises is free:
	 * partial acceptance would make `/<projectId>` ambiguous, so a conflict fails
	 * the whole start and every Worker created so far is disposed.
	 */
	private async startWorkers(modes: WorkerHostMode[], options: DaemonOptions): Promise<void> {
		const created: WorkerHost[] = [];
		try {
			for (const mode of modes) {
				// The callbacks need the host they belong to, but the host only
				// exists after creation; events that arrive before this assignment
				// are dropped rather than attributed to the wrong registration.
				const holder: { host: WorkerHost | null } = { host: null };
				const host = await createWorkerHost({
					mode,
					agentDir: this.agentDir,
					reservedProjectIds: this.staticRoots,
					...(options.modelRuntime !== undefined ? { modelRuntime: options.modelRuntime } : {}),
					...(options.managerFactory !== undefined ? { managerFactory: options.managerFactory } : {}),
					...(options.idleGcMs !== undefined ? { idleGcMs: options.idleGcMs } : {}),
					...(options.unflushedIdleGcMs !== undefined ? { unflushedIdleGcMs: options.unflushedIdleGcMs } : {}),
					onEvent: (event) => {
						if (holder.host !== null) this.onWorkerEvent(holder.host, event);
					},
					onUnavailable: (reason) => {
						if (holder.host !== null) void this.onWorkerUnavailable(holder.host, reason);
					},
				});
				holder.host = host;
				// The host joins the cleanup set before its Projects are validated:
				// the registration whose claim fails must be disposed with the rest,
				// or a spawned Worker leaks past the failed startup — alive, holding
				// its socket and its session-directory claims.
				created.push(host);

				for (const project of host.info.projects) {
					const owner = this.routes.get(project.id);
					if (owner !== undefined) {
						throw new Error(`Project id "${project.id}" is already served by another Worker registration`);
					}
				}
				for (const project of host.info.projects) this.routes.set(project.id, host);
			}
		} catch (error) {
			for (const host of created.reverse()) await host.dispose().catch(() => {});
			this.routes.clear();
			throw error;
		}
		this.workers = created;
		this.activeByHost = new Map(created.map((host) => [host, []]));
		this.publishTitle();
	}

	/**
	 * One Worker dialed in. Adoption validates and wires the link; the Project
	 * claim is then the same all-or-nothing rule a hosted registration uses, so
	 * `/<projectId>` stays unambiguous however the Worker arrived. A refused
	 * registration closes with the rejected code, so the Worker that dialed in
	 * stops instead of reconnecting against a decision that cannot change.
	 */
	private acceptWorkerSocket(ws: WebSocket, hello: WorkerHello): void {
		void this.adoptWorker(ws, hello).catch((error: unknown) => {
			// An adoption that failed outside the refusal paths is a bug, not a
			// decision the Worker could outwait: end the link with the rejected
			// code so the Worker stops and the failure is visible instead of
			// retried into forever.
			this.refuseWorkerSocket(ws, error instanceof Error ? error.message : String(error));
		});
	}

	/**
	 * Close a registration this Daemon will not route. The close code is the
	 * Worker's instruction: the rejected code is terminal (the same handshake
	 * cannot succeed on a retry, so the Worker stops), while a refusal during
	 * shutdown closes gracefully — the Worker should retry the next Daemon, not
	 * die because this one is stopping. The code must be sent while the socket
	 * is still open: after a disposal it can no longer be delivered, and the
	 * Worker would mistake the refusal for a lost link and reconnect forever.
	 */
	private refuseWorkerSocket(ws: WebSocket, reason: string): void {
		console.error(`Daemon: refused a Worker registration: ${reason}`);
		try {
			ws.close(this.disposing ? 1000 : WORKER_REJECTED_CLOSE_CODE, reason);
		} catch {
			// Already gone; the registration was never routed.
		}
	}

	private async adoptWorker(ws: WebSocket, hello: WorkerHello): Promise<void> {
		if (this.disposing) {
			this.refuseWorkerSocket(ws, "daemon is shutting down");
			return;
		}
		// The callbacks need the host they belong to, but the host only exists
		// after adoption; events arriving before this assignment are dropped
		// rather than attributed to the wrong registration.
		const holder: { host: WorkerHost | null } = { host: null };
		const host = await adoptWorkerHost({
			ws,
			hello,
			reservedProjectIds: this.staticRoots,
			onEvent: (event) => {
				if (holder.host !== null) this.onWorkerEvent(holder.host, event);
			},
			onUnavailable: (reason) => {
				if (holder.host !== null) void this.onWorkerUnavailable(holder.host, reason);
			},
		});
		holder.host = host;

		// Shutdown may have begun while the link was being adopted: completing the
		// registration would install routes into a draining Daemon that nothing
		// disposes. Refused — gracefully, so the Worker retries the next Daemon.
		let refusal: string | null = this.disposing ? "daemon is shutting down" : null;
		for (const project of host.info.projects) {
			if (refusal !== null) break;
			if (this.routes.has(project.id)) {
				refusal = `Project id "${project.id}" is already served by another Worker registration`;
			}
		}
		if (refusal !== null) {
			// Refuse before disposing: the close code must leave while the socket is
			// open, and the host's `dispose` (closeLink) lets the in-flight close
			// handshake finish instead of aborting it. Nothing was routed, so there
			// is nothing to withdraw — dropping the link is the whole refusal.
			this.refuseWorkerSocket(ws, refusal);
			holder.host = null;
			await host.dispose().catch(() => {});
			return;
		}

		for (const project of host.info.projects) this.routes.set(project.id, host);
		this.workers = [...this.workers, host];
		this.activeByHost.set(host, []);
		this.publishTitle();
		// A newly registered Worker changes the aggregate; the browser's Project
		// list itself is refreshed on its next `getDaemonInfo` (reconnect or
		// reload), because the surface has no project-list push.
		this.broadcastActiveSessions();
	}

	/**
	 * The Worker to ask for an absolutely addressed read. Repository queries name
	 * an absolute path, not a Project, so the owner is the registration whose
	 * Project cwd contains it (longest match wins); a path outside every Project
	 * falls back to the first registration, which keeps `readFile` on an
	 * unrelated directory working when one Worker is registered.
	 */
	private forPath(path: string): WorkerHost {
		let best: WorkerHost | undefined;
		let bestLength = -1;
		for (const host of this.workers) {
			for (const project of host.info.projects) {
				const cwd = project.cwd;
				const contained = path === cwd || path.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`);
				if (contained && cwd.length > bestLength) {
					best = host;
					bestLength = cwd.length;
				}
			}
		}
		const fallback = best ?? this.workers[0];
		if (fallback === undefined) throw new Error("no worker is registered");
		return fallback;
	}

	/** One report over every registration: the picker and Project list describe a
	 * Daemon, not a Worker, so the rows are merged and deduped by identity. */
	private async aggregateInfo(): Promise<WorkerInfo> {
		const infos = await Promise.all(this.workers.map((host) => host.service.info()));
		const models = new Map<string, WorkerInfo["models"][number]>();
		const pinned = new Map<string, WorkerInfo["pinnedModels"][number]>();
		const thinkingLevels = new Set<string>();
		for (const info of infos) {
			for (const model of info.models) models.set(`${model.provider}/${model.id}`, model);
			for (const entry of info.pinnedModels) pinned.set(`${entry.provider}/${entry.id}`, entry);
			for (const level of info.thinkingLevels) thinkingLevels.add(level);
		}
		return {
			projects: infos.flatMap((info) => info.projects),
			models: [...models.values()],
			pinnedModels: [...pinned.values()],
			visibleModels: [...new Set(infos.flatMap((info) => info.visibleModels))],
			thinkingLevels: [...thinkingLevels],
		};
	}

	/** Returns the address the server is listening on, or null if not started. */
	get address(): { port: number; host: string } | null {
		if (!this.httpServer) return null;
		const addr = this.httpServer.address() as AddressInfo;
		return { port: addr.port, host: addr.address };
	}

	/** The browser base URL to show a human, or null before the listener binds.
	 * The listener serves pages and Worker protocol upgrades on one port, so this
	 * is also the address of the WebSocket surface. */
	get webUrl(): string | null {
		const addr = this.address;
		return addr === null ? null : `http://localhost:${addr.port}`;
	}

	/** The Worker registrations this Daemon accepted (diagnostics). */
	get registrations(): Array<{ id: string; incarnation: string; generation: number }> {
		return this.workers.map((host) => host.service.registration);
	}

	/** Every Project id this Daemon routes to a registration (diagnostics). */
	get projectIds(): string[] {
		return [...this.routes.keys()];
	}

	/** Stop serving and drain. Idempotent. The connection set is snapshotted
	 * first: every Connection's transition drain is awaited after the server
	 * stops, so an attachment transition still in flight when the socket
	 * closed settles before the daemon's teardown returns. */
	async dispose(): Promise<void> {
		this.disposing = true;
		// Stop accepting registrations first: a Worker that joined during teardown
		// would be routed to a Daemon that is already draining. Closing the
		// listener drops the links without asking those Workers to stop — their
		// runtimes belong to their own processes.
		await this.registrationSocket?.close().catch(() => {});
		this.registrationSocket = null;
		const connections = [...this.connections];
		await this.stopServer();
		await Promise.allSettled(connections.map((conn) => conn.dispose()));
		if (this.logger) {
			this.logger.dispose();
			this.logger = null;
		}
		const workers = this.workers;
		this.workers = [];
		this.routes.clear();
		this.activeByHost.clear();
		setDaemonTitle(null);
		await Promise.allSettled(workers.map((host) => host.dispose()));
	}

	/** A Worker-reported state change, broadcast to every browser. The Worker
	 * computes the payload (the page, the active snapshot, the pinned list)
	 * because it owns the state those rows describe; the Daemon only addresses
	 * the frames. */
	private onWorkerEvent(host: WorkerHost, event: WorkerEvent): void {
		if (event.kind === "sessions_changed") {
			this.pushSessionsChanged(event.projectId, event.page.sessions, event.page.hasMore, event.page.nextCursor);
			return;
		}
		if (event.kind === "active_sessions_changed") {
			this.activeByHost.set(host, event.sessions);
			this.broadcastActiveSessions();
			return;
		}
		if (event.kind === "pinned_models_changed") {
			// The pinned scope is Worker-owned; the picker shows the union of what
			// the registered Workers report, deduped by identity.
			this.pushToAll({ kind: "pinned_models_changed", pinnedModels: event.pinnedModels });
		}
	}

	/** The Worker can serve nothing more: withdraw its routes so no browser sees
	 * Projects that would answer every operation with a refusal. The Worker
	 * process keeps its runtimes; a reconnect is a new registration. */
	private async onWorkerUnavailable(host: WorkerHost, reason: string): Promise<void> {
		// A link that closes because this Daemon is stopping is not a failure.
		if (this.disposing) return;
		if (!this.workers.includes(host)) return;
		// Withdraw exactly this registration's Projects: the other Workers keep
		// serving, so a failure is scoped to the execution that failed.
		for (const [projectId, routed] of [...this.routes]) {
			if (routed === host) this.routes.delete(projectId);
		}
		this.workers = this.workers.filter((worker) => worker !== host);
		this.activeByHost.delete(host);
		this.publishTitle();
		this.broadcastActiveSessions();
		console.error(`Daemon: worker unavailable, routes withdrawn: ${reason}`);
		await host.dispose().catch(() => {});
	}

	/** The global active/streaming snapshot: the Workers own the Documents those
	 * rows describe, so each reports its own slice and the Daemon concatenates. */
	async listActiveSessions(): Promise<SessionInfo[]> {
		if (this.workers.length === 0) return [];
		const slices = await Promise.all(this.workers.map((host) => host.service.listActiveSessions()));
		return slices.flat();
	}

	// ── Broadcasts ────────────────────────────────────────────────────────

	private pushToAll(frame: Record<string, unknown>): void {
		for (const conn of this.connections) conn.push(frame);
	}

	/** Push one Project's refreshed first page to every browser. */
	private pushSessionsChanged(
		projectId: string,
		sessions: SessionInfo[],
		hasMore: boolean,
		nextCursor?: SessionListCursor,
	): void {
		const frame: Record<string, unknown> = { kind: "sessions_changed", projectId, sessions, hasMore };
		if (nextCursor) frame.nextCursor = nextCursor;
		this.pushToAll(frame);
	}

	/** Refresh and push one Project's first page (a close or an archive changed
	 * its ordering; a rename rewrites its row). */
	private broadcastSessionsChanged(projectId: string): void {
		const host = this.route(projectId);
		if (host === undefined) return;
		void host.service
			.listSessions(projectId, SESSION_PAGE_SIZE)
			.then((page) => this.pushSessionsChanged(projectId, page.sessions, page.hasMore, page.nextCursor))
			.catch(() => {
				// A failed refresh is recoverable: the client still holds a
				// previous page and will re-query on the next navigation.
			});
	}

	/** Push the aggregate of every Worker's last reported snapshot. A per-Worker
	 * push would replace the browser's list with one slice. */
	private broadcastActiveSessions(): void {
		const sessions = this.workers.flatMap((host) => this.activeByHost.get(host) ?? []);
		this.pushToAll({ kind: "active_sessions_changed", sessions });
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
		host: WorkerHost,
		conn: Connection,
		open: (sink: WorkerObservationSink) => Promise<ObservedSession>,
	): Promise<SessionTarget> {
		return conn.attach(async (sink) => {
			const observed = await open(sink);
			// The commands name the target this observation serves: a later
			// transition cannot retarget them, and the Worker refuses a target
			// whose Activation ended instead of reaching its successor. They are
			// bound to the Worker that served the observation, so a command can
			// never be sent to a different registration that happens to serve the
			// same address.
			return {
				target: observed.target,
				observation: observed.observation,
				commands: bindWorkerCommands(host.service, observed.target, observed.observation),
			};
		});
	}

	private daemonVerbs: DaemonVerbs = {
		listSessions: (projectId, max, cursor) =>
			this.requirement(projectId).service.listSessions(projectId, max, cursor ?? null),

		listActiveSessions: () => this.listActiveSessions(),

		openSession: async (projectId, stem, conn, cursor) => {
			try {
				const host = this.route(projectId);
				if (host === undefined) return { ok: false, error: `Unknown project: ${projectId}` };
				const target = await this.attach(host, conn, (sink) =>
					host.service.observeSession({ projectId, stem }, { cursor: cursor ?? null, sink }),
				);
				return { ok: true, session: sessionRefOf(target) };
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},

		newSession: async (projectId, conn, text, options) => {
			try {
				const host = this.route(projectId);
				if (host === undefined) return { ok: false, error: `Unknown project: ${projectId}` };
				const target = await this.attach(host, conn, (sink) =>
					host.service.createSession(projectId, { text, ...options, sink }),
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
				const host = this.route(projectId);
				if (host === undefined) return { ok: false, error: `Unknown project: ${projectId}` };
				await host.service.closeSession({ projectId, stem });
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
				const host = this.route(projectId);
				if (host === undefined) return { ok: false, error: `Unknown project: ${projectId}` };
				await host.service.archiveSession({ projectId, stem });
				// The row leaves the history pages. A live session's row already left
				// the active snapshot via the collection broadcast.
				this.broadcastSessionsChanged(projectId);
				return { ok: true };
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},

		sessionsChanged: (projectId) => this.broadcastSessionsChanged(projectId),

		// The browser cannot mint a SAMI token or register a device; it gets the
		// result and never the access key. See asr-credentials.ts.
		asrCredentials: () => this.asrCredentials.get(),

		// The browser cannot speak the polish protocol either (AES-ECB, secp128r1
		// ECDH, signed headers); only the draft crosses this socket. See
		// text-polish.ts.
		textPolish: (text: string) => this.textPolish.polish(text),

		// Everything below is Worker-owned: Project files, Git, the model
		// catalogue, and the global settings scope. The Daemon forwards the request
		// and the reply unchanged, because a remote Worker's filesystem is not
		// reachable from here.
		listFiles: (prefix, projectId) => this.requirement(projectId).service.listFiles(prefix, projectId),
		readFile: (path, state) => this.forPath(path).service.readFile(path, state),
		listDirectory: (path, state) => this.forPath(path).service.listDirectory(path, state),
		gitShow: (commit, cwd) => this.forPath(cwd ?? process.cwd()).service.gitShow(commit, cwd ?? process.cwd()),
		gitBase: (directory, commit) => this.forPath(directory).service.gitBase(directory, commit),
		gitDiff: (directory, oldState, newState) =>
			this.forPath(directory).service.gitDiff(directory, oldState, newState),

		getDaemonInfo: async () => ({ ...(await this.aggregateInfo()), devMode: this.devMode }),

		setPinnedModels: (models) => {
			// The pinned scope is Worker-global; with several registrations the
			// last writer would otherwise silently drop the others' view, so the
			// replacement is broadcast to every registered Worker.
			return Promise.all(this.services.map((host) => host.service.setPinnedModels(models))).then(() => undefined);
		},
	};

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

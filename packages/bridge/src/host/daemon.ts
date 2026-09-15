import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	getAgentDir,
	getDefaultSessionDir,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type WebSocket, WebSocketServer } from "ws";
import type { Content, Document, InstanceInfo, ModelInfo, PrefixCursor, SessionInfo } from "../core/index.ts";
import { Connection, type DaemonVerbs } from "./connection.ts";
import embeddedAssets from "./embedded-assets.ts";
import { TrafficLogger } from "./logger.ts";
import { createManager, type Manager } from "./manager.ts";

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

export interface DaemonOptions {
	agentDir?: string;
	port?: number;
	webRoot?: string;
	logPath?: string;
	dev?: boolean;
	/** Allowed cwds. Defaults to [process.cwd()] when empty. */
	cwdAllowlist?: string[];
	/** Injectable Manager factory (default: createManager). Test seam. */
	managerFactory?: (opts: Parameters<typeof createManager>[0]) => Promise<Manager>;
	/** Shared model runtime (for tests). */
	modelRuntime?: ModelRuntime;
}

export class Daemon {
	private instances = new Map<string, Manager>();
	private connections = new Set<Connection>();
	private wss: WebSocketServer | null = null;
	private httpServer: HttpServer | null = null;
	private port: number | undefined;
	private webRoot: string | undefined;
	private embeddedAssets: Record<string, string> | null = null;
	private logger: TrafficLogger | null = null;
	private devMode = false;
	private cwd: string = process.cwd();
	private agentDir: string = "";
	private cwdAllowlist: string[] = [];
	private managerFactory: NonNullable<DaemonOptions["managerFactory"]> = createManager;
	private modelRuntime!: ModelRuntime;

	/** Per-file mtime cache: only re-read session files whose mtime changed. */
	private sessionCache = new Map<string, { mtimeMs: number; info: SessionInfo }>();

	async start(options: DaemonOptions = {}): Promise<void> {
		this.port = options.port;
		this.webRoot = options.webRoot;
		this.agentDir = options.agentDir ?? getAgentDir();
		this.devMode = options.dev ?? false;

		// Allowlist defaults to [process.cwd()] when no --allow flags given.
		this.cwdAllowlist = options.cwdAllowlist ?? [process.cwd()];

		if (options.logPath) {
			this.logger = TrafficLogger.open(options.logPath);
		}

		// Use embedded web assets when no --web-root is given
		if (!this.webRoot) {
			if (Object.keys(embeddedAssets).length > 0) {
				this.embeddedAssets = embeddedAssets as Record<string, string>;
			}
		}

		// Injectable deps (test seam)
		this.modelRuntime =
			options.modelRuntime ?? (await ModelRuntime.create({ authPath: join(this.agentDir, "auth.json") }));
		this.managerFactory = options.managerFactory ?? createManager;

		// Load extensions onto the daemon's modelRuntime so they are visible
		// in getDaemonInfo before any instance is created.
		await this.loadExtensions();

		// No auto-created instances — created on demand via newInstance RPC.

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
		for (const mgr of this.instances.values()) {
			await mgr.dispose();
		}
		this.instances.clear();
	}

	/**
	 * Load disk extensions (agentDir, cwd, settings) onto the daemon's shared
	 * modelRuntime so extension-registered providers are visible in
	 * getDaemonInfo before any instance exists. Mirrors the extension wiring in
	 * createAgentSessionServices; manager creation re-registers idempotently.
	 */
	private async loadExtensions(): Promise<void> {
		try {
			const settingsManager = SettingsManager.create(this.cwd, this.agentDir);
			const resourceLoader = new DefaultResourceLoader({
				cwd: this.cwd,
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

	// ── Helpers ───────────────────────────────────────────────────────────

	/** All live session ids across all instances, for live-session filtering. */
	private getLiveSessionIds(): Set<string> {
		const ids = new Set<string>();
		for (const mgr of this.instances.values()) {
			ids.add(mgr.liveSessionId);
		}
		return ids;
	}

	// ── Session scanning (mtime-cached, per-file granularity) ─────────────

	private async scanSessions(opts?: { max?: number; ts?: string; cwd?: string }): Promise<{
		sessions: SessionInfo[];
		hasMore: boolean;
	}> {
		const cwd = opts?.cwd ?? this.cwd;
		const sessionDir = getDefaultSessionDir(cwd, this.agentDir);

		let filePaths: string[];
		try {
			filePaths = readdirSync(sessionDir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => join(sessionDir, f))
				.sort();
		} catch {
			return { sessions: [], hasMore: false };
		}

		// Stat all files (cheap, no content read) for mtime-based sort
		const withStats: { file: string; mtimeMs: number }[] = [];
		for (const file of filePaths) {
			try {
				const s = statSync(file);
				withStats.push({ file, mtimeMs: s.mtimeMs });
			} catch {
				// skip unreadable files
			}
		}

		// Sort by mtime desc
		withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

		// Apply cursor: skip files newer than ts (we want sessions older than
		// the cursor). If no ts, start from newest.
		const cursorMs = opts?.ts ? new Date(opts.ts).getTime() : Infinity;
		const afterCursor = opts?.ts ? withStats.filter((w) => w.mtimeMs < cursorMs) : withStats;

		// Apply limit. If we slice fewer than total, we have more.
		const max = opts?.max ?? 0;
		const sliced = max > 0 ? afterCursor.slice(0, max) : afterCursor;
		const hasMore = max > 0 && afterCursor.length > max;

		// Parse only the sliced files (mtime cache hit → reuse, miss → parse)
		const newCache = new Map(this.sessionCache);
		const sessions: SessionInfo[] = [];

		for (const { file } of sliced) {
			const stat = statSync(file);
			const cached = this.sessionCache.get(file);
			if (cached && cached.mtimeMs === stat.mtimeMs) {
				newCache.set(file, cached);
				sessions.push(cached.info);
			} else {
				const info = parseSessionFile(file);
				if (info) {
					const entry = { mtimeMs: stat.mtimeMs, info };
					newCache.set(file, entry);
					sessions.push(info);
				}
			}
		}

		this.sessionCache = newCache;
		return { sessions, hasMore };
	}

	// ── Daemon verbs (called by Connection) ───────────────────────────────

	private daemonVerbs: DaemonVerbs = {
		listSessions: async (opts?: { max?: number; ts?: string; cwd?: string }) => {
			const result = await this.scanSessions(opts);
			// Filter out live sessions (sessions currently owned by a Manager)
			const liveIds = this.getLiveSessionIds();
			result.sessions = result.sessions.filter((s) => !liveIds.has(s.sessionId));
			return result;
		},

		listFiles: (prefix: string, cwd?: string): Array<{ path: string; isDirectory: boolean }> => {
			return listFiles(prefix, cwd ?? this.cwd);
		},

		readFile: (path: string, cwd?: string) => readHostFile(path, cwd ?? this.cwd),

		getDaemonInfo: () => {
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
			return { models, thinkingLevels: THINKING_LEVELS, cwdAllowlist: this.cwdAllowlist, devMode: this.devMode };
		},

		listInstances: () => {
			const instances: InstanceInfo[] = [];
			for (const [id, m] of this.instances) {
				instances.push({
					instanceId: id,
					sessionId: m.liveSessionId,
					cwd: m.cwd,
					name: m.document.status.name,
					isStreaming: m.document.status.isStreaming,
					...extractInstanceSummary(m.document),
				});
			}
			return instances;
		},

		switchInstance: async (instanceId: string, conn: Connection, cursor?: PrefixCursor | null) => {
			const mgr = this.instances.get(instanceId);
			if (!mgr) return { ok: false, error: "no such instance" };
			conn.detach();
			conn.attach(mgr, instanceId, cursor);
			return { ok: true };
		},

		newInstance: async (cwd: string, conn: Connection) => {
			if (!this.cwdAllowlist.includes(cwd)) {
				return { ok: false, error: `cwd not in allowlist: ${cwd}` };
			}
			const mgr = await this.managerFactory({
				cwd,
				agentDir: this.agentDir,
				modelRuntime: this.modelRuntime,
			});
			const instanceId = randomUUID();
			this.instances.set(instanceId, mgr);
			conn.detach();
			conn.attach(mgr, instanceId);
			return { ok: true, instanceId };
		},

		killInstance: async (instanceId: string, _conn: Connection) => {
			const mgr = this.instances.get(instanceId);
			if (!mgr) return { ok: false, error: "no such instance" };
			// mgr.dispose() does: await abort (save) → emit onExit (instance_exit) → runtime.dispose()
			await mgr.dispose();
			this.instances.delete(instanceId);
			return { ok: true };
		},
	};

	/** Try to serve an embedded asset; returns true if served. */
	private tryServeEmbedded(path: string, res: ServerResponse): boolean {
		if (!this.embeddedAssets) return false;
		// Normalize: strip leading /, default / → index.html
		const key = path === "/" ? "index.html" : path.replace(/^\//, "");
		const encoded = this.embeddedAssets[key];
		if (!encoded) return false;

		const ext = extname(key);
		const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
		const content = Buffer.from(encoded, "base64");
		res.writeHead(200, { "Content-Type": contentType });
		res.end(content);
		return true;
	}

	// ── Helpers ───────────────────────────────────────────────────────────

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

	// ── Server ────────────────────────────────────────────────────────────

	private async startServer(): Promise<void> {
		const root = this.webRoot ?? join(import.meta.dirname, "../../dist/web");

		this.httpServer = createServer((req, res) => {
			let path = req.url?.split("?")[0] ?? "/";
			if (path === "/") path = "/index.html";

			// Try embedded assets first (single-file distribution)
			if (this.tryServeEmbedded(path, res)) return;

			const filePath = join(root, path);

			if (!filePath.startsWith(root)) {
				res.writeHead(403);
				res.end("Forbidden");
				return;
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

function parseSessionFile(filePath: string): SessionInfo | null {
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

		const stat = statSync(filePath);
		return {
			sessionId: sessionId ?? filePath, // headerless legacy file: fall back to the path
			sessionPath: filePath,
			name,
			timestamp: stat.mtime.toISOString(),
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

// ── Instance summary (preview / last activity / message count) ───────

const PREVIEW_MAX = 120;

/** Extract the launcher-facing summary fields from a Manager's document. */
function extractInstanceSummary(doc: Document): {
	preview?: string;
	lastActivityAt?: string;
	messageCount?: number;
} {
	// Preview = most recent message text of any role (chat-app session list:
	// "where the conversation currently stands"), skipping messages without
	// text (tool-call-only assistant turns).
	let lastMsgTs = "";
	let lastMsgText: string | undefined;
	let lastActivityAt: string | undefined;
	for (const entry of Object.values(doc.entries)) {
		const ts = entry.timestamp;
		if (!ts) continue;
		if (!lastActivityAt || ts > lastActivityAt) lastActivityAt = ts;
		if (entry.kind === "message" && ts >= lastMsgTs) {
			const text = extractFirstText(entry.content);
			if (text) {
				lastMsgTs = ts;
				lastMsgText = text;
			}
		}
	}
	const messageCount = doc.status.stats.messages || undefined;
	const preview = lastMsgText ? clampPreview(lastMsgText) : undefined;
	return { preview, lastActivityAt, messageCount };
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
 * `~`) resolve against the instance cwd; throws on missing paths / non-files
 * so the Connection converts the message into an `ok:false` reply. Exported
 * for Connection-level tests (the DaemonVerbs seam takes the same function). */
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

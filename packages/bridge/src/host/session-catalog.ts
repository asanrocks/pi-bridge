// ============================================================================
// Session catalog — the durable Session listing (Worker-side).
//
// A listing answers "what Sessions exist in this Project, newest first", which
// is a storage question: it reads the Project's Session directory, parses the
// durable metadata of the rows it finds, and overlays the live Activations the
// registry reports (an unflushed Session has no file yet, and a live Document
// is fresher than the last flush). It owns no Activation state and never
// disposes anything.
//
// The module lives with the Worker because that is where the Session
// directory is addressable: the Daemon's listing verbs route here, and a
// remote Worker would answer them itself.
// ============================================================================

import { Buffer } from "node:buffer";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import {
	compareQueueRows,
	type SessionInfo,
	type SessionListCursor,
	type SessionLocation,
	type SessionRef,
} from "../core/index.ts";
import { containedSessionFile, isTrashedStem, type ProjectConfig, resolveStemPath } from "./projects.ts";
import { type ActorMetadata, clampPreview } from "./session-actor.ts";
import type { Placement } from "./session-locations.ts";

import type { SessionPage } from "./worker-contract.ts";

/** One live Activation as the catalog needs it: the address for the row, and
 * the actor's typed listing facts. The catalog never sees a Manager. */
export interface CatalogLiveEntry {
	readonly ref: SessionRef;
	readonly metadata: ActorMetadata;
}

interface FileMeta {
	sessionId: string;
	name?: string;
	firstMessageText?: string;
	lastMessageText?: string;
	lastActivityAt?: string;
	lastUserActivity?: string;
	lastAgentActivity?: string;
	lastAgentText?: string;
	messageCount?: number;
}

interface ScanEntry {
	stem: string;
	abs: string;
	sortTimeMs: number;
	active?: CatalogLiveEntry;
}

/** The durable locations the catalog overlays onto every row: the Worker
 * supplies its location store; the catalog owns only the lookup. Keyed by
 * stem — the record's key is the row's address. */
export interface CatalogLocationOverlay {
	locationOf(projectId: string, stem: string): SessionLocation;
	/** The Project's recorded places, keyed by stem: the queue's membership,
	 * in memory, each with the stamp its placement transition wrote. */
	placed(projectId: string): ReadonlyMap<string, Placement>;
}

export interface SessionCatalog {
	/** One page of a Project's Session history, newest first (sort time desc,
	 * then canonical stem desc — ADR 11). */
	listSessions(
		projectId: string,
		max: number | undefined,
		cursor: SessionListCursor | null,
		live: readonly CatalogLiveEntry[],
		locations: CatalogLocationOverlay,
	): SessionPage;
	/** The queue: every Inbox and Later session across every Project, ordered
	 * Inbox → Later, then by placement stamp descending. `reuse` supplies rows a
	 * caller already holds for dormant Sessions, so a metadata-only refresh
	 * reads no files (ADR 24). */
	listQueue(
		live: readonly CatalogLiveEntry[],
		locations: CatalogLocationOverlay,
		reuse?: ReadonlyMap<string, SessionInfo>,
	): SessionInfo[];
}

/** Cap for the header-only scan. A pi session header is a single short line. */
const HEADER_SCAN_BYTES = 64 * 1024;

export function createSessionCatalog(projects: Map<string, ProjectConfig>): SessionCatalog {
	/** Per-file mtime cache: only re-read session files whose mtime changed. */
	const metaCache = new Map<string, { mtimeMs: number; meta: FileMeta }>();

	const readFileMeta = (filePath: string): FileMeta | null => {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(filePath).mtimeMs;
		} catch {
			return null;
		}
		const cached = metaCache.get(filePath);
		if (cached && cached.mtimeMs === mtimeMs) return cached.meta;
		const meta = parseSessionFile(filePath);
		if (meta) metaCache.set(filePath, { mtimeMs, meta });
		return meta;
	};

	/** Recursively discover session files plus live (possibly unflushed)
	 * activations, keyed by stem. Active entries win over disk rows. */
	const scan = (project: ProjectConfig, live: readonly CatalogLiveEntry[]): ScanEntry[] => {
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
			// The trash prefix is a storage namespace, not discovery: a trashed
			// session is not listed and has no address.
			if (isTrashedStem(stem)) continue;
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

		for (const entry of live) {
			if (entry.ref.projectId !== project.id) continue;
			let sortTimeMs = Date.parse(entry.metadata.createdAt);
			if (existsSync(entry.metadata.sessionFile)) {
				try {
					sortTimeMs = statSync(entry.metadata.sessionFile).mtimeMs;
				} catch {
					// fall back to the header creation time
				}
			}
			byStem.set(entry.ref.stem, {
				stem: entry.ref.stem,
				abs: entry.metadata.sessionFile,
				sortTimeMs,
				active: entry,
			});
		}

		return [...byStem.values()];
	};

	const toSessionInfo = (project: ProjectConfig, entry: ScanEntry, placement: Placement): SessionInfo => {
		const active = entry.active;
		// A durable file is the metadata source even while active; only an
		// unflushed activation has no file to read, so its document is used.
		const durable = existsSync(entry.abs);
		const meta = durable ? readFileMeta(entry.abs) : null;
		// `""` is a baseline, not an instant: only a queued row has a placement
		// stamp, and an absent field is the archived row's honest shape.
		const placedAt = placement.placedAt === "" ? undefined : placement.placedAt;
		if (!meta && !active) {
			// Unreadable file: surface a minimal row rather than dropping it. The
			// location overlay still applies — an unparseable file says nothing
			// about whether the user parked or awaits this session.
			return {
				projectId: project.id,
				sessionId: entry.stem,
				stem: entry.stem,
				location: placement.location,
				placedAt,
				timestamp: new Date(entry.sortTimeMs).toISOString(),
			};
		}
		const liveMeta = active?.metadata;
		const sessionId = meta?.sessionId ?? active?.ref.sessionId ?? entry.stem;
		return {
			projectId: project.id,
			sessionId,
			stem: entry.stem,
			location: placement.location,
			placedAt,
			name: meta?.name ?? liveMeta?.name,
			timestamp: new Date(entry.sortTimeMs).toISOString(),
			firstMessageText: meta?.firstMessageText ?? liveMeta?.firstMessageText,
			// The live preview/clocks win over the last flush for an active row;
			// an archived row with no runtime has only the file scan.
			lastMessageText: liveMeta?.lastMessageText ?? meta?.lastMessageText,
			lastAgentText: liveMeta?.lastAgentText ?? meta?.lastAgentText,
			lastActivityAt: liveMeta?.lastActivityAt ?? meta?.lastActivityAt,
			lastUserActivity: liveMeta?.lastUserActivity ?? meta?.lastUserActivity,
			lastAgentActivity: liveMeta?.lastAgentActivity ?? meta?.lastAgentActivity,
			messageCount: meta?.messageCount ?? liveMeta?.messageCount,
			// Only a live runtime knows what it is executing; a dormant row has
			// nothing running, so the field is absent rather than stale.
			activity: liveMeta?.activity,
		};
	};

	/** One queued row: the live overlay wins when an Activation exists (the
	 * registry's in-memory metadata; the sort key is the file's mtime, else
	 * the header creation time). A dormant row reads the one file its stem
	 * names — mtime-cached like every catalog read. A queued record whose
	 * stem resolves to no file and no Activation (moved or deleted on disk
	 * after the record was written) renders no row: the same visible behavior
	 * a full scan would produce, and the next boot's recovery prunes the
	 * record. */
	const queueRow = (
		project: ProjectConfig,
		stem: string,
		active: CatalogLiveEntry | undefined,
		placement: Placement,
		reuse: ReadonlyMap<string, SessionInfo> | undefined,
	): SessionInfo | null => {
		if (active) {
			let sortTimeMs = Date.parse(active.metadata.createdAt);
			if (existsSync(active.metadata.sessionFile)) {
				try {
					sortTimeMs = statSync(active.metadata.sessionFile).mtimeMs;
				} catch {
					// fall back to the header creation time
				}
			}
			return toSessionInfo(project, { stem, abs: active.metadata.sessionFile, sortTimeMs, active }, placement);
		}
		// A dormant row is reused when the caller supplies a previous slice: its
		// file can only have changed through a trigger that rebuilds in full, so
		// an activity or streaming callback never reads it (ADR 24).
		const key = `${project.id}\0${stem}`;
		const previous = reuse?.get(key);
		if (previous !== undefined) return previous;
		const real = containedSessionFile(project.sessionDir, resolveStemPath(project.sessionDir, stem));
		if (real === null) return null;
		let sortTimeMs: number;
		try {
			sortTimeMs = statSync(real).mtimeMs;
		} catch {
			return null;
		}
		return toSessionInfo(project, { stem, abs: real, sortTimeMs }, placement);
	};

	return {
		listSessions(projectId, max, cursor, live, locations): SessionPage {
			const project = projects.get(projectId);
			if (!project) throw new Error(`Unknown project: ${projectId}`);

			const all = scan(project, live);
			// Total order: sort time desc, then canonical stem desc (ADR 11).
			all.sort((a, b) => {
				if (a.sortTimeMs !== b.sortTimeMs) return b.sortTimeMs - a.sortTimeMs;
				if (a.stem === b.stem) return 0;
				return a.stem < b.stem ? 1 : -1;
			});
			const after = cursor
				? all.filter(
						(e) =>
							e.sortTimeMs < cursor.sortTimeMs || (e.sortTimeMs === cursor.sortTimeMs && e.stem < cursor.stem),
					)
				: all;

			const limit = max !== undefined && max > 0 ? max : after.length;
			const sliced = after.slice(0, limit);
			const hasMore = after.length > sliced.length;
			const sessions = sliced.map((e) =>
				toSessionInfo(project, e, { location: locations.locationOf(project.id, e.stem), placedAt: "" }),
			);
			const last = sliced[sliced.length - 1];
			return {
				sessions,
				hasMore,
				nextCursor: last ? { sortTimeMs: last.sortTimeMs, stem: last.stem } : undefined,
			};
		},

		listQueue(live, locations, reuse): SessionInfo[] {
			// Membership is the stored locations, in memory: the store's keys are
			// the queued stems, so the queue never walks the Project's history —
			// each row costs at most one file (a live row reads only the
			// registry's metadata; a dormant row the one file its stem names).
			const out: SessionInfo[] = [];
			for (const project of projects.values()) {
				const liveByStem = new Map<string, CatalogLiveEntry>();
				for (const entry of live) {
					if (entry.ref.projectId !== project.id) continue;
					liveByStem.set(entry.ref.stem, entry);
				}
				for (const [stem, placement] of locations.placed(project.id)) {
					const row = queueRow(project, stem, liveByStem.get(stem), placement, reuse);
					if (row !== null) out.push(row);
				}
			}
			// The shared total order (core/queue-order.ts): Inbox first (the attention
			// list), Later second (parked by decision); each group by placement stamp
			// descending. A move between the groups is a full rebuild, so a reused
			// dormant row never carries a stale placement.
			out.sort(compareQueueRows);
			return out;
		},
	};
}

/**
 * Startup check (ADR 11): a `sessionId` claimed by two distinct
 * `(projectId, stem)` addresses is unsupported input. Header-only read, so a
 * large history costs one short read per file, not a full parse.
 */
export function assertNoSessionIdConflicts(projects: Map<string, ProjectConfig>): void {
	const owners = new Map<string, string>();
	for (const project of projects.values()) {
		for (const [stem, sessionId] of scanDurableSessionIds(project)) {
			const address = `${project.id}/${stem}`;
			const owner = owners.get(sessionId);
			if (owner !== undefined && owner !== address) {
				throw new Error(`Duplicate session id "${sessionId}" in ${owner} and ${address}`);
			}
			owners.set(sessionId, address);
		}
	}
}

/** The durable session ids a Project's storage holds, keyed by stem: the
 * discovery scan (recursive `*.jsonl`, trash prefix excluded, symlink
 * containment enforced) reduced to the header ids — the startup conflict
 * check's notion of "a session that exists". */
export function scanDurableSessionIds(project: ProjectConfig): Map<string, string> {
	const ids = new Map<string, string>();
	let rels: string[];
	try {
		rels = readdirSync(project.sessionDir, { recursive: true }) as string[];
	} catch {
		return ids;
	}
	for (const rel of rels) {
		if (!rel.endsWith(".jsonl")) continue;
		const stem = rel.split(sep).join("/").slice(0, -".jsonl".length);
		// The trash prefix is a storage namespace, not discovery: a manual copy
		// into `.trash/` must not fail the uniqueness invariant.
		if (isTrashedStem(stem)) continue;
		// statSync below follows symlinks, so a symlinked `.jsonl` pointing
		// outside the namespace must not leak a foreign id (ADR 11 boundary).
		const real = containedSessionFile(project.sessionDir, join(project.sessionDir, rel));
		if (real === null) continue;
		const sessionId = readSessionHeaderId(real);
		if (sessionId === null) continue;
		ids.set(stem, sessionId);
	}
	return ids;
}

// ── Durable-file parsing ────────────────────────────────────────────────

interface FileSessionEntry {
	type?: string;
	id?: string;
	name?: string;
	message?: { role?: string; content?: unknown; timestamp?: number };
	timestamp?: string;
	[key: string]: unknown;
}

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
		let lastUserActivity: string | undefined;
		let lastAgentActivity: string | undefined;
		let lastAgentText: string | undefined;
		let agentWordsAt: string | undefined;
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
				// The role clocks are stamped for every message, text or not: a
				// tool-only assistant message is still the agent speaking.
				if (typeof entry.timestamp === "string" && entry.timestamp) {
					const ts = entry.timestamp;
					if (msg?.role === "user" && (!lastUserActivity || ts > lastUserActivity)) lastUserActivity = ts;
					if (msg?.role === "assistant" && (!lastAgentActivity || ts > lastAgentActivity)) lastAgentActivity = ts;
					// The running row's status text: the newest assistant words,
					// whether they are the answer or only thinking. A later message
					// without words (a tool call) must not blank the line.
					if (msg?.role === "assistant") {
						const words = firstAgentWords(msg.content);
						if (words !== undefined && (agentWordsAt === undefined || ts >= agentWordsAt)) {
							lastAgentText = words;
							agentWordsAt = ts;
						}
					}
				}
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
			lastAgentText: lastAgentText ? clampPreview(lastAgentText) : undefined,
			lastActivityAt,
			lastUserActivity,
			lastAgentActivity,
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

/** The agent's own words in one durable message, for the running row's status
 * line: its first `text` block, else its first `thinking` block — the same
 * rule the live-document extractor applies. */
function firstAgentWords(content: unknown): string | undefined {
	if (typeof content === "string") return content || undefined;
	if (!Array.isArray(content)) return undefined;
	let thinking: string | undefined;
	for (const item of content) {
		const block = item as { type?: string; text?: string; thinking?: string; redacted?: boolean };
		if (block.type === "text" && block.text) return block.text;
		// Redacted reasoning is not words the agent wrote that a reader may see.
		if (block.type === "thinking" && block.redacted !== true && block.thinking && thinking === undefined) {
			thinking = block.thinking;
		}
	}
	return thinking;
}

// ============================================================================
// Session states — the durable, user-visible session lifecycle (ADR 22).
//
// Each session carries one of four states — inactive (the default; a history
// row), busy (an execution is in flight), notified (the agent finished and
// awaits input), deferred (the user parked a non-busy session) — persisted
// by the Worker next to the sessions it describes, independently of any
// runtime. An Activation is an execution resource; this store is what the
// user sees, and it survives idle collection, daemon restarts, and crashes.
//
// The store owns the transitions, not just the writes: every request carries
// its evidence — an admission mints an execution token, a completion carries
// the token of the execution it settles (so the settle of a superseded
// execution cannot mark notified a session a newer prompt already made
// busy), a close carries the token it began under (skipped when a newer
// admission followed), and the defer/restore toggle carries its "not busy"
// precondition, checked here rather than by a caller that may have raced an
// admission.
//
// Persistence: one JSON file per Project at `<sessionDir>/.pi-bridge/
// states.json`, keyed by the durable session id and carrying no address (a
// moved session file keeps its state). Writes are whole-file, atomic (temp
// file + rename), and synchronous — a transition decides and persists in one
// event-loop turn, so arrival order is the serialization. A missing file is
// the normal first state. A present but corrupt file is quarantined (renamed
// to a `.corrupt` sibling, never overwritten) and surfaced: silently
// degrading would make unfinished work disappear. Write failures split by
// intent — turn-boundary writes (admission, settlement, abandonment) degrade
// to in-memory and are retried by the next transition; user-action writes
// (toggle, close, archive) throw, so a failed verb is retryable rather than
// a silently lost intent.
// ============================================================================

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionState, SessionToggleState } from "../core/index.ts";
import type { ProjectConfig } from "./projects.ts";
import { scanDurableSessionIds } from "./session-catalog.ts";

export type { SessionToggleState };

/** The identity of one execution, minted at admission. Opaque outside this
 * module and the Worker that routes tokens to it. */
export type ExecutionToken = string;

/** One persisted record. The in-memory form adds the execution bookkeeping
 * the wire never sees. */
interface StateRecord {
	state: SessionState;
	updatedAt: string;
	/** The current execution's token, set at admission. Not persisted. */
	token?: ExecutionToken;
	/** The state to restore when the current admission fails before starting
	 * the execution (a refused preflight). Not persisted. */
	preAdmission?: { state: SessionState; updatedAt: string };
}

interface StoredFile {
	version: 1;
	sessions: Record<string, { state: SessionState; updatedAt: string }>;
}

export interface SessionStates {
	/** The session's durable state; `inactive` when no record exists. */
	stateOf(projectId: string, sessionId: string): SessionState;
	/** A prompt's admission succeeded: the session is busy under a fresh
	 * execution token, which the caller passes back at settlement. */
	admit(projectId: string, sessionId: string): ExecutionToken;
	/** The admission failed before the execution started: restore the state
	 * the session had before it. A no-op when a newer admission already
	 * superseded the token. */
	abandon(projectId: string, sessionId: string, token: ExecutionToken): void;
	/** An execution fully settled: busy becomes notified when the token is
	 * still the current execution; otherwise the settle names a superseded
	 * execution and changes nothing. */
	settle(projectId: string, sessionId: string, token: ExecutionToken | undefined): void;
	/** The user's defer/restore toggle. Refused (throws) while busy — the
	 * state machine owns the precondition, not the caller. Durable-or-fail. */
	toggle(projectId: string, sessionId: string, state: SessionToggleState): void;
	/** Close: the session becomes inactive. Skipped when an admission newer
	 * than `since` began after the close did — a newer user intent keeps the
	 * session busy. Durable-or-fail. */
	markInactive(projectId: string, sessionId: string, since: ExecutionToken | null): void;
	/** Archive: drop the record entirely. Durable-or-fail. */
	prune(projectId: string, sessionId: string): void;
	/** The current execution token, for a close's precondition capture. */
	tokenOf(projectId: string, sessionId: string): ExecutionToken | null;
}

export interface SessionStatesOptions {
	/** Timestamp source, injectable for deterministic tests. */
	now?: () => string;
}

const STORE_DIR = ".pi-bridge";
const STORE_FILE = "states.json";
const STATE_VALUES: readonly SessionState[] = ["inactive", "notified", "busy", "deferred"];

export function createSessionStates(
	projects: Map<string, ProjectConfig>,
	options: SessionStatesOptions = {},
): SessionStates {
	const now = options.now ?? (() => new Date().toISOString());
	/** Per-Project records, keyed by durable session id. */
	const records = new Map<string, Map<string, StateRecord>>();
	const files = new Map<string, string>();

	const loadProject = (project: ProjectConfig): void => {
		const dir = join(project.sessionDir, STORE_DIR);
		const file = join(dir, STORE_FILE);
		files.set(project.id, file);
		const stored = readStored(file, project.id);
		const known = new Set(scanDurableSessionIds(project).values());
		const loaded = new Map<string, StateRecord>();
		for (const [sessionId, record] of stored) {
			// Recovery (ADR 22): the Worker's process died with the runtimes, so
			// nothing is executing — a persisted busy becomes notified, which is
			// what the next boot's settle would have written anyway. A record
			// whose session file does not exist is dropped: a first turn that
			// never flushed has no durable conversation, so there is nothing to
			// be notified about (ADR 12's accepted loss, made visible).
			if (!known.has(sessionId)) continue;
			loaded.set(sessionId, record.state === "busy" ? { ...record, state: "notified" } : record);
		}
		records.set(project.id, loaded);
		if (stored.size !== loaded.size || [...stored.values()].some((r) => r.state === "busy")) {
			persist(project.id);
		}
	};

	/** Parse the stored file. A missing file is the normal first state (empty);
	 * an unreadable or malformed one is quarantined and reported, never
	 * overwritten. */
	const readStored = (file: string, projectId: string): Map<string, StateRecord> => {
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			return new Map();
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			quarantine(file, projectId, "not valid JSON");
			return new Map();
		}
		const shape = parsed as Partial<StoredFile>;
		if (
			shape === null ||
			typeof shape !== "object" ||
			shape.version !== 1 ||
			typeof shape.sessions !== "object" ||
			shape.sessions === null
		) {
			quarantine(file, projectId, "unexpected shape");
			return new Map();
		}
		const out = new Map<string, StateRecord>();
		for (const [sessionId, record] of Object.entries(shape.sessions)) {
			if (
				record === null ||
				typeof record !== "object" ||
				!STATE_VALUES.includes((record as StateRecord).state) ||
				typeof (record as StateRecord).updatedAt !== "string"
			) {
				quarantine(file, projectId, `bad record for session ${sessionId}`);
				return new Map();
			}
			out.set(sessionId, { state: (record as StateRecord).state, updatedAt: (record as StateRecord).updatedAt });
		}
		return out;
	};

	const quarantine = (file: string, projectId: string, reason: string): void => {
		// Never overwrite: an earlier quarantine's evidence stays on disk, so a
		// repeated corruption keeps every copy.
		let dest = `${file}.corrupt`;
		for (let i = 1; existsSync(dest); i++) dest = `${file}.corrupt.${i}`;
		try {
			renameSync(file, dest);
			console.error(
				`Session states for project ${projectId} were corrupt (${reason}); ` +
					`quarantined as ${dest} and restarted empty — queue state was lost.`,
			);
		} catch (error) {
			console.error(
				`Session states for project ${projectId} are corrupt (${reason}) and could not be ` +
					`quarantined (${error instanceof Error ? error.message : String(error)}); ` +
					`serving an empty store. Remove ${file} to recover.`,
			);
		}
	};

	const recordOf = (projectId: string, sessionId: string): StateRecord | undefined =>
		records.get(projectId)?.get(sessionId);

	const requireRecords = (projectId: string): Map<string, StateRecord> => {
		const map = records.get(projectId);
		if (map === undefined) throw new Error(`Unknown project: ${projectId}`);
		return map;
	};

	/** Whole-file atomic persist. Turn-boundary callers tolerate a failure (the
	 * in-memory state is already decided; the next transition retries); user
	 * actions let it throw. */
	const persist = (projectId: string): void => {
		const file = files.get(projectId);
		if (file === undefined) throw new Error(`Unknown project: ${projectId}`);
		const stored: StoredFile = {
			version: 1,
			sessions: Object.fromEntries(
				[...requireRecords(projectId)].map(([sessionId, record]) => [
					sessionId,
					{ state: record.state, updatedAt: record.updatedAt },
				]),
			),
		};
		const temp = `${file}.${process.pid}.tmp`;
		// Created lazily at the first write: a Project with no queue state yet
		// keeps a clean session directory (the catalog scanner reads only
		// `*.jsonl`, so the store directory is invisible to discovery either way).
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(temp, `${JSON.stringify(stored, null, "\t")}\n`);
		renameSync(temp, file);
	};

	/** Decide a turn-boundary transition and persist on a best-effort basis: a
	 * failed write degrades to in-memory state and is surfaced — the execution
	 * it reports must never be blocked or failed by its own bookkeeping. */
	const turnBoundary = (projectId: string, decide: (map: Map<string, StateRecord>) => boolean): void => {
		const map = requireRecords(projectId);
		const changed = decide(map);
		if (!changed) return;
		try {
			persist(projectId);
		} catch (error) {
			console.error(
				`Failed to persist session states for project ${projectId} ` +
					`(${error instanceof Error ? error.message : String(error)}); retrying on the next transition. ` +
					`A restart before then loses the affected queue entries.`,
			);
		}
	};

	for (const project of projects.values()) loadProject(project);
	return {
		stateOf(projectId, sessionId) {
			return recordOf(projectId, sessionId)?.state ?? "inactive";
		},

		admit(projectId, sessionId) {
			const token = randomUUID();
			turnBoundary(projectId, (map) => {
				const previous = map.get(sessionId);
				// Every admission is a new execution, busy or not: the token names
				// the execution whose settlement the store will accept, and a
				// steer admitted mid-turn is one continuing execution whose settle
				// lands under the newest token.
				map.set(sessionId, {
					state: "busy",
					updatedAt: now(),
					token,
					preAdmission: previous
						? { state: previous.state, updatedAt: previous.updatedAt }
						: { state: "inactive", updatedAt: now() },
				});
				return true;
			});
			return token;
		},

		abandon(projectId, sessionId, token) {
			turnBoundary(projectId, (map) => {
				const record = map.get(sessionId);
				if (record?.token !== token) return false;
				const restore = record.preAdmission ?? { state: "inactive" as const, updatedAt: now() };
				// A fresh session whose first prompt was refused has no state to
				// show: the record disappears rather than lingering as a row that
				// was never anything.
				if (restore.state === "inactive") map.delete(sessionId);
				else map.set(sessionId, { state: restore.state, updatedAt: restore.updatedAt });
				return true;
			});
		},

		settle(projectId, sessionId, token) {
			turnBoundary(projectId, (map) => {
				const record = map.get(sessionId);
				// The settle of a superseded execution changes nothing: a newer
				// admission already made the session busy under its own token,
				// and that execution's settle is the one that will land.
				if (record === undefined || record.token !== token || record.state !== "busy") return false;
				record.state = "notified";
				record.updatedAt = now();
				return true;
			});
		},

		toggle(projectId, sessionId, state) {
			const map = requireRecords(projectId);
			const record = map.get(sessionId);
			if (record?.state === "busy") {
				throw new Error("Session is busy: defer or restore it after the run settles");
			}
			map.set(sessionId, { state, updatedAt: now() });
			persist(projectId);
		},

		markInactive(projectId, sessionId, since) {
			const map = requireRecords(projectId);
			const record = map.get(sessionId);
			if (record === undefined) return;
			// A newer admission after the close began is a newer user intent: the
			// close still disposed the runtime it addressed, but its write is
			// skipped so the session stays busy (ADR 22 close-wins rule).
			if ((record.token ?? null) !== since) return;
			map.delete(sessionId);
			persist(projectId);
		},

		prune(projectId, sessionId) {
			const map = requireRecords(projectId);
			if (!map.delete(sessionId)) return;
			persist(projectId);
		},

		tokenOf(projectId, sessionId) {
			return recordOf(projectId, sessionId)?.token ?? null;
		},
	};
}

// ============================================================================
// Session states — the durable, user-visible session lifecycle.
//
// Each session carries one of four states — inactive (the default; a history
// row), busy (an execution is in flight), notified (the agent finished and
// awaits input), deferred (the user parked a non-busy session) — persisted
// by the Worker next to the sessions it describes, independently of any
// runtime. An Activation is an execution resource; this store is what the
// user sees, and it survives idle collection, daemon restarts, and crashes.
//
// The store owns the transitions, not just the writes: every request carries
// its evidence — an admission mints an execution token and snapshots the
// record it replaces, a completion carries the token of the execution it
// settles (so the settle of a superseded execution cannot mark notified a
// session a newer prompt already made busy; that superseded settle is still
// remembered, so an abandonment knows when the execution it restores has
// already ended), an abandonment restores the
// snapshot — a still-running execution's token included, so a refused
// superseding admission hands the session back to that execution instead of
// stranding it busy under a token no settle will ever carry — a close carries
// the token it began under (skipped when a newer admission followed), and the
// defer/restore toggle carries its "not busy" precondition, checked here
// rather than by a caller that may have raced an admission.
//
// Persistence: one JSON file per Project at `<sessionDir>/.pi-bridge/
// states.json`, keyed by the session's stem — its address, so the record
// names the row the queue needs with no index and no directory scan: the
// queue's membership is this store's key set. The stem is stable for every
// session the system serves (allocated before first flush, never renamed
// in-system, dropped at archive), so the one case the durable session id
// would have covered — a manual move to a different stem — loses the state,
// by decision. Writes are whole-file, atomic (temp file + rename), and
// synchronous — a transition decides and persists in one
// event-loop turn, so arrival order is the serialization. A missing file is
// the normal first state. A present but unreadable or corrupt file is
// quarantined (renamed to a `.corrupt` sibling, never overwritten) and
// surfaced: silently degrading would make unfinished work disappear. Write
// failures split by intent — turn-boundary writes (admission, settlement,
// abandonment) degrade to in-memory and are retried by the next transition;
// user-action writes (toggle, close, archive) decide against a candidate copy,
// persist it, and commit only on success, so a failed verb leaves the store
// exactly as it was and a retry re-attempts the write instead of reporting
// success against state that was never durable.
// ============================================================================

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionState, SessionToggleState } from "../core/index.ts";
import { containedSessionFile, normalizeStem, type ProjectConfig, resolveStemPath } from "./projects.ts";

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
	/** The record to restore when the current admission fails before the
	 * execution starts (a refused preflight): a copy of the record as it
	 * stood at admission — an in-flight execution's token included, so that
	 * execution's settle can still land. Not persisted. */
	preAdmission?: StateRecord;
	/** The execution `preAdmission` restores settled while this record was
	 * current: the run ended between this admission's write and its dispatch
	 * recording the new tag, so the settle named the previous execution. A
	 * refusal must land that execution's outcome instead of restoring a busy
	 * record no run will ever settle. Not persisted. */
	preAdmissionSettled?: boolean;
}

interface StoredFile {
	version: 1;
	sessions: Record<string, { state: SessionState; updatedAt: string }>;
}

export interface SessionStates {
	/** The session's durable state at its stem; `inactive` when no record
	 * exists. */
	stateOf(projectId: string, stem: string): SessionState;
	/** The Project's recorded states, keyed by stem — the work queue's
	 * membership. The map is a projected copy: the caller cannot reach the
	 * execution bookkeeping the wire never sees. */
	queued(projectId: string): ReadonlyMap<string, SessionState>;
	/** A prompt's admission succeeded: the session is busy under a fresh
	 * execution token, which the caller passes back at settlement. */
	admit(projectId: string, stem: string): ExecutionToken;
	/** The admission failed before the execution started: restore the record
	 * as it stood at admission — an in-flight execution's token included, so
	 * its settle still lands. A no-op when a newer admission already
	 * superseded the token, or the token's execution already settled. */
	abandon(projectId: string, stem: string, token: ExecutionToken): void;
	/** An execution fully settled: busy becomes notified when the token is
	 * still the current execution; otherwise the settle names a superseded
	 * execution and changes nothing. */
	settle(projectId: string, stem: string, token: ExecutionToken | undefined): void;
	/** The user's defer/restore toggle. Refused (throws) while busy — the
	 * state machine owns the precondition, not the caller. Durable-or-fail. */
	toggle(projectId: string, stem: string, state: SessionToggleState): void;
	/** Close: the session becomes inactive. Skipped when an admission newer
	 * than `since` began after the close did — a newer user intent keeps the
	 * session busy. Durable-or-fail. */
	markInactive(projectId: string, stem: string, since: ExecutionToken | null): void;
	/** Archive: drop the record entirely. Durable-or-fail. */
	prune(projectId: string, stem: string): void;
	/** The current execution token, for a close's precondition capture. */
	tokenOf(projectId: string, stem: string): ExecutionToken | null;
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
	/** Per-Project records, keyed by stem. */
	const records = new Map<string, Map<string, StateRecord>>();
	const files = new Map<string, string>();

	/** A session file exists at this stem: containment-checked, so a stored
	 * stem can never make recovery or the queue read outside the Project's
	 * session directory. */
	const sessionFileAt = (project: ProjectConfig, stem: string): string | null => {
		try {
			return containedSessionFile(project.sessionDir, resolveStemPath(project.sessionDir, stem));
		} catch {
			// A stem that escapes the directory (only possible from a
			// hand-edited store file — the verbs normalize) resolves to nothing.
			return null;
		}
	};

	const loadProject = (project: ProjectConfig): void => {
		const dir = join(project.sessionDir, STORE_DIR);
		const file = join(dir, STORE_FILE);
		files.set(project.id, file);
		const stored = readStored(file, project.id);
		const loaded = new Map<string, StateRecord>();
		for (const [stem, record] of stored) {
			// Recovery: the Worker's process died with the runtimes, so
			// nothing is executing — a persisted busy becomes notified, which is
			// what the next boot's settle would have written anyway. A record
			// whose session file does not exist is dropped: a first turn that
			// never flushed has no durable conversation (ADR 12's accepted loss,
			// made visible), and a stem moved or deleted on disk after the last
			// write names no session this Worker serves. The check is one
			// existence probe per record — the queue's size, not the history's.
			if (sessionFileAt(project, stem) === null) continue;
			loaded.set(stem, record.state === "busy" ? { ...record, state: "notified" } : record);
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
		} catch (error) {
			// Only a missing file is the normal first state. Anything else — a
			// directory in the file's place, permissions, an I/O error — is a
			// present file the store cannot read, and serving empty would silently
			// discard its queue state at the next write: quarantine it like
			// corrupt content, keeping the evidence on disk.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
			quarantine(file, projectId, `unreadable (${error instanceof Error ? error.message : String(error)})`);
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
		for (const [stem, record] of Object.entries(shape.sessions)) {
			// The store file is disk input: a key that is not a canonical stem
			// (an escaping path, an archived stem, a `.jsonl` suffix) is a bad
			// record, quarantined with the rest — never a key the queue could
			// resolve against the filesystem.
			let valid = false;
			try {
				valid = normalizeStem(stem) === stem;
			} catch {
				valid = false;
			}
			if (
				!valid ||
				record === null ||
				typeof record !== "object" ||
				!STATE_VALUES.includes((record as StateRecord).state) ||
				typeof (record as StateRecord).updatedAt !== "string"
			) {
				quarantine(file, projectId, `bad record for session ${stem}`);
				return new Map();
			}
			out.set(stem, { state: (record as StateRecord).state, updatedAt: (record as StateRecord).updatedAt });
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

	const recordOf = (projectId: string, stem: string): StateRecord | undefined => records.get(projectId)?.get(stem);

	const requireRecords = (projectId: string): Map<string, StateRecord> => {
		const map = records.get(projectId);
		if (map === undefined) throw new Error(`Unknown project: ${projectId}`);
		return map;
	};

	/** Whole-file atomic persist. Turn-boundary callers tolerate a failure (the
	 * in-memory state is already decided; the next transition retries); user
	 * actions let it throw. `sessions` is the map to serialize — the live
	 * records for a turn boundary, a candidate copy for a user action (see
	 * `userAction`). */
	const persist = (projectId: string, sessions: Map<string, StateRecord> = requireRecords(projectId)): void => {
		const file = files.get(projectId);
		if (file === undefined) throw new Error(`Unknown project: ${projectId}`);
		const stored: StoredFile = {
			version: 1,
			sessions: Object.fromEntries(
				[...sessions].map(([stem, record]) => [stem, { state: record.state, updatedAt: record.updatedAt }]),
			),
		};
		const temp = `${file}.${process.pid}.tmp`;
		// Created lazily at the first write: a Project with no queue state yet
		// keeps a clean session directory (the catalog scanner reads only
		// `*.jsonl`, so the store directory is invisible to discovery either way).
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(temp, `${JSON.stringify(stored, null, "\t")}\n`);
		try {
			renameSync(temp, file);
		} catch (error) {
			// The temp file is garbage once the rename failed; leave nothing
			// behind for the next write to trip over.
			try {
				rmSync(temp);
			} catch {
				// The rename's error is the one to surface.
			}
			throw error;
		}
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

	/** Decide a user-action transition against a candidate copy, persist the
	 * candidate, and commit it only once the write landed: a failed verb
	 * leaves the store exactly as it was, so a retry re-attempts the write
	 * instead of reporting success against state that was never durable —
	 * the opposite of `turnBoundary`'s trade, because the user's intent must
	 * not stand half-applied. The candidate is a shallow copy whose entries
	 * are replaced wholesale (never mutated in place), so the live records
	 * are untouched until the commit. */
	const userAction = (projectId: string, decide: (map: Map<string, StateRecord>) => boolean): void => {
		const candidate = new Map(requireRecords(projectId));
		if (!decide(candidate)) return;
		persist(projectId, candidate);
		records.set(projectId, candidate);
	};

	for (const project of projects.values()) loadProject(project);
	return {
		stateOf(projectId, stem) {
			return recordOf(projectId, stem)?.state ?? "inactive";
		},

		queued(projectId) {
			const projected = new Map<string, SessionState>();
			for (const [stem, record] of requireRecords(projectId)) projected.set(stem, record.state);
			return projected;
		},

		admit(projectId, stem) {
			const token = randomUUID();
			turnBoundary(projectId, (map) => {
				const previous = map.get(stem);
				// Every admission is a new execution, busy or not: the token names
				// the execution whose settlement the store will accept, and a
				// steer admitted mid-turn is one continuing execution whose settle
				// lands under the newest token. The snapshot is the whole previous
				// record — a still-running execution's token included — so an
				// abandoned superseding admission restores that execution rather
				// than a busy row no settle can ever land on.
				map.set(stem, {
					state: "busy",
					updatedAt: now(),
					token,
					preAdmission: previous ? { ...previous } : undefined,
				});
				return true;
			});
			return token;
		},

		abandon(projectId, stem, token) {
			turnBoundary(projectId, (map) => {
				const record = map.get(stem);
				// A settle already landed under this token — a run settling while
				// the refused dispatch was still pending reported its tag — so the
				// execution completed; restoring now would un-settle it.
				if (record?.token !== token || record.state !== "busy") return false;
				// A fresh session whose first prompt was refused has no state to
				// show: the record disappears rather than lingering as a row that
				// was never anything.
				const restore = record.preAdmission;
				if (restore === undefined) map.delete(stem);
				// The execution being restored already settled while this admission
				// was still pending (see `settle`): its outcome is the record, not the
				// busy state it was in at admission.
				else if (record.preAdmissionSettled) map.set(stem, { state: "notified", updatedAt: now() });
				else map.set(stem, restore);
				return true;
			});
		},

		settle(projectId, stem, token) {
			turnBoundary(projectId, (map) => {
				const record = map.get(stem);
				// The settle of a superseded execution leaves the state alone: a
				// newer admission already made the session busy under its own token,
				// and that execution's settle is the one that will land. It is still
				// remembered — a run can end between a newer admission's write and its
				// dispatch recording the tag, so the settle names the execution that
				// admission snapshotted, and a refusal of that admission lands this
				// outcome rather than restoring a busy record nothing will settle.
				if (record === undefined || token === undefined || record.state !== "busy") return false;
				if (record.token !== token) {
					if (record.preAdmission?.token !== token) return false;
					record.preAdmissionSettled = true;
					return false;
				}
				record.state = "notified";
				record.updatedAt = now();
				return true;
			});
		},

		toggle(projectId, stem, state) {
			// The store owns the precondition: a defer racing an admission is
			// refused here, not by a caller that may have raced it.
			if (recordOf(projectId, stem)?.state === "busy") {
				throw new Error("Session is busy: defer or restore it after the run settles");
			}
			userAction(projectId, (map) => {
				map.set(stem, { state, updatedAt: now() });
				return true;
			});
		},

		markInactive(projectId, stem, since) {
			userAction(projectId, (map) => {
				const record = map.get(stem);
				if (record === undefined) return false;
				// A newer admission after the close began is a newer user intent: the
				// close still disposed the runtime it addressed, but its write is
				// skipped so the session stays busy (close-wins rule).
				if ((record.token ?? null) !== since) return false;
				map.delete(stem);
				return true;
			});
		},

		prune(projectId, stem) {
			userAction(projectId, (map) => map.delete(stem));
		},

		tokenOf(projectId, stem) {
			return recordOf(projectId, stem)?.token ?? null;
		},
	};
}

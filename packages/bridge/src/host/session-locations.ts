// ============================================================================
// Session locations — the durable, user-visible placement of a Session.
//
// Every Session is in exactly one place: **Inbox** (the user's attention
// list), **Later** (parked by decision), or **Archive** (the default resting
// place — browsable history nothing is expected of). This store owns the two
// stored places; Archive is the absence of a record, which is why a fresh
// Session needs no write to be archived. The set of stored places is the
// queue's membership, so the queue never scans history to learn its rows.
//
// Running is deliberately not a location: it is the runtime's own attribute
// (see `SessionInfo.activity`), so a Session can be running while placed in
// Inbox or Later, and a daemon restart has no execution state to recover.
//
// The store also owns the one transition that follows a submitted message: an
// admission places the Session in Inbox, remembering the placement it
// replaced, so a refused admission restores that placement instead of leaving
// a promotion nobody asked for. The admission token makes both sides safe
// against ordering: a newer admission or a user move replaces the record
// wholesale (dropping the token), so a stale restore is a no-op rather than
// an overwrite.
//
// Each record also carries the instant its transition wrote it (`placedAt`),
// because the queue's order is derived from placement decisions rather than
// from activity: a streaming turn advances the row's last activity on every
// delta, so ordering by that moved every other row while the reader was
// reading it. Only a transition — a submission promoting into Inbox, a user
// move, a restored refusal — changes the order, and a move that lands where the
// Session already was is not a transition: it keeps its stamp, so a redundant
// click cannot jump a row to the top.
//
// Persistence: one JSON file per Project at `<sessionDir>/.pi-bridge/
// locations.json`, keyed by the session's stem — its address, so a record
// names the row the queue needs with no index and no directory scan. The stem
// is stable for every Session the system serves (allocated before the first
// flush, never renamed in-system), so a manual move to a different stem loses
// the placement, by decision. Writes are whole-file, atomic (temp file +
// rename), and synchronous — a transition decides and persists in one
// event-loop turn, so arrival order is the serialization. A missing file is
// the normal first state. The file is versioned: 3 is the stamped format, and
// a version 2 file (the place alone) is upgraded in place on load — its
// records share one empty stamp rather than a time invented for them, so they
// sort after every stamped row until the user next places them. A
// pre-locations `states.json` (version 1) beside it is migrated on load, and
// the instant it recorded becomes the stamp. A present but unreadable or
// corrupt file is quarantined (renamed to a `.corrupt` sibling, never
// overwritten) and surfaced: silently degrading would make queued work
// disappear. Write failures split by intent — the admission writes degrade to
// in-memory and are retried by the next transition; user moves decide against a
// candidate copy, persist it, and commit only on success, so a failed move
// leaves the store exactly as it was and a retry re-attempts the write instead
// of reporting success against a placement that was never durable.
// ============================================================================

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionLocation } from "../core/index.ts";
import { containedSessionFile, normalizeStem, type ProjectConfig, resolveStemPath } from "./projects.ts";

/** The identity of one admission, minted when a message places its Session in
 * Inbox. Opaque outside this module. */
export type AdmissionToken = string;

/** The two places the store records; Archive is the absence of a record. */
type StoredPlace = "inbox" | "later";

/** One persisted record: the place, and the instant the transition that wrote
 * it happened — the queue's ordering value. `""` is the shared baseline of a
 * pre-stamp file: it is older than every real instant, so an upgrade never
 * fabricates an order. The in-memory form adds the admission bookkeeping the
 * wire never sees. */
interface PlaceRecord {
	place: StoredPlace;
	placedAt: string;
	/** The admission that wrote this record, while that admission is still
	 * pending. Not persisted. */
	token?: AdmissionToken;
	/** The record this admission replaced, restored when it is refused:
	 * `undefined` when the Session was archived before it. The snapshot is the
	 * whole record — its own token and snapshot included — so a chain of refused
	 * admissions unwinds one link at a time. Records are replaced wholesale,
	 * never mutated, so the snapshot can share the previous record's subtree.
	 * Not persisted. */
	previous?: PlaceRecord;
}

interface StoredRecord {
	place: StoredPlace;
	placedAt: string;
}

/** The written format: the place and the stamp of the transition that wrote
 * it. Version 2 (the place alone) is readable too — it upgrades on load, since
 * v3 is v2 plus the stamp and there is no second file to retire. */
interface StoredFile {
	version: 3;
	sessions: Record<string, StoredRecord>;
}

/** The pre-locations format: four durable states, two of which were execution
 * facts. Read once, on migration. */
interface LegacyStoredFile {
	version: 1;
	sessions: Record<string, { state: string; updatedAt: string }>;
}

/** One Session's placement as the queue consumes it: the place, and the stamp
 * its transition wrote. Archive is the absence of a record, so `placed()` never
 * yields it; the catalog reuses this shape for a history row, which has no
 * stamp (`placedAt: ""`). */
export interface Placement {
	location: SessionLocation;
	placedAt: string;
}

export interface SessionLocations {
	/** The Session's durable place at its stem; `archive` when no record
	 * exists. */
	locationOf(projectId: string, stem: string): SessionLocation;
	/** The Project's recorded places, keyed by stem — the queue's membership and
	 * its order. A projected copy: the caller cannot reach the admission
	 * bookkeeping, and cannot mutate what it receives. */
	placed(projectId: string): ReadonlyMap<string, Placement>;
	/** A user move (Inbox, Later, or Archive). Durable-or-fail. */
	place(projectId: string, stem: string, location: SessionLocation): void;
	/** A message was submitted: the Session is in Inbox under a fresh
	 * admission token, which the caller passes back if the admission is
	 * refused. Best-effort durability (the execution outranks its
	 * bookkeeping). */
	promote(projectId: string, stem: string): AdmissionToken;
	/** The admission was refused before the run started: restore the placement
	 * it replaced. A no-op when a newer admission or a user move has written
	 * the record since. */
	restore(projectId: string, stem: string, token: AdmissionToken): void;
	/** The Session left discovery (trashed): drop the record. Durable-or-fail. */
	prune(projectId: string, stem: string): void;
}

export interface SessionLocationsOptions {
	/** Where a quarantine, a failed migration, or a degraded write is reported:
	 * the console by default, a collector in tests. */
	onWarning?: (message: string) => void;
	/** The clock the placement stamps read. A test seam: the stamp is the
	 * queue's order, so a test that places two Sessions needs to name their
	 * instants instead of racing the millisecond. */
	now?: () => Date;
}

const STORE_DIR = ".pi-bridge";
const STORE_FILE = "locations.json";
const LEGACY_STORE_FILE = "states.json";
const PLACES: readonly StoredPlace[] = ["inbox", "later"];

export function createSessionLocations(
	projects: Map<string, ProjectConfig>,
	options: SessionLocationsOptions = {},
): SessionLocations {
	const onWarning = options.onWarning ?? ((message: string) => console.error(message));
	const now = options.now ?? (() => new Date());
	/** The stamp of one transition: the ordering value the queue sorts on. */
	const stamp = (): string => now().toISOString();
	/** Per-Project records, keyed by stem. */
	const records = new Map<string, Map<string, PlaceRecord>>();
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
		if (!existsSync(file)) migrateLegacy(project, file);
		const stored = readStored(file, project.id);
		const loaded = new Map<string, PlaceRecord>();
		for (const [stem, record] of stored.records) {
			// Recovery: a record whose session file does not exist is dropped — a
			// first turn that never flushed has no durable conversation (ADR 12's
			// accepted loss, made visible), and a stem moved or deleted on disk
			// after the last write names no Session this Worker serves. The check
			// is one existence probe per record — the queue's size, not the
			// history's.
			if (sessionFileAt(project, stem) === null) continue;
			loaded.set(stem, record);
		}
		records.set(project.id, loaded);
		if (stored.records.size !== loaded.size) persist(project.id);
		else if (stored.upgrade) {
			// The format upgrade is not a decision about placement: serve it in
			// memory when the rewrite fails, so a read-only session directory
			// degrades to "the file catches up on the next transition" instead of
			// quarantining a file whose content is intact.
			try {
				persist(project.id);
			} catch (error) {
				onWarning(
					`Could not upgrade ${file} to the stamped format ` +
						`(${error instanceof Error ? error.message : String(error)}); serving the upgraded placements ` +
						`in memory and rewriting on the next transition.`,
				);
			}
		}
	};

	/** Read a pre-locations file into the new one, then retire it. The mapping
	 * keeps what the user decided: `notified` was the attention list, `deferred`
	 * the parked list; `busy` was an execution fact whose Session was in the
	 * queue, so it lands in Inbox; `inactive` was history, which is Archive and
	 * therefore absent. The old file's `updatedAt` is that decision's instant,
	 * so it becomes the stamp — the one upgrade that needs no baseline. */
	const migrateLegacy = (project: ProjectConfig, file: string): void => {
		const legacyFile = join(project.sessionDir, STORE_DIR, LEGACY_STORE_FILE);
		if (!existsSync(legacyFile)) return;
		let legacy: LegacyStoredFile;
		try {
			legacy = JSON.parse(readFileSync(legacyFile, "utf8")) as LegacyStoredFile;
		} catch (error) {
			onWarning(
				`Could not read ${legacyFile} ` +
					`(${error instanceof Error ? error.message : String(error)}); its placements are ignored.`,
			);
			return;
		}
		if (legacy?.version !== 1 || typeof legacy.sessions !== "object" || legacy.sessions === null) {
			onWarning(`${legacyFile} has an unexpected shape; its placements are ignored.`);
			return;
		}
		const migrated = new Map<string, PlaceRecord>();
		for (const [stem, record] of Object.entries(legacy.sessions)) {
			const placedAt = typeof record?.updatedAt === "string" ? record.updatedAt : "";
			if (record?.state === "notified" || record?.state === "busy") {
				migrated.set(stem, { place: "inbox", placedAt });
			} else if (record?.state === "deferred") {
				migrated.set(stem, { place: "later", placedAt });
			}
		}
		try {
			writeStored(file, migrated);
		} catch (error) {
			onWarning(
				`Could not migrate ${legacyFile} to ${file} ` +
					`(${error instanceof Error ? error.message : String(error)}); the old placements are ignored.`,
			);
			return;
		}
		try {
			rmSync(legacyFile);
		} catch (error) {
			onWarning(
				`Migrated ${legacyFile} to ${file} but could not remove it ` +
					`(${error instanceof Error ? error.message : String(error)}); it is no longer read.`,
			);
		}
	};

	/** A stored place, as the file may spell it (disk input: any JSON value). */
	const isPlace = (value: unknown): value is StoredPlace => PLACES.some((place) => place === value);

	/** The canonical stem a record's key must be, or `null` when the key is
	 * unusable (an escaping path, a trashed stem, a `.jsonl` suffix). */
	const normalizeStemOrNull = (stem: string): string | null => {
		try {
			return normalizeStem(stem);
		} catch {
			return null;
		}
	};

	/** Parse the stored file. A missing file is the normal first state (empty);
	 * an unreadable or malformed one is quarantined and reported, never
	 * overwritten. `upgrade` reports a readable version 2 file, which the caller
	 * rewrites in the current format. */
	const readStored = (file: string, projectId: string): { records: Map<string, PlaceRecord>; upgrade: boolean } => {
		const empty = (): { records: Map<string, PlaceRecord>; upgrade: boolean } => ({
			records: new Map(),
			upgrade: false,
		});
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch (error) {
			// Only a missing file is the normal first state. Anything else — a
			// directory in the file's place, permissions, an I/O error — is a
			// present file the store cannot read, and serving empty would silently
			// discard its queue state at the next write: quarantine it like
			// corrupt content, keeping the evidence on disk.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
			quarantine(file, projectId, `unreadable (${error instanceof Error ? error.message : String(error)})`);
			return empty();
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			quarantine(file, projectId, "not valid JSON");
			return empty();
		}
		if (parsed === null || typeof parsed !== "object") {
			quarantine(file, projectId, "unexpected shape");
			return empty();
		}
		// Two versions are readable and one of them upgrades in place; the shape is
		// disk input, so it is read as unknown fields and checked one by one.
		const shape = parsed as { version?: unknown; sessions?: unknown };
		// A version 2 file is a known format, not corruption: it is the same
		// records without a stamp, so it upgrades rather than quarantines.
		const upgrade = shape.version === 2;
		if (!upgrade && shape.version !== 3) {
			quarantine(file, projectId, "unexpected shape");
			return empty();
		}
		if (typeof shape.sessions !== "object" || shape.sessions === null) {
			quarantine(file, projectId, "unexpected shape");
			return empty();
		}
		const out = new Map<string, PlaceRecord>();
		for (const [stem, entry] of Object.entries(shape.sessions)) {
			// The store file is disk input: a key that is not a canonical stem
			// (an escaping path, a trashed stem, a `.jsonl` suffix) is a bad
			// record, quarantined with the rest — never a key the queue could
			// resolve against the filesystem.
			if (normalizeStemOrNull(stem) !== stem) {
				quarantine(file, projectId, `bad record for session ${stem}`);
				return empty();
			}
			if (upgrade) {
				if (!isPlace(entry)) {
					quarantine(file, projectId, `bad record for session ${stem}`);
					return empty();
				}
				// No instant was ever recorded: `""` is the baseline every upgraded
				// record shares, so the upgrade invents no order.
				out.set(stem, { place: entry, placedAt: "" });
				continue;
			}
			const record = entry as Record<string, unknown> | null;
			if (
				record === null ||
				typeof record !== "object" ||
				!isPlace(record.place) ||
				typeof record.placedAt !== "string"
			) {
				quarantine(file, projectId, `bad record for session ${stem}`);
				return empty();
			}
			out.set(stem, { place: record.place, placedAt: record.placedAt });
		}
		return { records: out, upgrade };
	};

	const quarantine = (file: string, projectId: string, reason: string): void => {
		// Never overwrite: an earlier quarantine's evidence stays on disk, so a
		// repeated corruption keeps every copy.
		let dest = `${file}.corrupt`;
		for (let i = 1; existsSync(dest); i++) dest = `${file}.corrupt.${i}`;
		try {
			renameSync(file, dest);
			onWarning(
				`Session locations for project ${projectId} were corrupt (${reason}); ` +
					`quarantined as ${dest} and restarted empty — queue state was lost.`,
			);
		} catch (error) {
			onWarning(
				`Session locations for project ${projectId} are corrupt (${reason}) and could not be ` +
					`quarantined (${error instanceof Error ? error.message : String(error)}); ` +
					`serving an empty store. Remove ${file} to recover.`,
			);
		}
	};

	const recordOf = (projectId: string, stem: string): PlaceRecord | undefined => records.get(projectId)?.get(stem);

	const requireRecords = (projectId: string): Map<string, PlaceRecord> => {
		const map = records.get(projectId);
		if (map === undefined) throw new Error(`Unknown project: ${projectId}`);
		return map;
	};

	/** Write a place map whole-file and atomically. Returns after the rename
	 * landed, so a caller that commits on success commits durable state. */
	const writeStored = (file: string, sessions: Map<string, PlaceRecord>): void => {
		const stored: StoredFile = {
			version: 3,
			sessions: Object.fromEntries(
				[...sessions].map(([stem, record]) => [stem, { place: record.place, placedAt: record.placedAt }]),
			),
		};
		const temp = `${file}.${process.pid}.tmp`;
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

	/** Persist the live records (or a candidate copy, see `userAction`). */
	const persist = (projectId: string, sessions: Map<string, PlaceRecord> = requireRecords(projectId)): void => {
		const file = files.get(projectId);
		if (file === undefined) throw new Error(`Unknown project: ${projectId}`);
		writeStored(file, sessions);
	};

	/** Decide an admission transition and persist on a best-effort basis: a
	 * failed write degrades to in-memory placement and is surfaced — the
	 * execution it reports must never be blocked by its own bookkeeping. */
	const turnBoundary = (projectId: string, decide: (map: Map<string, PlaceRecord>) => boolean): void => {
		const map = requireRecords(projectId);
		const changed = decide(map);
		if (!changed) return;
		try {
			persist(projectId);
		} catch (error) {
			onWarning(
				`Failed to persist session locations for project ${projectId} ` +
					`(${error instanceof Error ? error.message : String(error)}); retrying on the next transition. ` +
					`A restart before then loses the affected queue entries.`,
			);
		}
	};

	/** Decide a user transition against a candidate copy, persist the
	 * candidate, and commit it only once the write landed: a failed move
	 * leaves the store exactly as it was, so a retry re-attempts the write
	 * instead of reporting success against a placement that was never durable.
	 * The candidate is a shallow copy whose entries are replaced wholesale
	 * (never mutated in place), so the live records are untouched until the
	 * commit. */
	const userAction = (projectId: string, decide: (map: Map<string, PlaceRecord>) => boolean): void => {
		const candidate = new Map(requireRecords(projectId));
		if (!decide(candidate)) return;
		persist(projectId, candidate);
		records.set(projectId, candidate);
	};

	for (const project of projects.values()) loadProject(project);
	return {
		locationOf(projectId, stem) {
			return recordOf(projectId, stem)?.place ?? "archive";
		},

		placed(projectId) {
			const projected = new Map<string, Placement>();
			for (const [stem, record] of requireRecords(projectId)) {
				projected.set(stem, { location: record.place, placedAt: record.placedAt });
			}
			return projected;
		},

		place(projectId, stem, location) {
			userAction(projectId, (map) => {
				if (location === "archive") return map.delete(stem);
				const previous = map.get(stem);
				if (previous?.place === location) {
					// The row is already there: the click reorders nothing, so it keeps its
					// stamp. A pending admission on the record still has to go, though — a
					// refusal must not revert a placement the user made by hand.
					if (previous.token === undefined) return false;
					map.set(stem, { place: location, placedAt: previous.placedAt });
					return true;
				}
				map.set(stem, { place: location, placedAt: stamp() });
				return true;
			});
		},

		promote(projectId, stem) {
			const token = randomUUID();
			turnBoundary(projectId, (map) => {
				// The whole previous record is the snapshot: a still-pending
				// admission's token included, so a refused admission restores a
				// promotion that is itself still pending.
				const previous = map.get(stem);
				map.set(stem, { place: "inbox", placedAt: stamp(), token, previous });
				return true;
			});
			return token;
		},

		restore(projectId, stem, token) {
			turnBoundary(projectId, (map) => {
				const record = map.get(stem);
				// A newer admission or a user move replaced the record: its
				// placement is the newer intent, and restoring would overwrite it.
				if (record?.token !== token) return false;
				if (record.previous === undefined) map.delete(stem);
				else map.set(stem, record.previous);
				return true;
			});
		},

		prune(projectId, stem) {
			userAction(projectId, (map) => map.delete(stem));
		},
	};
}

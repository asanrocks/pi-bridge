// ============================================================================
// Session locations: unit tests of the durable placement store — the Inbox
// promotion and its rollback, user moves, the per-Project persistence at
// `<sessionDir>/.pi-bridge/locations.json`, the pre-locations file migration,
// and startup recovery (stale records, quarantine).
// ============================================================================

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../src/host/projects.ts";
import { createSessionLocations, type SessionLocations } from "../../src/host/session-locations.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const dirs: string[] = [];

afterEach(() => {
	while (dirs.length) {
		const dir = dirs.pop();
		if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

/** A temp Project with a session directory holding the given session files
 * (`stem` → file content first line). The stem is the file's name minus
 * `.jsonl` — the location record's key. */
function projectWith(sessions: Record<string, string> = {}): ProjectConfig {
	const root = join(tmpdir(), `pi-bridge-locations-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	dirs.push(root);
	const sessionDir = join(root, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	for (const [stem, content] of Object.entries(sessions)) {
		writeFileSync(join(sessionDir, `${stem}.jsonl`), `${content}\n`);
	}
	return { id: "proj", cwd: root, sessionDir };
}

/** A session file's header line, as the catalog scanner reads it. */
const header = (sessionId: string): string => JSON.stringify({ type: "session", id: sessionId });

function storeFor(project: ProjectConfig): SessionLocations {
	return createSessionLocations(new Map([[project.id, project]]), { onWarning: () => {} });
}

const storeFile = (project: ProjectConfig): string => join(project.sessionDir, ".pi-bridge", "locations.json");
const legacyStoreFile = (project: ProjectConfig): string => join(project.sessionDir, ".pi-bridge", "states.json");

const readStore = (project: ProjectConfig): Record<string, unknown> =>
	JSON.parse(readFileSync(storeFile(project), "utf8")) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

describe("session locations: transitions", () => {
	it("a missing file is the normal first state: every session is archived", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		expect(store.locationOf("proj", "s1")).toBe("archive");
		expect(existsSync(storeFile(project))).toBe(false);
	});

	it("a submitted message places the session in Inbox", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		store.promote("proj", "s1");
		expect(store.locationOf("proj", "s1")).toBe("inbox");
		expect(readStore(project)).toEqual({ version: 2, sessions: { s1: "inbox" } });
	});

	it("a refused admission restores the placement it replaced", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		store.place("proj", "s1", "later");
		const token = store.promote("proj", "s1");
		store.restore("proj", "s1", token);
		expect(store.locationOf("proj", "s1")).toBe("later");
	});

	it("a refused first message leaves no record", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		const token = store.promote("proj", "s1");
		store.restore("proj", "s1", token);
		expect(store.locationOf("proj", "s1")).toBe("archive");
		expect(readStore(project)).toEqual({ version: 2, sessions: {} });
	});

	it("a stale rollback changes nothing, and a chain of refusals unwinds one link at a time", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		store.place("proj", "s1", "later");
		const first = store.promote("proj", "s1");
		const second = store.promote("proj", "s1");
		// The older refusal arrives while the newer admission owns the record: it
		// is the newer one's outcome to decide, so this changes nothing.
		store.restore("proj", "s1", first);
		expect(store.locationOf("proj", "s1")).toBe("inbox");
		// The newer one's rollback restores the older promotion — still pending,
		// so the placement stays Inbox and the older token is back in force.
		store.restore("proj", "s1", second);
		expect(store.locationOf("proj", "s1")).toBe("inbox");
		// Now the older refusal lands and unwinds the last link.
		store.restore("proj", "s1", first);
		expect(store.locationOf("proj", "s1")).toBe("later");
	});

	it("a move made while a send is pending survives that send's refusal", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		const token = store.promote("proj", "s1");
		// The user parks it from another tab while the dispatch is still pending.
		store.place("proj", "s1", "later");
		store.restore("proj", "s1", token);
		expect(store.locationOf("proj", "s1")).toBe("later");
	});

	it("moves cover Inbox, Later, and Archive; Archive is the absence of a record", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		store.place("proj", "s1", "inbox");
		expect(readStore(project)).toEqual({ version: 2, sessions: { s1: "inbox" } });
		store.place("proj", "s1", "later");
		expect(readStore(project)).toEqual({ version: 2, sessions: { s1: "later" } });
		store.place("proj", "s1", "archive");
		expect(store.locationOf("proj", "s1")).toBe("archive");
		expect(readStore(project)).toEqual({ version: 2, sessions: {} });
	});

	it("a move never looks at execution: a running Session stays where the user put it", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		// Running is not stored at all; the store's surface has no execution input,
		// so this asserts the absence by construction: placement round-trips while
		// a run would be in flight.
		store.place("proj", "s1", "later");
		expect(store.locationOf("proj", "s1")).toBe("later");
		expect(store.placed("proj").get("s1")).toBe("later");
	});

	it("prune drops the record (trash)", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		store.place("proj", "s1", "inbox");
		store.prune("proj", "s1");
		expect(store.locationOf("proj", "s1")).toBe("archive");
	});

	it("an unknown project is refused", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		expect(() => store.promote("other", "s1")).toThrow(/Unknown project/);
	});
});

// ---------------------------------------------------------------------------
// Persistence and recovery
// ---------------------------------------------------------------------------

describe("session locations: persistence and recovery", () => {
	it("Inbox and Later survive a restart", () => {
		const project = projectWith({ s1: header("s1"), s2: header("s2") });
		const store = storeFor(project);
		store.promote("proj", "s1");
		store.place("proj", "s2", "later");

		const reopened = storeFor(project);
		expect(reopened.locationOf("proj", "s1")).toBe("inbox");
		expect(reopened.locationOf("proj", "s2")).toBe("later");
		// Membership is the key set: the queue's rows come from the store, and
		// each key names the file it needs.
		expect([...reopened.placed("proj")].sort()).toEqual([
			["s1", "inbox"],
			["s2", "later"],
		]);
	});

	it("a session file moved to a different stem loses its placement — the key is the address", () => {
		const project = projectWith({ s1: header("id-1") });
		const store = storeFor(project);
		store.promote("proj", "s1");
		renameSync(join(project.sessionDir, "s1.jsonl"), join(project.sessionDir, "moved.jsonl"));
		const reopened = storeFor(project);
		expect(reopened.locationOf("proj", "s1")).toBe("archive");
		expect(reopened.locationOf("proj", "moved")).toBe("archive");
	});

	it("a record whose session file does not exist is dropped at startup", () => {
		const project = projectWith({ s1: header("id-1") });
		const store = storeFor(project);
		store.place("proj", "s1", "inbox");
		store.place("proj", "s2", "later"); // s2 has no file
		const reopened = storeFor(project);
		expect(reopened.locationOf("proj", "s1")).toBe("inbox");
		expect(reopened.locationOf("proj", "s2")).toBe("archive");
	});

	it("a pre-locations file is migrated: notified and busy to Inbox, deferred to Later, inactive dropped", () => {
		const project = projectWith({ s1: header("s1"), s2: header("s2"), s3: header("s3"), s4: header("s4") });
		mkdirSync(join(project.sessionDir, ".pi-bridge"), { recursive: true });
		writeFileSync(
			legacyStoreFile(project),
			JSON.stringify({
				version: 1,
				sessions: {
					s1: { state: "notified", updatedAt: "2026-01-01T00:00:00Z" },
					s2: { state: "deferred", updatedAt: "2026-01-01T00:00:00Z" },
					s3: { state: "busy", updatedAt: "2026-01-01T00:00:00Z" },
					s4: { state: "inactive", updatedAt: "2026-01-01T00:00:00Z" },
				},
			}),
		);

		const store = storeFor(project);
		expect(store.locationOf("proj", "s1")).toBe("inbox");
		expect(store.locationOf("proj", "s2")).toBe("later");
		expect(store.locationOf("proj", "s3")).toBe("inbox");
		expect(store.locationOf("proj", "s4")).toBe("archive");
		expect(readStore(project)).toEqual({ version: 2, sessions: { s1: "inbox", s2: "later", s3: "inbox" } });
		// The old file is retired only once the new one landed.
		expect(existsSync(legacyStoreFile(project))).toBe(false);
	});

	it("an unreadable pre-locations file is reported and ignored, not interpreted", () => {
		const project = projectWith({ s1: header("s1") });
		mkdirSync(join(project.sessionDir, ".pi-bridge"), { recursive: true });
		writeFileSync(legacyStoreFile(project), "{ not json");
		const warnings: string[] = [];
		const store = createSessionLocations(new Map([[project.id, project]]), {
			onWarning: (message) => warnings.push(message),
		});
		expect(store.locationOf("proj", "s1")).toBe("archive");
		expect(warnings.some((message) => message.includes("states.json"))).toBe(true);
	});

	it("a bad stem key is a corrupt record, never a key the store could resolve on disk", () => {
		const project = projectWith({ s1: header("id-1") });
		const store = storeFor(project);
		store.place("proj", "s1", "inbox");
		// A hand-edited store file: an escaping key (or a trashed or
		// `.jsonl`-suffixed one) must not become a path the queue opens.
		writeFileSync(storeFile(project), JSON.stringify({ version: 2, sessions: { "../../etc/passwd": "inbox" } }));
		const reopened = storeFor(project);
		expect(reopened.locationOf("proj", "s1")).toBe("archive");
		expect(existsSync(`${storeFile(project)}.corrupt`)).toBe(true);
	});

	it("a corrupt file is quarantined, never overwritten, and the store starts fresh", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		store.place("proj", "s1", "later");
		// Corrupt the persisted file; a previous quarantine copy already sits
		// beside it, so the new one must not clobber the old evidence.
		writeFileSync(`${storeFile(project)}.corrupt`, "earlier corruption");
		writeFileSync(storeFile(project), "{ not json");

		const reopened = storeFor(project);
		expect(reopened.locationOf("proj", "s1")).toBe("archive");
		expect(readFileSync(`${storeFile(project)}.corrupt`, "utf8")).toBe("earlier corruption");
		expect(readFileSync(`${storeFile(project)}.corrupt.1`, "utf8")).toBe("{ not json");

		// The fresh store works: a move writes a valid file.
		reopened.place("proj", "s1", "inbox");
		expect(readStore(project)).toEqual({ version: 2, sessions: { s1: "inbox" } });
	});

	it("a bad record value is treated as corruption, not silently skipped", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		store.place("proj", "s1", "later");
		writeFileSync(storeFile(project), JSON.stringify({ version: 2, sessions: { s1: "notified" } }));
		const reopened = storeFor(project);
		expect(reopened.locationOf("proj", "s1")).toBe("archive");
		expect(existsSync(`${storeFile(project)}.corrupt`)).toBe(true);
	});

	it("a failed admission write degrades to in-memory; a user move fails", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		// A directory in the store file's place: the atomic rename cannot land.
		mkdirSync(join(project.sessionDir, ".pi-bridge"), { recursive: true });
		mkdirSync(storeFile(project));
		store.promote("proj", "s1");
		expect(store.locationOf("proj", "s1")).toBe("inbox");
		// The user move is durable-or-fail: a retryable error, not a lost intent.
		expect(() => store.place("proj", "s1", "later")).toThrow();
		// The failed write left no temp-file garbage behind.
		expect(readdirSync(join(project.sessionDir, ".pi-bridge")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("a failed user move leaves the placement unchanged and a retry succeeds", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		store.place("proj", "s1", "inbox");
		// Replace the persisted file with a blocking directory: the atomic rename
		// cannot land, so every user move below fails.
		rmSync(storeFile(project));
		mkdirSync(storeFile(project));
		// Move, archive, and prune: each failed verb leaves the record untouched —
		// the write precedes the in-memory change, so nothing stands half-applied.
		expect(() => store.place("proj", "s1", "later")).toThrow();
		expect(() => store.place("proj", "s1", "archive")).toThrow();
		expect(() => store.prune("proj", "s1")).toThrow();
		expect(store.locationOf("proj", "s1")).toBe("inbox");
		// The blocker is gone: the retry re-attempts and lands the write.
		rmSync(storeFile(project), { recursive: true, force: true });
		store.place("proj", "s1", "later");
		expect(store.locationOf("proj", "s1")).toBe("later");
	});

	it("an unreadable store file is quarantined like a corrupt one", () => {
		const project = projectWith({ s1: header("s1") });
		// A directory in the file's place: present, but readFileSync cannot read it.
		mkdirSync(join(project.sessionDir, ".pi-bridge"), { recursive: true });
		mkdirSync(storeFile(project));
		const store = storeFor(project);
		// Not silently empty: the blocker was moved aside as quarantine evidence,
		// and the store works from a fresh file.
		expect(store.locationOf("proj", "s1")).toBe("archive");
		expect(existsSync(`${storeFile(project)}.corrupt`)).toBe(true);
		store.place("proj", "s1", "inbox");
		expect(readStore(project)).toEqual({ version: 2, sessions: { s1: "inbox" } });
	});
});

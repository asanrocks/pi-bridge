// ============================================================================
// Session states: unit tests of the durable state store — the
// transition rules (token-keyed settlement, close-wins, the busy-refusing
// toggle), the per-Project persistence at `<sessionDir>/.pi-bridge/
// states.json`, and startup recovery (busy → notified, pruning, quarantine).
// ============================================================================

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../src/host/projects.ts";
import { createSessionStates, type SessionStates } from "../../src/host/session-state.ts";

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
 * (`sessionId` → file content first line). */
function projectWith(sessions: Record<string, string> = {}): ProjectConfig {
	const root = join(tmpdir(), `pi-bridge-states-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	dirs.push(root);
	const sessionDir = join(root, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	let i = 0;
	for (const [_sessionId, content] of Object.entries(sessions)) {
		writeFileSync(join(sessionDir, `s${i++}.jsonl`), `${content}\n`);
	}
	return { id: "proj", cwd: root, sessionDir };
}

/** A session file's header line, as the catalog scanner reads it. */
const header = (sessionId: string): string => JSON.stringify({ type: "session", id: sessionId });

function storeFor(project: ProjectConfig): SessionStates {
	return createSessionStates(new Map([[project.id, project]]), { now: () => "2026-01-01T00:00:00Z" });
}

const storeFile = (project: ProjectConfig): string => join(project.sessionDir, ".pi-bridge", "states.json");

const readStore = (project: ProjectConfig): Record<string, unknown> =>
	JSON.parse(readFileSync(storeFile(project), "utf8")) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

describe("session states: transitions", () => {
	it("a missing file is the normal first state: every session inactive", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		expect(store.stateOf("proj", "s1")).toBe("inactive");
		expect(existsSync(storeFile(project))).toBe(false);
	});

	it("admission lands busy; settlement with the token lands notified", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		const token = store.admit("proj", "s1");
		expect(store.stateOf("proj", "s1")).toBe("busy");
		store.settle("proj", "s1", token);
		expect(store.stateOf("proj", "s1")).toBe("notified");
		expect(readStore(project)).toEqual({
			version: 1,
			sessions: { s1: { state: "notified", updatedAt: "2026-01-01T00:00:00Z" } },
		});
	});

	it("a superseded execution's settle changes nothing", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		const first = store.admit("proj", "s1");
		const second = store.admit("proj", "s1");
		store.settle("proj", "s1", first);
		expect(store.stateOf("proj", "s1")).toBe("busy");
		store.settle("proj", "s1", second);
		expect(store.stateOf("proj", "s1")).toBe("notified");
	});

	it("an untagged settle is ignored — it names no admitted execution", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		store.admit("proj", "s1");
		store.settle("proj", "s1", undefined);
		expect(store.stateOf("proj", "s1")).toBe("busy");
	});

	it("a settle that names no current execution changes nothing", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		store.settle("proj", "s1", "no-such-token");
		expect(store.stateOf("proj", "s1")).toBe("inactive");
	});

	it("a failed admission restores the pre-admission state", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		const first = store.admit("proj", "s1");
		store.settle("proj", "s1", first);
		const second = store.admit("proj", "s1");
		store.abandon("proj", "s1", second);
		expect(store.stateOf("proj", "s1")).toBe("notified");
	});

	it("a fresh session whose first prompt was refused leaves no record", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		const token = store.admit("proj", "s1");
		store.abandon("proj", "s1", token);
		expect(store.stateOf("proj", "s1")).toBe("inactive");
		expect(readStore(project)).toEqual({ version: 1, sessions: {} });
	});

	it("the toggle moves notified ↔ deferred and is refused while busy", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		const token = store.admit("proj", "s1");
		store.settle("proj", "s1", token);
		store.toggle("proj", "s1", "deferred");
		expect(store.stateOf("proj", "s1")).toBe("deferred");
		// Deferred is not sticky: a new prompt makes it busy, its settle
		// notified again.
		const again = store.admit("proj", "s1");
		expect(() => store.toggle("proj", "s1", "notified")).toThrow(/busy/);
		store.settle("proj", "s1", again);
		expect(store.stateOf("proj", "s1")).toBe("notified");
		store.toggle("proj", "s1", "notified");
		expect(store.stateOf("proj", "s1")).toBe("notified");
	});

	it("close removes the record; a newer admission since the close began skips the write", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		const token = store.admit("proj", "s1");
		// The close captured `token`; a newer prompt superseded it while the
		// runtime was being disposed.
		store.admit("proj", "s1");
		store.markInactive("proj", "s1", token);
		expect(store.stateOf("proj", "s1")).toBe("busy");
		// Closing with the current token wins.
		store.markInactive("proj", "s1", store.tokenOf("proj", "s1"));
		expect(store.stateOf("proj", "s1")).toBe("inactive");
	});

	it("prune drops the record (archive)", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		const token = store.admit("proj", "s1");
		store.settle("proj", "s1", token);
		store.prune("proj", "s1");
		expect(store.stateOf("proj", "s1")).toBe("inactive");
	});

	it("an unknown project is refused", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		expect(() => store.admit("other", "s1")).toThrow(/Unknown project/);
	});
});

// ---------------------------------------------------------------------------
// Persistence and recovery
// ---------------------------------------------------------------------------

describe("session states: persistence and recovery", () => {
	it("notified and deferred survive a restart; a moved session file keeps its state", () => {
		const project = projectWith({ s1: header("s1"), s2: header("s2") });
		const store = storeFor(project);
		const t1 = store.admit("proj", "s1");
		store.settle("proj", "s1", t1);
		store.toggle("proj", "s2", "deferred");

		const reopened = storeFor(project);
		expect(reopened.stateOf("proj", "s1")).toBe("notified");
		expect(reopened.stateOf("proj", "s2")).toBe("deferred");
	});

	it("a persisted busy recovers to notified", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		store.admit("proj", "s1");
		const reopened = storeFor(project);
		expect(reopened.stateOf("proj", "s1")).toBe("notified");
	});

	it("a record whose session file does not exist is dropped at startup", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		const token = store.admit("proj", "s1");
		store.settle("proj", "s1", token);
		store.admit("proj", "s2"); // busy, and s2 has no file
		const reopened = storeFor(project);
		expect(reopened.stateOf("proj", "s1")).toBe("notified");
		expect(reopened.stateOf("proj", "s2")).toBe("inactive");
	});

	it("a corrupt file is quarantined, never overwritten, and the store starts fresh", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		store.toggle("proj", "s1", "deferred");
		// Corrupt the persisted file; a previous quarantine copy already sits
		// beside it, so the new one must not clobber the old evidence.
		writeFileSync(`${storeFile(project)}.corrupt`, "earlier corruption");
		writeFileSync(storeFile(project), "{ not json");

		const reopened = storeFor(project);
		expect(reopened.stateOf("proj", "s1")).toBe("inactive");
		expect(readFileSync(`${storeFile(project)}.corrupt`, "utf8")).toBe("earlier corruption");
		expect(readFileSync(`${storeFile(project)}.corrupt.1`, "utf8")).toBe("{ not json");

		// The fresh store works: a transition rewrites a valid file.
		const token = reopened.admit("proj", "s1");
		reopened.settle("proj", "s1", token);
		expect(readStore(project)).toEqual({
			version: 1,
			sessions: { s1: { state: "notified", updatedAt: "2026-01-01T00:00:00Z" } },
		});
	});

	it("a bad record shape is treated as corruption, not silently skipped", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		store.toggle("proj", "s1", "deferred");
		writeFileSync(storeFile(project), JSON.stringify({ version: 1, sessions: { s1: { state: "nope" } } }));
		const reopened = storeFor(project);
		expect(reopened.stateOf("proj", "s1")).toBe("inactive");
		expect(existsSync(`${storeFile(project)}.corrupt`)).toBe(true);
	});

	it("a failed turn-boundary write degrades to in-memory; a user-action write fails", () => {
		const project = projectWith({ s1: header("s1") });
		const store = storeFor(project);
		// A directory in the store file's place: the atomic rename cannot land.
		mkdirSync(join(project.sessionDir, ".pi-bridge"), { recursive: true });
		mkdirSync(storeFile(project));
		const token = store.admit("proj", "s1");
		expect(store.stateOf("proj", "s1")).toBe("busy");
		store.settle("proj", "s1", token);
		expect(store.stateOf("proj", "s1")).toBe("notified");
		// The user action is durable-or-fail: a retryable error, not a lost intent.
		expect(() => store.toggle("proj", "s1", "deferred")).toThrow();
	});
});

// ============================================================================
// Process title — the operating system's view of what this process is doing.
//
// Postgres sets one title per process (`postgres: checkpointer`,
// `postgres: walwriter`) and rewrites it as state changes. pi-bridge does the
// same, addressed like a target: which Projects, which role, what now.
//
//   pi-bridge@acme: worker, idle
//   pi-bridge@acme: worker, tool Bash
//   pi-bridge@acme,beta: daemon+worker, stream
//   pi-bridge@acme: worker, offline
//   pi-bridge: daemon, serve 2
//
// The Project list leads because it is the only part that says *where*; the
// role and the phase sit after the colon, in that order, so a 15-byte `comm`
// (`pi-bridge@acme:`) still identifies the process.
//
// Two mechanisms, both native to Node:
//
//   - `process.title` rewrites the argv memory in place (libuv), which sets
//     the `/proc/<pid>/cmdline` that `htop` shows AND the 15-byte `comm` the
//     kernel keeps for each thread.
//   - The writable width is exactly the original command line's byte count.
//     A bundle launch (`./pi-bridge`, 16 bytes) could only ever say
//     `pi-bridge: worker`, so `bootstrapProcessTitle` re-execs through
//     `process.execve` with a padded argv0 — postgres' `save_ps_display_args`
//     trick, minus the PID change that forces postgres to re-fork.
//
// Bootstrap is deliberately dependency-free: `cli.ts` runs it before the pi
// module graph loads, and the padding decision must be testable without a
// runtime. It is also a no-op unless armed, so embeddings and test suites that
// build Workers in-process never touch their own title.
//
// POSIX only. Windows has no title mechanism (libuv's `uv_set_process_title` is
// a no-op there), so every write here degrades to nothing.
// ============================================================================

/** The words a title may use for a Session's live phase. The Manager reports
 * these (see its `activity()`), derived from pi's event stream. */
export type SessionPhase = "idle" | "wait" | "think" | "stream" | "tool" | "compact" | "retry";

/** One Session's contribution to the title. */
export interface SessionActivity {
	readonly phase: SessionPhase;
	/** The executing tool's name while `phase === "tool"`. */
	readonly tool: string | null;
	/** Idle, but the tail needs recovery (ADR 16) — an actionable state, not idleness. */
	readonly recoverable: boolean;
}

/**
 * The facts a title word must not contradict: the last word the event stream
 * gave us, and the canonical Document's own liveness anchors.
 *
 * Events and the Document can disagree — a run can settle (`agent_settled`)
 * while a tool it dispatched is still executing, and a provider that defers its
 * response can leave the event word behind. The Document is what the browser
 * renders, so when they disagree the Document wins: the title must never claim
 * `idle` over a Session that is streaming or has a tool in flight.
 */
export interface ActivityFacts {
	/** The last phase word the event stream produced. */
	readonly phase: SessionPhase;
	/** The tool the events saw running, if any (survives a settle). */
	readonly tool: string | null;
	readonly streaming: boolean;
	readonly compacting: boolean;
	/** A tool is in flight right now (`status.inFlightTools` is non-empty). */
	readonly toolRunning: boolean;
	readonly recoverable: boolean;
}

/** Reconcile the event word with the Document before it becomes a title. */
export function resolveActivity(facts: ActivityFacts): SessionActivity {
	if (facts.compacting) return { phase: "compact", tool: null, recoverable: facts.recoverable };
	if (facts.toolRunning) return { phase: "tool", tool: facts.tool, recoverable: facts.recoverable };
	if (!facts.streaming) return { phase: "idle", tool: null, recoverable: facts.recoverable };
	// Streaming, no tool in flight: a word that would claim the run ended — or
	// a tool word with nothing running — decays to "waiting on the provider".
	const decayed = facts.phase === "idle" || facts.phase === "compact" || facts.phase === "tool";
	return { phase: decayed ? "wait" : facts.phase, tool: null, recoverable: facts.recoverable };
}

/** The Daemon half: how many Worker registrations it routes. */
export interface DaemonTitleState {
	readonly workers: number;
}

/** The Worker half: what it serves and what it is doing. */
export interface WorkerTitleState {
	/** Project ids, primary first. */
	readonly projects: readonly string[];
	readonly sessions: readonly SessionActivity[];
	/** The Daemon link, when this Worker dialed out. A lost link is the one
	 * state where the Worker's own activity is not the interesting fact. */
	readonly link: "up" | "down";
}

export interface TitleState {
	readonly daemon: DaemonTitleState | null;
	readonly worker: WorkerTitleState | null;
}

const BASE_TITLE = "pi-bridge";
/** Writable width to reserve by re-exec. Long enough for
 * `pi-bridge@project,beta: daemon+worker, tool Bash` with room for long Project
 * ids; short enough that padding one argv slot is not wasteful. */
const TITLE_WIDTH = 96;
/** Tool names come from extensions (`mcp__server__tool`); the title is a
 * glance surface, so long names are cut rather than crowding out the Project. */
const TOOL_NAME_WIDTH = 16;
/** Projects named inline before the remainder collapses to `+N`. */
const NAMES_SHOWN = 3;
/** Coalescing window. A turn changes phase a handful of times; streaming
 * deltas arrive per token. Only real label changes write at all (see
 * `commit`), so this bounds the burst case, not the normal one. */
const THROTTLE_MS = 250;
/** Set while re-execing: makes the padded launch a one-shot. */
const PADDED_ENV = "PI_BRIDGE_TITLE_PADDED";
/** `PI_BRIDGE_PROCESS_TITLE=0` disables titles for launches that want them
 * untouched (multi-user hosts; a supervisor that names processes itself). */
const DISABLE_ENV = "PI_BRIDGE_PROCESS_TITLE";

type TitleMode = "off" | "fixed" | "live";

let mode: TitleMode = "off";
let budget = Buffer.byteLength(BASE_TITLE);
let daemon: DaemonTitleState | null = null;
let worker: WorkerTitleState | null = null;
/** The label currently in the process title. */
let written = BASE_TITLE;
/** Monotonic time of the last write; -Infinity so the first one is immediate. */
let lastWriteAt = Number.NEGATIVE_INFINITY;
let pending: ReturnType<typeof setTimeout> | null = null;

/**
 * Decide whether this process may own its title, and widen the writable
 * budget if the launch was too narrow to say anything useful.
 *
 * Call once, before any Worker or Daemon exists. A title already set by
 * something else — node's own `--title`, `NODE_OPTIONS=--title`, an embedding
 * host — is respected as a fixed title: an explicit choice beats a derived
 * one, and it is also how a deployment names a daemon tree in one place.
 */
export function bootstrapProcessTitle(options: { readonly enabled: boolean }): void {
	if (!options.enabled || process.env[DISABLE_ENV] === "0") {
		// Fixed title, no state: the pre-title behaviour, and never a re-exec —
		// a launch that opted out should cost nothing.
		if (process.title === process.argv0) {
			process.title = fitProcessTitle([BASE_TITLE], commandLineBudget(process.argv0, process.argv.slice(1)));
		}
		return;
	}
	// `padded` means this is our own re-exec (the marker never survives a
	// normal launch): its `--title` differs from the padded argv0 by design, so
	// the overflow check below must not read it as an outside choice.
	const padded = process.env[PADDED_ENV] === "1";
	if (!padded && process.title !== process.argv0) {
		mode = "fixed";
		return;
	}
	if (padded) delete process.env[PADDED_ENV];
	else widenTitleBudget();
	mode = "live";
	budget = commandLineBudget(process.argv0, process.argv.slice(1));
	written = fitProcessTitle([BASE_TITLE], budget);
	process.title = written;
}

/**
 * Re-exec with a padded argv0 when the launch left less room than
 * `TITLE_WIDTH`.
 *
 * `process.execve` replaces the image without changing the PID, so a Daemon's
 * spawned-Worker handles stay valid — unlike the fork-and-exit that postgres
 * uses to get the same effect. Node sets the title itself through an injected
 * `--title`, so the padding never becomes visible, not even for the first
 * millisecond of startup.
 *
 * Skipped when it would break something: a debugger cannot rebind its port
 * across an exec, and a failed exec leaves this process in place (node's own
 * experimental warning is the only noise, and it never appears on success).
 */
function widenTitleBudget(): void {
	if (commandLineBudget(process.argv0, process.argv.slice(1)) >= TITLE_WIDTH) return;
	if (typeof process.execve !== "function") return;
	if (
		process.execArgv.some(
			(arg) =>
				arg === "--inspect" ||
				arg === "--inspect-brk" ||
				arg.startsWith("--inspect=") ||
				arg.startsWith("--inspect-brk="),
		)
	) {
		return;
	}
	const argv0 = BASE_TITLE + " ".repeat(TITLE_WIDTH - BASE_TITLE.length);
	process.env[PADDED_ENV] = "1";
	try {
		process.execve(
			process.execPath,
			[argv0, `--title=${BASE_TITLE}`, ...process.execArgv, ...process.argv.slice(1)],
			{
				...process.env,
			},
		);
	} catch {
		delete process.env[PADDED_ENV];
	}
}

/** The bytes `process.title` can hold: the original command line, minus the
 * final NUL. Byte lengths matter — the kernel counts bytes, not characters. */
export function commandLineBudget(argv0: string, rest: readonly string[]): number {
	let bytes = Buffer.byteLength(argv0);
	for (const arg of rest) bytes += Buffer.byteLength(arg) + 1;
	return bytes;
}

/** Report the Daemon half's state. `null` withdraws it. */
export function setDaemonTitle(state: DaemonTitleState | null): void {
	daemon = state;
	schedule();
}

/** Report the Worker half's state. `null` withdraws it. */
export function setWorkerTitle(state: WorkerTitleState | null): void {
	worker = state;
	schedule();
}

function schedule(): void {
	if (mode !== "live") return;
	// A pending write reads the latest state, so a burst collapses into one.
	if (pending !== null) return;
	const wait = Math.max(0, lastWriteAt + THROTTLE_MS - performance.now());
	if (wait === 0) {
		lastWriteAt = performance.now();
		commit();
		return;
	}
	pending = setTimeout(() => {
		pending = null;
		lastWriteAt = performance.now();
		commit();
	}, wait);
	// A title write must never be the reason a stopping process stays alive.
	pending.unref();
}

function commit(): void {
	const next = fitProcessTitle(formatProcessTitle({ daemon, worker }), budget);
	if (next === written) return;
	written = next;
	process.title = next;
}

/** Candidate titles, richest first. The caller picks the first that fits the
 * writable width, so degradation drops detail instead of cutting a word in
 * half: Projects survive longest (they say where), then the phase (it says
 * what now), and the role alone is the floor. */
export function formatProcessTitle(state: TitleState): string[] {
	const candidates: string[] = [];
	const served = state.worker;
	if (served !== null) {
		const role = state.daemon !== null ? "daemon+worker" : "worker";
		const names = namesToken(served.projects);
		const phase = phaseToken(served);
		if (names !== null) candidates.push(`${BASE_TITLE}@${names}: ${role}, ${phase}`);
		candidates.push(`${BASE_TITLE}: ${role}, ${phase}`);
		candidates.push(`${BASE_TITLE}: ${role}`);
	} else if (state.daemon !== null) {
		const count = state.daemon.workers;
		candidates.push(`${BASE_TITLE}: daemon, ${count === 0 ? "wait" : `serve ${count}`}`);
		candidates.push(`${BASE_TITLE}: daemon`);
	}
	candidates.push(BASE_TITLE);
	return candidates;
}

/** The longest candidate the process title can hold. `pi-bridge` itself is
 * the floor; a launch too narrow even for that keeps whatever fits. */
export function fitProcessTitle(candidates: readonly string[], width: number): string {
	for (const candidate of candidates) {
		if (Buffer.byteLength(candidate) <= width) return candidate;
	}
	return BASE_TITLE.slice(0, Math.max(1, width));
}

function namesToken(projects: readonly string[]): string | null {
	if (projects.length === 0) return null;
	const shown = projects.slice(0, NAMES_SHOWN).join(",");
	const rest = projects.length - NAMES_SHOWN;
	return rest > 0 ? `${shown}+${rest}` : shown;
}

const PHASE_RANK: Record<SessionPhase, number> = {
	tool: 6,
	stream: 5,
	think: 4,
	wait: 3,
	compact: 3,
	retry: 3,
	idle: 0,
};

function phaseToken(state: WorkerTitleState): string {
	if (state.link === "down") return "offline";
	let best: SessionActivity | null = null;
	for (const session of state.sessions) {
		if (best === null || rank(session) > rank(best)) best = session;
	}
	if (best === null) return "idle";
	if (best.phase === "tool") return best.tool === null ? "tool" : `tool ${clampTool(best.tool)}`;
	if (best.phase === "idle" && best.recoverable) return "recover";
	return best.phase;
}

/** Idle is the floor, but an idle Session needing recovery outranks a plain
 * idle one: it is the state that wants attention. */
function rank(session: SessionActivity): number {
	if (session.phase === "idle" && session.recoverable) return 1;
	return PHASE_RANK[session.phase];
}

function clampTool(name: string): string {
	return name.length <= TOOL_NAME_WIDTH ? name : name.slice(0, TOOL_NAME_WIDTH);
}

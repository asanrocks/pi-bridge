// ============================================================================
// Session actor (ADR 19) — the one owner of one Session's runtime lifetime.
//
// The actor owns exactly one Manager and its canonical Document: command
// admission, observation registration, and terminal teardown all live here,
// behind one phase state machine (creating → live → closing → closed). The
// Manager stays private to the actor: every mutation of the runtime passes
// through a capability the actor issued, and the daemon's listing reads go
// through `metadata()` — the typed facts derived from the canonical
// Document. Raw Manager access belongs to the creation paths only (the
// factory, the stem derivation, and the pre-attach choices in the
// ExecutionLink's fresh-session choreography): that window is the one
// sanctioned raw access, because the runtime has no owner to admit work
// through until the actor exists. The actor is created around a built
// runtime, so its phase begins `live`; `creating` names that pre-registration
// window.
//
// Admission keeps the two classes the bridge has always needed (architecture
// invariant 5: pi's event loop is serial and the bridge observes it):
//
//   - Mutations (setModel, setThinkingLevel, renameSession, setLabel,
//     navigate) are serialized among themselves — one at a time, in
//     admission order — so concurrent commands from different Connections
//     get a deterministic order. Mutations are quick and never await a
//     turn, so the line cannot deadlock behind streaming.
//   - Immediate work (turns — prompt, recoverTurn — plus abort, and reads —
//     pull, gitShow's cwd) runs without queueing: a Stop must reach a
//     streaming turn rather than wait behind it, and a read that queued
//     behind a turn would stall the live pulls the client issues while
//     content streams. It is tracked, so the terminal drain accounts for it.
//
// `close` is the one disposal path — registry collection and daemon shutdown
// both go through it. Admission stops synchronously (phase `closing`), queued
// mutations reject, the Manager is disposed exactly once — its disposal
// aborts and finalizes the in-flight turn (settling the tracked work
// admitted against it) and drains the git-stamp observation scope before the
// runtime goes — and every tracked operation is awaited before `close`
// resolves (phase `closed`). The drain then releases every live observation:
// they owned delivery of the teardown's final patches, and nothing
// registered through a capability outlives the actor's teardown.
//
// This absorbed `session-execution.ts` (admission and the terminal boundary)
// and `session-lease.ts` (the Connection's release guard): the capability is
// the lease's successor, with independently releasable observations and a
// joinable release. The four load-bearing contract properties are pinned in
// test/suite/session-actor.test.ts:
//   - a command admitted by a capability completes against the runtime it
//     captured, even when the capability is released while it runs;
//   - observation release is idempotent and per-observation;
//   - the terminal boundary is joinable — a second caller awaits the same
//     drain, and the runtime is disposed exactly once;
//   - after a release or the terminal boundary nothing is admitted, and no
//     event reaches a released observer.
// ============================================================================

import { existsSync } from "node:fs";
import type {
	Content,
	Document,
	ImageContent,
	JsonValue,
	PrefixCursor,
	PullRequestItem,
	SessionRef,
} from "../core/index.ts";
import { isEntrySealed, resolveFieldPath } from "../core/index.ts";
import type { ActivationAuthorization } from "./activation-registry.ts";
import { createLifecycleScope } from "./lifecycle-scope.ts";
import type { ConnectionHandle, Manager } from "./manager.ts";

/** Idle-collection policy defaults (ADR 11): a durable or empty session is
 * collected after five idle minutes; an entry-bearing unflushed session only
 * after thirty, because disposing it can drop entries that never reached
 * disk. The registry passes the daemon's configured values; these defaults
 * cover direct construction. */
export const DEFAULT_IDLE_GC_MS = 5 * 60_000;
export const DEFAULT_UNFLUSHED_IDLE_GC_MS = 30 * 60_000;

/** Listing facts the daemon derives from a live Session (ADR 19): the
 * identity the file-scan path needs plus the preview fields computed from
 * the canonical Document. This is the actor's only read surface — the
 * daemon never reaches the runtime itself. */
export interface ActorMetadata {
	readonly sessionFile: string;
	readonly createdAt: string;
	readonly isStreaming: boolean;
	readonly name?: string;
	readonly messageCount?: number;
	readonly firstMessageText?: string;
	readonly lastMessageText?: string;
	readonly lastActivityAt?: string;
}

/** The phase of one Session actor's lifetime. The registry's address
 * reservation covers `creating`; the actor owns the rest, and `closed` is
 * the joinable drain every later caller observes. */
export type ActorPhase = "creating" | "live" | "closing" | "closed";

/** One observer of one Session's Document: the handle shape the runtime
 * already delivers through — the initial-sync frame at registration, live
 * patches after. The Connection implements this today; the browser's mirror
 * sits behind it. */
export type SessionObserver = ConnectionHandle;

/** One registered observation of one Session. Releasing it removes that
 * observer and nothing else — commands stay admitted and sibling
 * observations keep delivering. The release is idempotent and resolves once
 * the observation is gone. */
export interface ObservationCapability {
	readonly ref: SessionRef;
	release(): Promise<void>;
}

/** One lazy value read by the pull verb: the resolved value, plus whether
 * the entry it came from is still live (unsealed) — a live value keeps
 * streaming, so later patches on that path must keep flowing to the
 * pulling client. */
export interface PulledValue {
	readonly entryId: string;
	readonly fieldPath: string;
	readonly value: JsonValue;
	readonly live: boolean;
}

/** One client's handle for one Activation registration: the only path to
 * that Session's runtime. The typed verbs are the Connection's session
 * commands — a command admitted before its registration ended completes
 * against the runtime it captured, so the reply the client trusts describes
 * the session that was attached when the request arrived — and observation
 * registration returns its own independently releasable capability. The
 * generic `command`/`mutate` admission stays for reads and tests. Everything
 * rejects once the registration ended: release, collection, replacement, or
 * daemon shutdown. */
export interface SessionCapability {
	readonly ref: SessionRef;
	readonly authorization: ActivationAuthorization;
	/** The Session's working directory — identity data for attachment-bound
	 * reads (gitShow's query base), not a runtime handle. */
	readonly cwd: string;
	// ── Typed session verbs (admitted by the actor) ─────────────────────
	/** A turn. Immediate admitted work — a Stop must not queue behind it. */
	prompt(text: string, images?: ImageContent[]): Promise<void>;
	abort(): Promise<void>;
	discardSteer(): Promise<void>;
	/** A serialized mutation: one at a time, in admission order. */
	setModel(provider: string, modelId: string): Promise<void>;
	setThinkingLevel(level: string): Promise<void>;
	renameSession(name: string): Promise<void>;
	setLabel(entryId: string, label: string): Promise<void>;
	navigate(entryId: string | null): Promise<void>;
	/** Recover the broken tail turn (ADR 16); `action` reports the repair. */
	recoverTurn(): Promise<"retry" | "continue">;
	/** Read lazy values at field paths (the pull verb); a live value's later
	 * patches are the pulling client's to receive. */
	pull(requests: PullRequestItem[]): Promise<PulledValue[]>;
	// ── Admission for everything else (reads, tests) ─────────────────
	command<T>(operation: (session: Manager) => Promise<T>): Promise<T>;
	mutate<T>(operation: (session: Manager) => Promise<T>): Promise<T>;
	observe(observer: SessionObserver, cursor: PrefixCursor | null): ObservationCapability;
	release(): Promise<void>;
}

export interface SessionActorOptions {
	/** The runtime this actor owns, already built by the creation path. */
	manager: Manager;
	ref: SessionRef;
	authorization: ActivationAuthorization;
	/** Idle-collection delays (ADR 11 daemon policy; defaults above). */
	idleGcMs?: number;
	unflushedIdleGcMs?: number;
	/** The actor became idle: no live capability holds it, it is neither
	 * streaming nor compacting, and the policy delay elapsed. The registry's
	 * collection choreography — never invoked once `close` began. */
	onIdle?: () => void;
}

export interface SessionActor {
	readonly ref: SessionRef;
	readonly authorization: ActivationAuthorization;
	/** The actor's phase. `closing` is set synchronously when `close` begins;
	 * `closed` holds once the drain settled. */
	readonly phase: ActorPhase;
	/** Listing facts derived from the canonical Document (see
	 * `ActorMetadata`): the daemon's read surface over a live Session. */
	metadata(): ActorMetadata;
	/** Mint one client handle for this registration. Every capability shares
	 * the actor's admission; each releases independently. A live capability
	 * is an attached client and keeps the actor alive (glossary A.6). */
	capability(): SessionCapability;
	/** Arm the idle timer for a registration that never attached a client
	 * (an orphaned creation whose Connection closed mid-transition): the
	 * count-based arming only fires when a live capability leaves. */
	armIdle(): void;
	/** The terminal boundary: stop admission synchronously, dispose the
	 * runtime exactly once, drain admitted work, release every observation.
	 * Idempotent and joinable: every caller observes the same teardown. */
	close(): Promise<void>;
}

export function createSessionActor(options: SessionActorOptions): SessionActor {
	const { manager, ref, authorization } = options;
	const idleGcMs = options.idleGcMs ?? DEFAULT_IDLE_GC_MS;
	const unflushedIdleGcMs = options.unflushedIdleGcMs ?? DEFAULT_UNFLUSHED_IDLE_GC_MS;
	const onIdle = options.onIdle;
	const mutations = createLifecycleScope();
	const tracked = new Set<Promise<unknown>>();
	const liveObservations = new Set<{ stop(): void }>();
	/** Live (unreleased) capabilities: a held capability is an attached
	 * client, which keeps the actor alive and cancels idle collection
	 * (glossary A.6 — attached Connections keep an Activation alive). */
	let liveCapabilities = 0;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let phase: ActorPhase = "live";
	let closed: Promise<void> | undefined;

	const cancelIdle = (): void => {
		if (idleTimer !== null) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	};

	/** Arm the idle timer under the ADR 11 policy: a durable or empty session
	 * waits `idleGcMs`; an unflushed session that already has entries waits
	 * the longer `unflushedIdleGcMs`. No-ops while a capability is live or the
	 * actor is not live — and the fire-time re-check covers the races. */
	const armIdle = (): void => {
		if (phase !== "live" || liveCapabilities > 0 || idleTimer !== null) return;
		const durable = existsSync(manager.sessionFile);
		const empty = Object.keys(manager.document.entries).length === 0;
		idleTimer = setTimeout(
			() => {
				idleTimer = null;
				void maybeCollect();
			},
			durable || empty ? idleGcMs : unflushedIdleGcMs,
		);
	};

	/** The idle decision: re-check at fire time (a capability attached or a
	 * close began since the timer was armed owns the decision now), defer
	 * while the runtime is streaming or compacting, then hand the collection
	 * to the registry's choreography. */
	const maybeCollect = async (): Promise<void> => {
		if (phase !== "live" || liveCapabilities > 0) return;
		const status = manager.document.status;
		if (status.isStreaming || status.isCompacting) {
			armIdle();
			return;
		}
		onIdle?.();
	};

	/** One installed observer's stop bookkeeping: idempotent, and visible to
	 * the actor's close so no handle outlives the teardown. */
	const installObservation = (observer: SessionObserver): { stop(): void } => {
		let stopped = false;
		const record = {
			stop() {
				if (stopped) return;
				stopped = true;
				liveObservations.delete(record);
				manager.removeConnection(observer);
			},
		};
		liveObservations.add(record);
		return record;
	};

	const capability = (): SessionCapability => {
		liveCapabilities++;
		cancelIdle();
		let released = false;
		const owned = new Set<{ stop(): void }>();
		const admissible = (): boolean => !released && phase === "live";
		const commandOp = <T>(operation: (session: Manager) => Promise<T>): Promise<T> => {
			if (!admissible()) return Promise.reject(new Error("session is closed"));
			// Admission is promise-shaped: an operation that fails before
			// returning its promise rejects instead of escaping as a
			// synchronous throw (untracked) — the same idiom BridgeClient.call
			// uses for a transport that throws in `send`.
			let started: Promise<T>;
			try {
				started = Promise.resolve(operation(manager));
			} catch (error) {
				return Promise.reject(error instanceof Error ? error : new Error(String(error)));
			}
			const settle = started.then(
				() => undefined,
				() => undefined,
			);
			tracked.add(settle);
			void settle.then(() => tracked.delete(settle));
			return started;
		};
		const mutateOp = <T>(operation: (session: Manager) => Promise<T>): Promise<T> => {
			if (!admissible()) return Promise.reject(new Error("session is closed"));
			return mutations.run(() => operation(manager));
		};
		return {
			ref,
			authorization,
			cwd: manager.cwd,
			prompt: (text, images) => commandOp((session) => session.prompt(text, images)),
			abort: () => commandOp((session) => session.abort()),
			discardSteer: () => commandOp((session) => session.discardSteer()),
			setModel: (provider, modelId) => mutateOp((session) => session.setModel(provider, modelId)),
			setThinkingLevel: (level) => mutateOp((session) => session.setThinkingLevel(level)),
			renameSession: (name) => mutateOp((session) => session.renameSession(name)),
			setLabel: (entryId, label) => mutateOp((session) => session.setLabel(entryId, label)),
			navigate: (entryId) => mutateOp((session) => session.navigate(entryId)),
			recoverTurn: () => commandOp((session) => session.recoverTurn()),
			pull: (requests) =>
				commandOp((session) => {
					const out: PulledValue[] = [];
					for (const req of requests) {
						const entry = session.document.entries[req.entryId];
						if (!entry) continue;
						const value = resolveFieldPath(entry as unknown as Record<string, unknown>, req.fieldPath);
						if (value !== undefined) {
							out.push({
								entryId: req.entryId,
								fieldPath: req.fieldPath,
								value: value as JsonValue,
								live: !isEntrySealed(entry),
							});
						}
					}
					return Promise.resolve(out);
				}),
			command: commandOp,
			mutate: mutateOp,
			observe(observer: SessionObserver, cursor: PrefixCursor | null): ObservationCapability {
				// The registration check is synchronous with the installation: a
				// released capability, or one whose actor began closing, must not
				// install an observer nothing would ever remove.
				if (released || phase !== "live") throw new Error("session is closed");
				manager.addConnection(observer, ref, cursor);
				const record = installObservation(observer);
				owned.add(record);
				return {
					ref,
					release() {
						record.stop();
						owned.delete(record);
						return Promise.resolve();
					},
				};
			},
			release(): Promise<void> {
				if (released) return Promise.resolve();
				released = true;
				for (const record of owned) record.stop();
				owned.clear();
				liveCapabilities--;
				// The last client left: the actor's own lifetime decision begins.
				if (liveCapabilities === 0) armIdle();
				return Promise.resolve();
			},
		};
	};

	return {
		ref,
		authorization,
		get phase() {
			return phase;
		},
		metadata(): ActorMetadata {
			const doc = manager.document;
			const summary = documentSummary(doc);
			return {
				sessionFile: manager.sessionFile,
				createdAt: manager.createdAt,
				isStreaming: doc.status.isStreaming,
				name: doc.status.name || undefined,
				messageCount: doc.status.stats.messages || undefined,
				firstMessageText: summary.firstMessageText,
				lastMessageText: summary.lastMessageText,
				lastActivityAt: summary.lastActivityAt,
			};
		},
		capability,
		armIdle,
		close(): Promise<void> {
			if (closed !== undefined) return closed;
			// The terminal fact is synchronous: from here on every liveness
			// check refuses the actor even while its disposal is in flight.
			phase = "closing";
			cancelIdle();
			closed = (async () => {
				// Queued mutations reject instead of running against a disposing
				// runtime; the one still running settles first (mutations are
				// quick and never await a turn).
				await mutations.close();
				// Disposal aborts and finalizes the in-flight turn — which is
				// what settles the tracked work admitted against it — and drains
				// the git-stamp observation scope before the runtime goes, with
				// observers still installed so client tabs see the final patches.
				await manager.dispose();
				await Promise.allSettled([...tracked]);
				// Observers are released only after the drain: they owned delivery
				// of the teardown's final patches.
				for (const record of [...liveObservations]) record.stop();
				liveObservations.clear();
				phase = "closed";
			})();
			return closed;
		},
	};
}

/** Test seam: a capability over a hand-built Manager with no registry behind
 * it — always admissible, so tests exercise the Connection protocol and the
 * actor's admission ordering, not the registry. The capability never closes
 * the actor; the caller owns the runtime's disposal. */
export function issueDirectCapability(
	manager: Manager,
	ref: SessionRef,
	authorization: ActivationAuthorization = { incarnation: "test", generation: 1 },
): SessionCapability {
	return createSessionActor({ manager, ref, authorization }).capability();
}

// ── Listing summary (the daemon's preview derivation, owned here) ───────

const PREVIEW_MAX = 120;

/** Clamp text to one preview line. Exported for the daemon's durable-file
 * parser, which clamps the same way. */
export function clampPreview(text: string): string {
	const single = text.replace(/\s+/g, " ").trim();
	if (single.length <= PREVIEW_MAX) return single;
	return `${single.slice(0, PREVIEW_MAX - 1)}…`;
}

/** Launcher-facing summary derived from a live Document (an unflushed or
 * active Session): the first user text, the most recent user/assistant
 * message text, and the latest entry timestamp. Text is clamped to one
 * line. */
function documentSummary(doc: Document): {
	firstMessageText?: string;
	lastMessageText?: string;
	lastActivityAt?: string;
} {
	let first: string | undefined;
	let firstTs = "";
	let last: string | undefined;
	let lastTs: string | undefined;
	let lastActivityAt: string | undefined;
	for (const entry of Object.values(doc.entries)) {
		const ts = entry.timestamp ?? "";
		if (ts && (!lastActivityAt || ts > lastActivityAt)) lastActivityAt = ts;
		if (entry.kind !== "message") continue;
		const text = extractFirstText(entry.content);
		if (!text) continue;
		if (entry.role === "user" && (first === undefined || firstTs === "" || ts < firstTs)) {
			first = text;
			firstTs = ts;
		}
		if (lastTs === undefined || ts >= lastTs) {
			last = text;
			lastTs = ts;
		}
	}
	return {
		firstMessageText: first ? clampPreview(first) : undefined,
		lastMessageText: last ? clampPreview(last) : undefined,
		lastActivityAt,
	};
}

function extractFirstText(content: Content[]): string | undefined {
	for (const block of content) {
		if (block.type === "text" && block.text) return block.text;
	}
	return undefined;
}

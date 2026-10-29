// ============================================================================
// Navigation — the one owner of browser Session selection.
//
// Opening a Session, creating one, resolving the /@latest alias, showing a
// Project home, and leaving a view are *transitions*, not free-standing
// RPCs. A transition captures its target when it starts; its continuations
// use that capture instead of asking "which view is active now", so an older
// operation can never publish into a newer one's view.
//
// The reactor (src/core/reactor.ts) is the mechanism: one serialized mailbox
// over the navigation state. A step stages the target (optimistic address,
// route) and admits the open RPC as an effect carrying the message's epoch;
// the address-bearing initial-sync frame returns as a `sync` message and
// commits the view; the RPC reply returns as a `settled` message and either
// confirms or rolls back. A completion whose epoch no longer matches the
// pending transition is ignored with one comparison — the superseded-open
// race that previously needed a guard at every await.
//
// Division of labor: navigation owns selection (address, route, session id,
// the candidate mirror's promotion, and the cache base it seeds); the
// connection pipeline owns document publication and cache write-through
// mechanics; restoreLocalSession owns the cache-first paint and keeps its
// own store-based race guard (navigation maintains exactly the store
// invariants that guard reads: the address is staged before the RPC, and
// the session id lands only with the initial sync).
// ============================================================================

import type {
	BridgeClient,
	CacheEntryRecord,
	Document,
	PatchOp,
	PrefixCursor,
	SessionInfo,
	SessionRef,
	SessionStatusHint,
} from "../../../../src/core/index.ts";
import { computeCursor, createReactor, type Reactor, seedDocument } from "../../../../src/core/index.ts";
import { writeRoute } from "../lib/routes.ts";
import { lookupSessionId, rememberAddress } from "../persist/addressIndex.ts";
import { getEntryCache, prepareSwitch } from "../persist/entryCache.ts";
import { getStore } from "../state/store.tsx";
import { getGlobalClient } from "./client.ts";
import { resolveLatestSession } from "./latestSession.ts";
import { discardSessionCandidate, promoteSessionCandidate } from "./sessionCandidate.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NavigationView =
	| { kind: "launcher" }
	| { kind: "project"; projectId: string }
	| { kind: "session"; projectId: string; stem: string };

export interface NavigationTarget {
	projectId: string;
	stem: string;
}

/** The result an open/navigation caller awaits — the RPC's outcome, not the
 * commit decision (a superseded transition commits nothing by design). */
export interface NavigationResult {
	ok: boolean;
	error?: string;
}

interface PendingTransition {
	epoch: number;
	view: NavigationView & { kind: "session" };
	mode: "navigate" | "boot";
	/** The last committed view, restored when a navigate-mode open fails. */
	previous: { view: NavigationView; sessionId: string | null };
	synced: boolean;
}

interface NavigationState {
	/** The committed view and its durable session id (null until the
	 * initial sync establishes it). */
	current: { view: NavigationView; sessionId: string | null };
	/** At most one session-opening transition in flight. */
	pending: PendingTransition | null;
	/** The most recently superseded target: its initial sync may still arrive
	 * (the server serialized both transitions), and it must not commit over
	 * the successor. Server ordering means only the latest abandoned target
	 * can still deliver. */
	abandoned: { key: string } | null;
	/** The epoch of the last applied navigation intent (open, boot, latest,
	 * project, launcher). Effect completions compare against it so a
	 * superseded detach does not commit over a newer open. */
	intentEpoch: number;
}

type Reply = (result: NavigationResult) => void;

const NOT_CONNECTED: NavigationResult = { ok: false, error: "not connected" };

/** An RPC reply's error field is JsonValue on the wire; keep the navigation
 * result's error a string so callers can toast it directly. */
function errorMessage(value: unknown, fallback: string): string {
	return typeof value === "string" && value !== "" ? value : fallback;
}

type NavigationMessage =
	// User navigation: sidebar, history, alias button. `mode` distinguishes
	// the navigate staging (candidate switch, routes, rollback) from the boot
	// staging (mirror seeding, project fallback); the /@latest flow boots.
	| {
			kind: "open";
			view: NavigationView & { kind: "session" };
			sessionIdHint?: string;
			viaAlias?: boolean;
			mode?: "navigate" | "boot";
			reply?: Reply;
	  }
	// Route/reconnect-driven open (the URL already names the target).
	| { kind: "boot"; view: NavigationView & { kind: "session" }; viaAlias?: boolean; reply?: Reply }
	| { kind: "latest"; reply?: Reply }
	| { kind: "bootLatest"; reply?: Reply }
	| { kind: "project"; projectId: string; mode: "navigate" | "boot"; reply?: Reply }
	| { kind: "launcher"; mode: "navigate" | "boot"; reply?: Reply }
	// A newSession reply committed its address (the initial-sync push already
	// landed through the no-pending sync path; this re-asserts idempotently).
	| { kind: "created"; ref: SessionRef }
	// The host's terminal ownership push for an address.
	| { kind: "closed"; projectId: string; stem: string }
	// An address-bearing initial-sync frame (replace: ops null; cursor-aware
	// delta: ops set). Delivered by the connection pipeline.
	| { kind: "sync"; ref: SessionRef; ops: PatchOp[] | null }
	// Effect completions.
	| { kind: "openSettled"; epoch: number; result: NavigationResult; ref?: SessionRef }
	| { kind: "projectSettled"; epoch: number; projectId: string }
	| { kind: "launcherSettled"; epoch: number; result: NavigationResult }
	| { kind: "cleared" }
	| { kind: "noop" };

/** Injectable seams (tests supply fakes; production reads the globals). */
export interface NavigationDeps {
	getClient(): BridgeClient | null;
	lookupSessionId(projectId: string, stem: string): string | undefined;
	loadSession(sessionId: string): Promise<{ records: CacheEntryRecord[]; hint: SessionStatusHint | null }>;
	prepareSwitch(sessionId: string): Promise<PrefixCursor | undefined>;
	resolveLatest(client: BridgeClient): Promise<SessionInfo | null>;
}

const defaultDeps: NavigationDeps = {
	getClient: () => getGlobalClient(),
	lookupSessionId,
	loadSession: async (sessionId) => (await getEntryCache()).loadSession(sessionId),
	prepareSwitch,
	resolveLatest: (client) =>
		resolveLatestSession(client, getStore().getState().projects, getStore().getState().activeSessions),
};

// ---------------------------------------------------------------------------
// Cache base — the last cache-written document per session (ADR 09). Owned
// here because both halves of navigation seed it: the boot effect seeds the
// mirror's cache base, and promotion re-bases it on the candidate's
// pre-promotion document. The connection pipeline advances it on every delta
// write and re-establishes it on the replace repair path.
// ---------------------------------------------------------------------------

export const cacheBase: { value: { sessionId: string; doc: Document } | null } = { value: null };

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/** The user-navigation open: seed a candidate mirror from the target's cache
 * (ADR 09 switch preparation), then send the openSession RPC. */
function openEffect(
	view: NavigationView & { kind: "session" },
	sessionIdHint: string | undefined,
	epoch: number,
	reply: Reply | undefined,
	deps: NavigationDeps,
): { run(): Promise<NavigationMessage> } {
	return {
		run: async () => {
			const client = deps.getClient();
			if (!client) return settleOpen(epoch, reply, { result: NOT_CONNECTED });
			let cursor: PrefixCursor | undefined;
			const sessionId = sessionIdHint ?? deps.lookupSessionId(view.projectId, view.stem);
			if (sessionId) {
				try {
					cursor = await deps.prepareSwitch(sessionId);
				} catch {
					cursor = undefined;
				}
			}
			return settleOpen(epoch, reply, await openRpc(client, view, cursor));
		},
	};
}

/** The route/reconnect open: seed the live mirror and the store from the
 * cache (a reconnect reuses the richer in-memory document), derive a cursor,
 * and send the openSession RPC. A failure lands on the Project home. */
function bootEffect(
	view: NavigationView & { kind: "session" },
	epoch: number,
	reply: Reply | undefined,
	deps: NavigationDeps,
): { run(): Promise<NavigationMessage> } {
	return {
		run: async () => {
			const client = deps.getClient();
			if (!client) return settleOpen(epoch, reply, { result: NOT_CONNECTED });
			const store = getStore();
			const sessionId = deps.lookupSessionId(view.projectId, view.stem);
			let records: CacheEntryRecord[] = [];
			let hint: SessionStatusHint | null = null;
			if (sessionId) {
				try {
					({ records, hint } = await deps.loadSession(sessionId));
				} catch {
					// Cache read failure: plain open, full replace.
				}
			}
			const state = store.getState();
			const sameSession =
				sessionId !== undefined &&
				state.activeSessionId === sessionId &&
				Object.keys(state.document.entries).length > 0;
			const seed = sameSession ? state.document : seedDocument(records, hint ?? undefined);
			client.mirror.applyReplace(seed);
			if (sessionId !== undefined) cacheBase.value = { sessionId, doc: seed };
			if (!sameSession && records.length > 0) {
				store.getState().applyReplace(seed);
			}
			const cursor = computeCursor(records) ?? undefined;
			return settleOpen(epoch, reply, await openRpc(client, view, cursor));
		},
	};
}

async function openRpc(
	client: BridgeClient,
	view: NavigationView & { kind: "session" },
	cursor: PrefixCursor | undefined,
): Promise<{ result: NavigationResult; ref?: SessionRef }> {
	try {
		const rpc = await client.openSession(view.projectId, view.stem, cursor ?? undefined);
		if (rpc?.ok) {
			return { result: { ok: true }, ref: (rpc as unknown as { session?: SessionRef }).session };
		}
		return { result: { ok: false, error: errorMessage(rpc?.error, "open session failed") } };
	} catch (err) {
		return { result: { ok: false, error: err instanceof Error ? err.message : String(err) } };
	}
}

function settleOpen(
	epoch: number,
	reply: Reply | undefined,
	outcome: { result: NavigationResult; ref?: SessionRef },
): NavigationMessage {
	reply?.(outcome.result);
	return { kind: "openSettled", epoch, result: outcome.result, ref: outcome.ref };
}

/** Resolve the /@latest alias target (ADR 13): the most recently active live
 * Session, else the most recent durable Session across Projects. The
 * resolved target continues as an ordinary transition: a user alias press
 * stages like a navigate (it writes the alias route) but opens like a boot
 * (mirror seeding, Project-home fallback); a reconnect resolution boots
 * outright (the URL already holds the alias). */
function latestEffect(
	boot: boolean,
	reply: Reply | undefined,
	deps: NavigationDeps,
): { run(): Promise<NavigationMessage> } {
	return {
		run: async () => {
			const client = deps.getClient();
			if (!client) {
				if (boot) {
					reply?.({ ok: true });
					return { kind: "cleared" };
				}
				reply?.({ ok: false, error: "not connected" });
				return { kind: "noop" };
			}
			try {
				const row = await deps.resolveLatest(client);
				if (!row) {
					// Nothing to open: a boot lands on the Launcher (settled
					// once the landing applies); a user press is a silent
					// no-op (the old behavior).
					if (boot) {
						reply?.({ ok: true });
						return { kind: "cleared" };
					}
					reply?.({ ok: true });
					return { kind: "noop" };
				}
				const view = { kind: "session", projectId: row.projectId, stem: row.stem } as const;
				return boot
					? { kind: "boot", view, viaAlias: true, reply }
					: { kind: "open", view, viaAlias: true, mode: "boot", reply };
			} catch {
				if (boot) {
					reply?.({ ok: true });
					return { kind: "cleared" };
				}
				reply?.({ ok: true });
				return { kind: "noop" };
			}
		},
	};
}

/** Release the server-side attachment (the Project-home / Launcher
 * transitions). The outcome reports to the caller; the commit decision is
 * navigation's. */
function detachEffect(
	epoch: number,
	reply: Reply | undefined,
	deps: NavigationDeps,
): { run(): Promise<NavigationMessage> } {
	return {
		run: async () => {
			const client = deps.getClient();
			if (!client) {
				const result = { ok: false, error: "not connected" };
				reply?.(result);
				return { kind: "launcherSettled", epoch, result };
			}
			let result: NavigationResult = { ok: true };
			try {
				const rpc = await client.detach();
				result = rpc?.ok ? { ok: true } : { ok: false, error: errorMessage(rpc?.error, "detach failed") };
			} catch (err) {
				result = { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
			reply?.(result);
			return { kind: "launcherSettled", epoch, result };
		},
	};
}

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

function sessionKey(view: NavigationView): string {
	return view.kind === "session" ? `${view.projectId}/${view.stem}` : "";
}

/** Commit an address-bearing initial sync: address first, then the id
 * (`setCurrentSession` unbinds a stale id on an address change, so the pair
 * must land in this order), remember the address, and write the route unless
 * the alias view holds it (ADR 13). */
function commitSessionAddress(ref: SessionRef): void {
	const store = getStore();
	store.getState().setCurrentSession(ref.projectId, ref.stem);
	store.getState().setActiveSessionId(ref.sessionId);
	rememberAddress(ref.projectId, ref.stem, ref.sessionId);
	if (!store.getState().addressViaAlias) {
		writeRoute({ kind: "session", projectId: ref.projectId, stem: ref.stem });
	}
}

/** Restore a committed view after a failed navigate-mode open: the address,
 * the session id, and the route all describe the view the client actually
 * holds server-side. */
function restoreView(previous: { view: NavigationView; sessionId: string | null }): void {
	const store = getStore();
	if (previous.view.kind === "session") {
		store.getState().setCurrentSession(previous.view.projectId, previous.view.stem);
	} else if (previous.view.kind === "project") {
		store.getState().setCurrentSession(previous.view.projectId, null);
	} else {
		store.getState().setCurrentSession(null, null);
	}
	store.getState().setActiveSessionId(previous.sessionId);
	if (previous.view.kind === "session") {
		writeRoute({ kind: "session", projectId: previous.view.projectId, stem: previous.view.stem });
	} else if (previous.view.kind === "project") {
		writeRoute({ kind: "project", projectId: previous.view.projectId });
	} else {
		writeRoute({ kind: "launcher" });
	}
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

function navigationStep(
	state: NavigationState,
	message: NavigationMessage,
	context: { epoch: number; send(message: NavigationMessage): void },
	deps: NavigationDeps,
): { state: NavigationState; effects?: Array<{ run(): Promise<NavigationMessage> }> } {
	switch (message.kind) {
		case "open":
		case "boot": {
			const viaAlias = message.viaAlias === true;
			// `mode` picks the failure fallback: navigate restores the last
			// committed view; boot lands on the Project home. The effect kind
			// follows it — an alias press stages like a navigate but opens like
			// a boot — while `kind` alone decides whether staging writes the
			// route (a user navigation publishes its URL; a boot's URL already
			// names the target).
			const mode: "navigate" | "boot" = message.kind === "open" ? (message.mode ?? "navigate") : "boot";
			const effectKind: "open" | "boot" = message.kind === "boot" || mode === "boot" ? "boot" : "open";
			const store = getStore();
			// A superseded transition never committed; remember its target so
			// its late initial sync cannot commit over the successor.
			const abandoned = state.pending ? { key: sessionKey(state.pending.view) } : state.abandoned;
			const pending: PendingTransition = {
				epoch: context.epoch,
				view: message.view,
				mode,
				previous: state.current,
				synced: false,
			};
			// Optimistic staging: the address (and, for user navigation, the
			// route) names the target before the RPC resolves.
			if (viaAlias) store.getState().setAddressViaAlias(true);
			else store.getState().setAddressViaAlias(false);
			store.getState().setCurrentSession(message.view.projectId, message.view.stem);
			if (message.kind === "open") {
				if (viaAlias) writeRoute({ kind: "alias", alias: "latest" });
				else writeRoute({ kind: "session", projectId: message.view.projectId, stem: message.view.stem });
			}
			const effect =
				effectKind === "boot" || message.kind === "boot"
					? bootEffect(message.view, context.epoch, message.reply, deps)
					: openEffect(message.view, message.sessionIdHint, context.epoch, message.reply, deps);
			return { state: { ...state, pending, abandoned, intentEpoch: context.epoch }, effects: [effect] };
		}

		case "latest":
		case "bootLatest":
			return {
				state,
				effects: [latestEffect(message.kind === "bootLatest", message.reply, deps)],
			};

		case "project": {
			if (message.mode === "boot") {
				// The URL already names the Project home; nothing to detach.
				getStore().getState().setCurrentSession(message.projectId, null);
				return {
					state: {
						...state,
						current: { view: { kind: "project", projectId: message.projectId }, sessionId: null },
						intentEpoch: context.epoch,
					},
				};
			}
			const wasSession = state.current.view.kind === "session";
			const epoch = context.epoch;
			const effect: { run(): Promise<NavigationMessage> } = {
				run: async () => {
					const client = deps.getClient();
					if (client && wasSession) {
						try {
							const rpc = await client.detach();
							message.reply?.(
								rpc?.ok ? { ok: true } : { ok: false, error: errorMessage(rpc?.error, "detach failed") },
							);
						} catch (err) {
							// A failed detach reports to the caller, but the
							// Project home commits regardless (the old behavior:
							// the address change is not conditional on it).
							message.reply?.({ ok: false, error: err instanceof Error ? err.message : String(err) });
						}
					} else {
						message.reply?.({ ok: true });
					}
					return { kind: "projectSettled", epoch, projectId: message.projectId };
				},
			};
			return { state: { ...state, intentEpoch: context.epoch }, effects: [effect] };
		}

		case "launcher": {
			if (message.mode === "boot") {
				getStore().getState().clearCurrentSession();
				writeRoute({ kind: "launcher" });
				return {
					state: {
						...state,
						current: { view: { kind: "launcher" }, sessionId: null },
						intentEpoch: context.epoch,
					},
				};
			}
			return {
				state: { ...state, intentEpoch: context.epoch },
				effects: [detachEffect(context.epoch, message.reply, deps)],
			};
		}

		case "created": {
			// The initial-sync push committed the address through the
			// no-pending sync path; re-assert idempotently for the reply path.
			commitSessionAddress(message.ref);
			return {
				state: {
					...state,
					current: {
						view: { kind: "session", projectId: message.ref.projectId, stem: message.ref.stem },
						sessionId: message.ref.sessionId,
					},
				},
			};
		}

		case "closed": {
			// The rendered Session's runtime ended: the document can never
			// progress again, so the address, the session id, and the route all
			// go, retaining the Project to land on its home. A close of some
			// other Session changes nothing here. The rendered address is a
			// store-level fact (the committed view's publication).
			const s = getStore().getState();
			if (s.currentProjectId === message.projectId && s.currentStem === message.stem) {
				s.clearCurrentSession(message.projectId);
				writeRoute({ kind: "project", projectId: message.projectId });
				return {
					state: {
						...state,
						current: { view: { kind: "project", projectId: message.projectId }, sessionId: null },
					},
				};
			}
			return { state };
		}

		case "sync": {
			const ref = message.ref;
			const pending = state.pending;
			if (pending !== null) {
				const matches = pending.view.projectId === ref.projectId && pending.view.stem === ref.stem;
				if (!matches) {
					// A superseded transition's initial sync: the server
					// serialized both opens, and this one lost. It commits
					// nothing; the successor's sync follows on the wire.
					return { state };
				}
				if (message.ops !== null) {
					// Promote the candidate the open seeded: the mirror's own
					// application of this delta ran against the old-session
					// base and is discarded (ADR 09).
					const promoted = promoteSessionCandidate(ref.sessionId, message.ops);
					if (promoted) {
						deps.getClient()?.mirror.applyReplace(promoted.doc);
						cacheBase.value = { sessionId: ref.sessionId, doc: promoted.before };
					}
				}
				commitSessionAddress(ref);
				return {
					state: {
						...state,
						current: { view: pending.view, sessionId: ref.sessionId },
						pending: { ...pending, synced: true },
					},
				};
			}
			// No pending transition: a newSession's initial sync (its reply
			// commits through `created`), or a re-assert. A superseded target's
			// sync must not commit over the successor.
			if (state.abandoned !== null && state.abandoned.key === `${ref.projectId}/${ref.stem}`) {
				return { state };
			}
			commitSessionAddress(ref);
			return {
				state: {
					...state,
					current: {
						view: { kind: "session", projectId: ref.projectId, stem: ref.stem },
						sessionId: ref.sessionId,
					},
				},
			};
		}

		case "openSettled": {
			const pending = state.pending;
			if (pending === null || pending.epoch !== message.epoch) {
				// Superseded: the successor owns the view; the reply already
				// fired from the effect.
				return { state };
			}
			discardSessionCandidate();
			if (message.result.ok) {
				// The push precedes the reply, so the sync already committed;
				// commit defensively only if it somehow did not.
				if (!pending.synced && message.ref) commitSessionAddress(message.ref);
				return {
					state: {
						...state,
						pending: null,
						current: {
							view: pending.view,
							sessionId: message.ref?.sessionId ?? state.current.sessionId,
						},
					},
				};
			}
			if (pending.mode === "boot") {
				// A boot failure lands on the Project home (ADR 11): the stem no
				// longer resolves, so the staged address and identity must go.
				getStore().getState().setAddressViaAlias(false);
				getStore().getState().clearCurrentSession(pending.view.projectId);
				writeRoute({ kind: "project", projectId: pending.view.projectId });
				return {
					state: {
						...state,
						pending: null,
						current: { view: { kind: "project", projectId: pending.view.projectId }, sessionId: null },
					},
				};
			}
			// A navigate failure restores the last committed view: the server
			// left the previous attachment untouched, so the client must not
			// claim the new address either.
			restoreView(pending.previous);
			return { state: { ...state, pending: null, current: pending.previous } };
		}

		case "projectSettled": {
			if (state.intentEpoch !== message.epoch) return { state };
			const store = getStore();
			store.getState().setAddressViaAlias(false);
			store.getState().setCurrentSession(message.projectId, null);
			writeRoute({ kind: "project", projectId: message.projectId });
			return {
				state: { ...state, current: { view: { kind: "project", projectId: message.projectId }, sessionId: null } },
			};
		}

		case "launcherSettled": {
			if (state.intentEpoch !== message.epoch) return { state };
			if (!message.result.ok) return { state };
			discardSessionCandidate();
			const store = getStore();
			store.getState().setAddressViaAlias(false);
			store.getState().clearCurrentSession();
			writeRoute({ kind: "launcher" });
			return { state: { ...state, current: { view: { kind: "launcher" }, sessionId: null } } };
		}

		case "cleared": {
			getStore().getState().clearCurrentSession();
			writeRoute({ kind: "launcher" });
			return { state: { ...state, current: { view: { kind: "launcher" }, sessionId: null } } };
		}

		case "noop":
			return { state };
	}
}

// ---------------------------------------------------------------------------
// Runtime singleton + wiring
// ---------------------------------------------------------------------------

interface NavigationRuntime {
	reactor: Reactor<NavigationState, NavigationMessage>;
	deps: NavigationDeps;
}

function createRuntime(deps: NavigationDeps): NavigationRuntime {
	const runtime = {} as NavigationRuntime;
	runtime.deps = deps;
	runtime.reactor = createReactor<NavigationState, NavigationMessage>({
		initial: {
			current: { view: { kind: "launcher" }, sessionId: null },
			pending: null,
			abandoned: null,
			intentEpoch: 0,
		},
		step: (state, message, context) => navigationStep(state, message, context, runtime.deps),
		onUnhandledEffectError: (error) => {
			console.error("navigation effect failed", error);
		},
	});
	return runtime;
}

let runtime: NavigationRuntime = createRuntime(defaultDeps);

/** Test seam: a fresh navigation (reset state) with optional dep overrides.
 * Also clears the cache base and any pending candidate. */
export function resetNavigationForTests(deps?: Partial<NavigationDeps>): void {
	runtime = createRuntime({ ...defaultDeps, ...deps });
	cacheBase.value = null;
	discardSessionCandidate();
}

function settled(promise: Promise<NavigationResult>): Promise<NavigationResult> {
	return promise.catch(() => ({ ok: false, error: "navigation closed" }));
}

/** Open a Session by address (user navigation). Resolves with the RPC
 * outcome; the view commit and any rollback are the reactor's. */
export function navigationOpen(
	target: NavigationTarget,
	options: { sessionId?: string } = {},
): Promise<NavigationResult> {
	return settled(
		new Promise<NavigationResult>((resolve) => {
			void runtime.reactor.send({
				kind: "open",
				view: { kind: "session", projectId: target.projectId, stem: target.stem },
				sessionIdHint: options.sessionId,
				reply: resolve,
			});
		}),
	);
}

/** Open the route's Session (boot/reconnect). Resolves when the transition
 * settles — the fallback, if any, has been applied. */
export function navigationBoot(target: NavigationTarget): Promise<NavigationResult> {
	return settled(
		new Promise<NavigationResult>((resolve) => {
			void runtime.reactor.send({
				kind: "boot",
				view: { kind: "session", projectId: target.projectId, stem: target.stem },
				reply: resolve,
			});
		}),
	);
}

/** Open the `/@latest` alias (user action): resolve, then boot the target
 * without leaving the alias URL. */
export function navigationLatest(): Promise<NavigationResult> {
	return settled(
		new Promise<NavigationResult>((resolve) => {
			void runtime.reactor.send({ kind: "latest", reply: resolve });
		}),
	);
}

/** Resolve the alias at boot/reconnect: with no target, land on the
 * Launcher. Resolves when the resolved target's transition settles (or the
 * Launcher landing is applied), so a caller gates "connected" on the same
 * completion the old boot path had. */
export function navigationBootLatest(): Promise<NavigationResult> {
	return settled(
		new Promise<NavigationResult>((resolve) => {
			void runtime.reactor.send({ kind: "bootLatest", reply: resolve });
		}),
	);
}

/** Show a Project home. Navigate mode releases the server-side attachment
 * first (the commit is not conditional on it, matching the old behavior);
 * boot mode commits immediately (the URL already names it). */
export function navigationProject(
	projectId: string,
	mode: "navigate" | "boot" = "navigate",
): Promise<NavigationResult> {
	if (mode === "boot") {
		// Commits synchronously in the step; the send resolves once applied.
		return runtime.reactor.send({ kind: "project", projectId, mode }).then(
			() => ({ ok: true }) as NavigationResult,
			() => ({ ok: false, error: "navigation closed" }),
		);
	}
	return settled(
		new Promise<NavigationResult>((resolve) => {
			void runtime.reactor.send({ kind: "project", projectId, mode, reply: resolve });
		}),
	);
}

/** Leave to the Launcher. Navigate mode detaches server-side first and
 * commits only on a successful detach; boot mode clears immediately. */
export function navigationLauncher(mode: "navigate" | "boot" = "navigate"): Promise<NavigationResult> {
	if (mode === "boot") {
		// Commits synchronously in the step; the send resolves once applied.
		return runtime.reactor.send({ kind: "launcher", mode }).then(
			() => ({ ok: true }) as NavigationResult,
			() => ({ ok: false, error: "navigation closed" }),
		);
	}
	return settled(
		new Promise<NavigationResult>((resolve) => {
			void runtime.reactor.send({ kind: "launcher", mode, reply: resolve });
		}),
	);
}

/** Commit a newly created Session's address (the newSession reply path). */
export function navigationCreated(ref: SessionRef): void {
	void runtime.reactor.send({ kind: "created", ref }).catch(() => {});
}

/** The host's `session_closed` push: terminal ownership for an address. */
export function navigationSessionClosed(projectId: string, stem: string): void {
	void runtime.reactor.send({ kind: "closed", projectId, stem }).catch(() => {});
}

/** An address-bearing initial-sync frame (replace or cursor-aware delta),
 * delivered by the connection pipeline after the mirror applied it. */
export function navigationInitialSync(ref: SessionRef, ops: PatchOp[] | null): void {
	void runtime.reactor.send({ kind: "sync", ref, ops }).catch(() => {});
}

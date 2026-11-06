// ============================================================================
// Navigation — the browser view actor (ADR 19): the one owner of browser
// Session selection.
//
// Opening a Session, creating one, resolving the /@latest alias, showing a
// Project home, and leaving a view are *transitions*, not free-standing
// RPCs. A transition captures its target when it starts; its continuations
// use that capture instead of asking "which view is active now", so an older
// operation can never publish into a newer one's view.
//
// The reactor (src/core/reactor.ts) is the mechanism: one serialized mailbox
// over the navigation state. The authority rule is one sentence:
//
//   a step may read and write anything; an effect may only observe and
//   return a message.
//
// Effects fetch — the target's cached prefix, the alias target, the open RPC,
// the detach RPC — and return their outcome as a completion message that
// settles the caller. Every mutation of store, mirror, candidate, cache
// base, route, or address happens in a step, where the message's epoch is
// available. A completion whose epoch no longer names the current intent or
// the pending transition is ignored with one comparison.
//
// An opening transition is two-phase because seeding must precede the RPC:
// the server pushes the initial-sync frame before the RPC reply, and the
// candidate document (navigate) or the live mirror (boot) must already hold
// the cached prefix when that frame applies. `prepared` also paints that
// cached prefix into the store for a navigate (the instant switch): the
// switch shows the target's last-known state immediately, unconfirmed (the
// loading continuation renders in place of any wire claim), and a failed
// navigate repaints the previous view's document — the mirror still holds
// the last committed view's root, since candidates promote only at commit.
// The intent message stages the address optimistically and admits a
// value-only prepare effect; `prepared` seeds in the step and admits the
// open RPC effect; the address-bearing initial-sync frame returns as a
// `sync` message and commits the view; the RPC reply returns as
// `openSettled` and confirms or rolls back.
//
// Admission is gated by intent ownership, not just completion filtering: a
// superseded prepare sends no RPC at all. The server serializes attachment
// transitions in arrival order, so a late RPC from an abandoned intent could
// attach the abandoned session after the successor's command ran — the
// connection would end up attached to a session the UI no longer shows. The
// superseded caller settles client-side (nothing ran, nothing failed); an
// RPC admitted before the supersede runs to completion, and its settlement
// commits nothing. A transition cancelled by a terminal close admits no RPC
// either.
//
// Division of labor: navigation owns selection (address, route, session id,
// the candidate's seeding and promotion, the cache-first paint decision,
// and the cache base); the connection pipeline owns document publication
// and cache write-through mechanics, reading and advancing the cache base
// through the exported functions below. Every read and write of published
// state goes through the view port (`viewPort.ts`, ADR 19): the port is the
// complete inventory of the actor's inputs (what the last decision
// published) and outputs (the decisions themselves), so the store, the
// route, and the address index are one adapter's mechanics, not scattered
// reach-throughs. restoreLocalSession (sessionBoot) is value-only: it
// returns the seed, and the `localSeed` step decides whether the values
// become visible — the race guard reads the port's own publications (the
// address is staged before the RPC, and the session id lands only with the
// initial sync).
// ============================================================================

import type {
	BridgeClient,
	CacheEntryRecord,
	Document,
	ImageContent,
	ModelRef,
	PatchOp,
	PrefixCursor,
	SessionInfo,
	SessionRef,
	SessionStatusHint,
} from "../../../../src/core/index.ts";
import {
	computeCursor,
	createReactor,
	type Reactor,
	type ReactorEffect,
	seedDocument,
} from "../../../../src/core/index.ts";
import { lookupSessionId } from "../persist/addressIndex.ts";
import { getEntryCache } from "../persist/entryCache.ts";
import { getStore } from "../state/store.ts";
import { getGlobalClient } from "./client.ts";
import { resolveLatestSession } from "./latestSession.ts";
import type { LocalSessionSeed } from "./sessionBoot.ts";
import { promoteCandidate, type SessionCandidate } from "./sessionCandidate.ts";
import type { ViewObservationEvent } from "./viewEvents.ts";
import { createNavigationViewPort, type NavigationViewPort } from "./viewPort.ts";

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
	/** True when the transition was superseded by a newer intent before it
	 * could send anything: nothing ran and nothing failed — the newer intent
	 * owns the view. Callers treat it as a silent no-op, not an error. */
	superseded?: boolean;
}

/** The cached prefix a prepare effect read for the transition's target.
 * Message-carried: the seeding step (not the effect) turns it into the
 * candidate document or the mirror seed. */
interface SessionSeed {
	sessionId: string;
	records: CacheEntryRecord[];
	hint: SessionStatusHint | null;
}

interface PendingTransition {
	/** Identity for completion matching (`prepared`/`openSettled` name it). */
	id: number;
	/** Epoch of the intent message that staged this transition. The
	 * transition may mutate the committed view only while it is still the
	 * newest intent (`state.intentEpoch === intentEpoch`). */
	intentEpoch: number;
	/** Epoch of the `prepared` message that admitted the open RPC; null
	 * while the prepare effect is still in flight. */
	openEpoch: number | null;
	view: NavigationView & { kind: "session" };
	mode: "navigate" | "boot";
	viaAlias: boolean;
	/** The last committed view, restored when a navigate-mode open fails. */
	previous: { view: NavigationView; sessionId: string | null };
	/** Settles the caller when the transition's RPC settles (the effect
	 * fires it; a cancel that lands first wins, later fires no-op). */
	reply: Reply | undefined;
	synced: boolean;
}

interface NavigationState {
	/** The committed view and its durable session id (null until the
	 * initial sync establishes it). */
	current: { view: NavigationView; sessionId: string | null };
	/** At most one session-opening transition in flight. */
	pending: PendingTransition | null;
	/** The candidate document seeded for the pending transition (ADR 09).
	 * Transition state, written only by steps — seeded by `prepared`,
	 * consumed by the promoting `sync`, discarded at settlement. */
	candidate: SessionCandidate | null;
	/** The most recently superseded or closed target whose late initial sync
	 * may still arrive; it must not commit over the successor. Server
	 * ordering means only the latest abandoned target can still deliver. */
	abandoned: { key: string } | null;
	/** The current creation intent, if any: the operation id of the newest
	 * `newSession` transition and the epoch it was admitted under. A
	 * creation's initial sync carries its operation id, so the sync commits
	 * only while this intent is still the newest one. */
	creation: { operationId: string; intentEpoch: number } | null;
	/** The attachment generation of the committed observation (ADR 19): the
	 * generation of the initial-sync frame that committed the current view.
	 * A frame from another generation — an older attachment on this socket —
	 * never re-asserts the view and a stale close never ends it, even when
	 * the address is unchanged. Null before the first committed sync (a
	 * seeded or restored view). */
	committedGeneration: number | null;
	/** The epoch of the last applied navigation intent (open, boot, latest,
	 * bootLatest, project, launcher). The newest intent owns view mutations:
	 * every commit point compares against it. */
	intentEpoch: number;
	/** Transitions cancelled by a terminal close: the caller settled at
	 * cancel time, and the transition's prepare must not admit an RPC (the
	 * server runtime it targeted is gone). Pruned when the transition's own
	 * completion arrives. */
	cancelled: Set<number>;
}

type Reply = (result: NavigationResult) => void;

const NOT_CONNECTED: NavigationResult = { ok: false, error: "not connected" };

/** An RPC reply's error field is JsonValue on the wire; keep the navigation
 * result's error a string so callers can toast it directly. */
function errorMessage(value: unknown, fallback: string): string {
	return typeof value === "string" && value !== "" ? value : fallback;
}

function errorText(error: unknown, fallback: string): string {
	return error instanceof Error && error.message !== "" ? error.message : fallback;
}

type NavigationMessage =
	// User navigation: sidebar, history, alias button. `mode` distinguishes
	// the navigate staging (candidate switch, rollback) from the boot
	// staging (mirror seeding, Project-home fallback); the `@latest` flow
	// stages with boot semantics after its resolution.
	| {
			kind: "open";
			view: NavigationView & { kind: "session" };
			sessionIdHint?: string;
			mode?: "navigate" | "boot";
			reply?: Reply;
	  }
	// Route/reconnect-driven open (the URL already names the target).
	| { kind: "boot"; view: NavigationView & { kind: "session" }; reply?: Reply }
	// Alias resolution (user press / boot-reconnect). The completion of the
	// lookup effect: it carries the epoch of the intent that started it, so
	// a resolution that lands after a newer intent commits nothing. The alias's
	// scope is part of the intent: the root form spans Projects, a Project's
	// `@latest` resolves inside it.
	| { kind: "latest"; aliasProjectId: string | null; reply?: Reply }
	| { kind: "bootLatest"; aliasProjectId: string | null; reply?: Reply }
	| {
			kind: "latestResolved";
			epoch: number;
			boot: boolean;
			aliasProjectId: string | null;
			target: SessionInfo | null;
			reply?: Reply;
	  }
	// Cache-prepare completion: carries the transition it belongs to, the
	// target it captured at staging, and the cached prefix it read. The step
	// seeds (or, when superseded, settles the caller and admits nothing —
	// see the admission gate) and admits the open RPC for the owning
	// transition only.
	| {
			kind: "prepared";
			transition: number;
			view: NavigationView & { kind: "session" };
			reply: Reply | undefined;
			seed: SessionSeed | null;
	  }
	// The open RPC's completion.
	| { kind: "openSettled"; transition: number; result: NavigationResult; ref?: SessionRef }
	| { kind: "project"; projectId: string; mode: "navigate" | "boot"; reply?: Reply }
	| { kind: "projectSettled"; epoch: number; projectId: string }
	| { kind: "launcher"; mode: "navigate" | "boot"; reply?: Reply }
	| { kind: "launcherSettled"; epoch: number; result: NavigationResult }
	// A creation intent (the newSession verb): the operation id is minted
	// here, recorded as the current creation, and carried by the RPC effect.
	// The server's reply and the transition's initial-sync frame both carry
	// it back, so both can be attributed to the intent that admitted them.
	| {
			kind: "create";
			projectId: string;
			text: string;
			operationId: string;
			images?: ImageContent[];
			model?: ModelRef;
			thinkingLevel?: string;
			reply?: Reply;
	  }
	// The creation RPC's completion.
	| { kind: "createSettled"; operationId: string; result: NavigationResult; ref?: SessionRef }
	// The host's terminal ownership push for an address, carrying the
	// attachment generation it severed (ADR 19) — required on every
	// observation frame.
	| { kind: "closed"; projectId: string; stem: string; generation: number }
	// An address-bearing initial-sync frame (replace: ops null; cursor-aware
	// delta: ops set), delivered by the connection pipeline as a typed
	// observation event. `operationId` is present when the frame was emitted
	// by a newSession transition; `generation` names the attachment whose
	// stream the frame belongs to (ADR 19) and is required on every
	// observation frame.
	| {
			kind: "sync";
			ref: SessionRef;
			ops: PatchOp[] | null;
			operationId?: string;
			generation: number;
	  }
	// A cache-first local restore completed (ADR 09, value-only per ADR 19):
	// the values the cache read produced. The actor decides whether they
	// become visible — the restore itself writes nothing.
	| { kind: "localSeed"; seed: LocalSessionSeed };

/** Injectable seams (tests supply fakes; production reads the globals). The
 * port is the actor's complete store/route/index surface — every read and
 * write of published state goes through it (ADR 19). */
export interface NavigationDeps {
	getClient(): BridgeClient | null;
	port: NavigationViewPort;
	lookupSessionId(projectId: string, stem: string): string | undefined;
	loadSession(sessionId: string): Promise<{ records: CacheEntryRecord[]; hint: SessionStatusHint | null }>;
	resolveLatest(client: BridgeClient, projectId: string | null): Promise<SessionInfo | null>;
}

const defaultDeps: NavigationDeps = {
	getClient: () => getGlobalClient(),
	port: createNavigationViewPort(),
	lookupSessionId,
	loadSession: async (sessionId) => (await getEntryCache()).loadSession(sessionId),
	// The alias resolution's default reads the directory slices the store
	// holds (projects, active sessions) — directory input, not view
	// authority; the seam itself is injectable.
	resolveLatest: (client, projectId) =>
		resolveLatestSession(client, getStore().getState().projects, getStore().getState().queue, projectId),
};

// ---------------------------------------------------------------------------
// Cache base — the last cache-written document per session (ADR 09). Owned
// here because both halves of navigation seed it: the boot seeding installs
// the mirror's cache base, and promotion re-bases it on the candidate's
// pre-promotion document. The connection pipeline advances it on every delta
// write and re-establishes it on the replace repair path.
// ---------------------------------------------------------------------------

const cacheBase: { value: { sessionId: string; doc: Document } | null } = { value: null };

/** The document the last cache write for `sessionId` was planned against —
 * the pipeline's write-through base. The fallback is status-only: a session
 * with no base yet has nothing committed to plan a delta against. */
export function cacheBaseDocFor(sessionId: string, fallbackStatus: Document["status"]): Document {
	return cacheBase.value !== null && cacheBase.value.sessionId === sessionId
		? cacheBase.value.doc
		: { status: fallbackStatus, entries: {} };
}

/** Advance the cache base to the document the pipeline just wrote through:
 * the next delta plans against it (ADR 09). */
export function advanceCacheBase(sessionId: string, doc: Document): void {
	cacheBase.value = { sessionId, doc };
}

/** The current cache base (tests and diagnostics). */
export function currentCacheBase(): { sessionId: string; doc: Document } | null {
	return cacheBase.value;
}

// ---------------------------------------------------------------------------
// Effects — value-only. Each observes and returns a completion message, and
// settles its caller on every path (a promise resolves once, so a cancel
// that settled the caller first makes the later fire a no-op). No effect
// writes store, mirror, candidate, route, or address state.
// ---------------------------------------------------------------------------

/**
 * The cache-prepare effect for an opening transition: read the target's
 * cached prefix (records + status hint). Value-only — the seeding that uses
 * this data happens in the `prepared` step, where the epoch is available.
 */
function prepareEffect(
	view: NavigationView & { kind: "session" },
	sessionIdHint: string | undefined,
	transition: number,
	reply: Reply | undefined,
	deps: NavigationDeps,
): ReactorEffect<NavigationMessage> {
	return {
		run: async () => {
			try {
				const sessionId = sessionIdHint ?? deps.lookupSessionId(view.projectId, view.stem);
				let seed: SessionSeed | null = null;
				if (sessionId) {
					try {
						const { records, hint } = await deps.loadSession(sessionId);
						seed = { sessionId, records, hint };
					} catch {
						seed = null; // cache read failure: plain open, full replace
					}
				}
				return { kind: "prepared", transition, view, reply, seed };
			} catch (error) {
				// Effect bug: settle the caller and fail the transition — the
				// step rolls back or lands on the Project home.
				const result: NavigationResult = { ok: false, error: errorText(error, "navigation failed") };
				reply?.(result);
				return { kind: "openSettled", transition, result };
			}
		},
	};
}

/** The open RPC effect. Value-only: sends the RPC and returns its outcome;
 * the commit, the rollback, and the fallback are the step's. */
function openRpcEffect(
	client: BridgeClient,
	view: NavigationView & { kind: "session" },
	cursor: PrefixCursor | undefined,
	transition: number,
	reply: Reply | undefined,
): ReactorEffect<NavigationMessage> {
	return {
		run: async () => {
			try {
				const rpc = await client.openSession(view.projectId, view.stem, cursor);
				if (rpc?.ok) {
					const result: NavigationResult = { ok: true };
					reply?.(result);
					return {
						kind: "openSettled",
						transition,
						result,
						ref: (rpc as unknown as { session?: SessionRef }).session,
					};
				}
				const result: NavigationResult = { ok: false, error: errorMessage(rpc?.error, "open session failed") };
				reply?.(result);
				return { kind: "openSettled", transition, result };
			} catch (error) {
				const result: NavigationResult = { ok: false, error: errorText(error, "open session failed") };
				reply?.(result);
				return { kind: "openSettled", transition, result };
			}
		},
	};
}

/** The creation RPC effect (the newSession verb). Value-only: sends the
 * RPC carrying the creation's operation id and returns its outcome — the
 * server stamps the same id onto the transition's initial-sync frame, so
 * the commit decision in the step can attribute both. */
function createRpcEffect(
	client: BridgeClient,
	message: NavigationMessage & { kind: "create" },
): ReactorEffect<NavigationMessage> {
	const { projectId, text, operationId, images, model, thinkingLevel, reply } = message;
	return {
		run: async () => {
			try {
				const rpc = await client.newSession(projectId, text, { operationId, images, model, thinkingLevel });
				if (rpc?.ok) {
					const result: NavigationResult = { ok: true };
					reply?.(result);
					return {
						kind: "createSettled",
						operationId,
						result,
						ref: (rpc as unknown as { session?: SessionRef }).session,
					};
				}
				const result: NavigationResult = { ok: false, error: errorMessage(rpc?.error, "new session failed") };
				reply?.(result);
				return { kind: "createSettled", operationId, result };
			} catch (error) {
				const result: NavigationResult = { ok: false, error: errorText(error, "new session failed") };
				reply?.(result);
				return { kind: "createSettled", operationId, result };
			}
		},
	};
}

/** Resolve the `@latest` alias target (ADR 13) inside its scope: the most
 * recently active live Session in scope, else the most recent durable Session
 * there. Value-only: the resolution returns as a completion carrying the epoch
 * of the intent that started it, so a lookup that lands after a newer intent is
 * ignored by one comparison — it cannot re-enter as a fresh intent. */
function latestEffect(
	boot: boolean,
	aliasProjectId: string | null,
	epoch: number,
	reply: Reply | undefined,
	deps: NavigationDeps,
): ReactorEffect<NavigationMessage> {
	return {
		run: async () => {
			// Every path settles the caller: with no target (or a lookup
			// failure) a boot lands on its scope and a user press is a
			// silent no-op (the old behavior); with a target, the reply
			// settles at the staged transition's own settlement.
			try {
				const client = deps.getClient();
				if (!client) {
					reply?.({ ok: true });
					return { kind: "latestResolved", epoch, boot, aliasProjectId, target: null, reply };
				}
				try {
					const row = await deps.resolveLatest(client, aliasProjectId);
					return { kind: "latestResolved", epoch, boot, aliasProjectId, target: row, reply };
				} catch {
					reply?.({ ok: true });
					return { kind: "latestResolved", epoch, boot, aliasProjectId, target: null, reply };
				}
			} catch {
				reply?.({ ok: true });
				return { kind: "latestResolved", epoch, boot, aliasProjectId, target: null, reply };
			}
		},
	};
}

/** Release the server-side attachment (the Project-home / Launcher
 * transitions). Value-only: the outcome settles the caller; the commit
 * decision is the step's. */
function detachEffect(epoch: number, reply: Reply | undefined, deps: NavigationDeps): ReactorEffect<NavigationMessage> {
	return {
		run: async () => {
			const client = deps.getClient();
			if (!client) {
				const result: NavigationResult = NOT_CONNECTED;
				reply?.(result);
				return { kind: "launcherSettled", epoch, result };
			}
			let result: NavigationResult = { ok: true };
			try {
				const rpc = await client.detach();
				result = rpc?.ok ? { ok: true } : { ok: false, error: errorMessage(rpc?.error, "detach failed") };
			} catch (error) {
				result = { ok: false, error: errorText(error, "detach failed") };
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

/** Commit an address-bearing initial sync as one store write: the address,
 * the durable session id, the document, and its revision all become visible
 * together (no subscriber observes a new document under an old address, or
 * the reverse), the address is remembered, and the route is written unless
 * the alias view holds it (ADR 13). The document is the mirror's — it holds
 * the frame the pipeline just applied (promoted, for a delta). */
function commitObservation(ref: SessionRef, deps: NavigationDeps): void {
	const mirror = deps.getClient()?.mirror;
	if (mirror !== undefined) {
		deps.port.commitObservation(ref, mirror.document, mirror.revision);
	} else {
		// No client (tests without a mirror): the address pair alone — the
		// document will be published with the next frame.
		deps.port.commitAddress(ref.projectId, ref.stem, ref.sessionId);
	}
}

/** Restore a committed view after a failed navigate-mode open: the address,
 * the session id, and the route all describe the view the client actually
 * holds server-side. `doc` republishes the view's document — the mirror
 * holds the last committed view's root, so the instant-switch paint's
 * snapshot must not survive the rollback. */
function restoreView(
	previous: { view: NavigationView; sessionId: string | null },
	port: NavigationViewPort,
	doc?: Document,
): void {
	port.restoreView(previous.view, previous.sessionId, doc);
}

/** Land a boot-mode failure on the Project home (ADR 11): the stem no longer
 * resolves (deleted file, or an unflushed session after a daemon restart),
 * so the staged address, the identity, and the alias flag all go. */
function landProjectHome(
	projectId: string,
	port: NavigationViewPort,
): { view: NavigationView; sessionId: string | null } {
	port.setAddressViaAlias(false);
	port.clearSession(projectId);
	port.writeRoute({ kind: "project", projectId });
	return { view: { kind: "project", projectId }, sessionId: null };
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

/** Stage an opening transition: optimistic address (and, for user actions,
 * route), supersede the previous pending transition, and admit the
 * value-only prepare effect. Shared by `open`, `boot`, and a resolved
 * `/@latest` target. */
function stageOpen(
	state: NavigationState,
	view: NavigationView & { kind: "session" },
	options: {
		mode: "navigate" | "boot";
		/** Non-null when the view is reached through an alias: the route keeps
		 * the alias form and initial-sync frames do not rewrite it (ADR 13).
		 * Its `projectId` is the scope the URL should carry. */
		alias: { projectId: string | null } | null;
		/** User actions publish the URL at staging; a boot's URL already
		 * names the target. */
		writesRoute: boolean;
		sessionIdHint?: string;
		reply?: Reply;
	},
	epoch: number,
	transitionId: number,
	deps: NavigationDeps,
): { state: NavigationState; effects: ReactorEffect<NavigationMessage>[] } {
	const port = deps.port;
	// A superseded transition never committed; remember its target so its
	// late initial sync cannot commit over the successor.
	const abandoned = state.pending ? { key: sessionKey(state.pending.view) } : state.abandoned;
	const pending: PendingTransition = {
		id: transitionId,
		intentEpoch: epoch,
		openEpoch: null,
		view,
		mode: options.mode,
		viaAlias: options.alias !== null,
		previous: state.current,
		reply: options.reply,
		synced: false,
	};
	port.setAddressViaAlias(options.alias !== null);
	port.stageAddress(view.projectId, view.stem);
	if (options.writesRoute) {
		if (options.alias !== null) {
			port.writeRoute({ kind: "alias", alias: "latest", projectId: options.alias.projectId });
		} else {
			port.writeRoute({ kind: "session", projectId: view.projectId, stem: view.stem });
		}
	}
	return {
		state: { ...state, pending, abandoned, intentEpoch: epoch },
		effects: [prepareEffect(view, options.sessionIdHint, transitionId, options.reply, deps)],
	};
}

/** Settle an opening transition: confirm (defensively committing the ref the
 * server already pushed), roll back to the previous view, or land on the
 * Project home — but only while the transition is still the newest intent;
 * a superseded transition settles its caller and commits nothing. Clears the
 * pending slot and the candidate either way: the transition is over. */
function settleOpen(
	state: NavigationState,
	pending: PendingTransition,
	result: NavigationResult,
	ref: SessionRef | undefined,
	deps: NavigationDeps,
): NavigationState {
	let current = state.current;
	let abandoned = state.abandoned;
	if (state.intentEpoch === pending.intentEpoch) {
		if (result.ok) {
			// The push precedes the reply, so the sync already committed;
			// commit defensively only if it somehow did not.
			if (!pending.synced && ref) commitObservation(ref, deps);
			current = { view: pending.view, sessionId: ref?.sessionId ?? state.current.sessionId };
			// This address is live again: a stale abandoned marker for it
			// must not swallow a later legitimate sync.
			abandoned = abandoned?.key === sessionKey(pending.view) ? null : abandoned;
		} else if (pending.mode === "boot") {
			current = landProjectHome(pending.view.projectId, deps.port);
		} else {
			// A navigate failure restores the last committed view: the server
			// left the previous attachment untouched, so the client must not
			// claim the new address either. The previous view's document is
			// repainted from the mirror — it holds the last committed view's
			// root (candidates promote only at commit), so the instant-switch
			// paint's snapshot goes with the address change.
			restoreView(pending.previous, deps.port, deps.getClient()?.mirror.document);
			current = pending.previous;
		}
	}
	return { ...state, current, pending: null, candidate: null };
}

function navigationStep(
	state: NavigationState,
	message: NavigationMessage,
	context: { epoch: number; send(message: NavigationMessage): void },
	deps: NavigationDeps,
	nextTransitionId: () => number,
): { state: NavigationState; effects?: ReactorEffect<NavigationMessage>[] } {
	switch (message.kind) {
		case "open":
		case "boot": {
			// `mode` picks the failure fallback and the seeding style:
			// navigate restores the last committed view and seeds a
			// candidate; boot seeds the live mirror and lands on the
			// Project home. Neither is alias-addressed: a resolved alias
			// target arrives as `latestResolved`, which stages with boot
			// semantics.
			const mode: "navigate" | "boot" = message.kind === "open" ? (message.mode ?? "navigate") : "boot";
			return stageOpen(
				state,
				message.view,
				{
					mode,
					alias: null,
					writesRoute: message.kind === "open",
					sessionIdHint: message.kind === "open" ? message.sessionIdHint : undefined,
					reply: message.reply,
				},
				context.epoch,
				nextTransitionId(),
				deps,
			);
		}

		case "prepared": {
			// Cancelled by a terminal close: the caller settled at cancel time,
			// and the runtime it targeted is gone — no RPC, no seeding. Prune.
			if (state.cancelled.delete(message.transition)) return { state };
			const pending = state.pending;
			if (pending === null || pending.id !== message.transition || state.intentEpoch !== pending.intentEpoch) {
				// Admission gate: a superseded transition sends nothing. The server
				// serializes attachment transitions in arrival order, so a late open
				// RPC from an abandoned intent could attach the abandoned session
				// after the successor's command — the connection would end up
				// attached to a session the UI no longer shows. The caller settles
				// client-side: nothing ran, nothing failed. No RPC was admitted, so
				// no settlement will arrive for it — the slot it still holds is
				// cleared here.
				const result: NavigationResult = { ok: false, error: "superseded", superseded: true };
				message.reply?.(result);
				if (pending !== null && pending.id === message.transition) {
					return { state: { ...state, pending: null, candidate: null } };
				}
				return { state };
			}
			// The owner's cache read seeds before the RPC leaves: the candidate
			// (navigate) or the live mirror and store (boot). A superseded
			// transition's late cache read seeds nothing — the gate above returned.
			let cursor: PrefixCursor | undefined;
			if (message.seed !== null) {
				const seed = message.seed;
				cursor = computeCursor(seed.records) ?? undefined;
				if (pending.mode === "navigate") {
					const doc = seedDocument(seed.records, seed.hint ?? undefined);
					// Candidate seeding (ADR 09): the delta initial sync
					// applies to the candidate, not the live mirror.
					if (cursor !== undefined) {
						state = {
							...state,
							candidate: { sessionId: seed.sessionId, doc },
						};
					}
					// Instant switch: paint the target's cached prefix over the
					// previous view's document, so the switch reads as immediate —
					// the loading continuation marks it unconfirmed. Skipped when
					// the committed view is already this address (a re-navigate
					// must not downgrade the live authoritative document to a
					// cache snapshot) or the cache holds nothing.
					if (sessionKey(state.current.view) !== sessionKey(pending.view) && seed.records.length > 0) {
						deps.port.paintLocalDocument(doc);
					}
				} else {
					// Boot seeding: the live mirror (and, when the cache has
					// content, the store) hold the cached prefix before the
					// initial sync applies. A reconnect reuses the richer
					// in-memory document over the cache.
					const sameSession =
						deps.port.renderedSessionId() === seed.sessionId && !deps.port.renderedDocumentEmpty();
					const doc = sameSession
						? deps.port.renderedDocument()
						: seedDocument(seed.records, seed.hint ?? undefined);
					deps.getClient()?.mirror.applyReplace(doc);
					advanceCacheBase(seed.sessionId, doc);
					if (!sameSession && seed.records.length > 0) {
						deps.port.paintLocalDocument(doc);
					}
				}
			}
			const client = deps.getClient();
			if (!client) {
				// The connection vanished mid-preparation: settle like a
				// failed RPC (the caller learns the transition never ran).
				message.reply?.(NOT_CONNECTED);
				return { state: settleOpen(state, pending, NOT_CONNECTED, undefined, deps) };
			}
			const cursorHint = cursor ?? (message.seed ? (computeCursor(message.seed.records) ?? undefined) : undefined);
			return {
				state: { ...state, pending: { ...pending, openEpoch: context.epoch } },
				effects: [openRpcEffect(client, message.view, cursorHint, message.transition, message.reply)],
			};
		}

		case "latest":
		case "bootLatest": {
			const boot = message.kind === "bootLatest";
			return {
				state: { ...state, intentEpoch: context.epoch },
				effects: [latestEffect(boot, message.aliasProjectId, context.epoch, message.reply, deps)],
			};
		}

		case "latestResolved": {
			// A resolution that lands after a newer intent commits nothing —
			// it cannot re-enter as a fresh intent over the successor's view.
			// The caller still settles: silently, like the old no-target press.
			if (state.intentEpoch !== message.epoch) {
				message.reply?.({ ok: true });
				return { state };
			}
			if (!message.target) {
				if (message.boot) {
					// Nothing to open: land on what the alias scoped itself to —
					// its Project home, or the Launcher for the root form.
					message.reply?.({ ok: true });
					if (message.aliasProjectId !== null) {
						return { state: { ...state, current: landProjectHome(message.aliasProjectId, deps.port) } };
					}
					deps.port.clearSession();
					deps.port.writeRoute({ kind: "launcher" });
					return { state: { ...state, current: { view: { kind: "launcher" }, sessionId: null } } };
				}
				// A user press with nothing to open: a silent no-op — but the
				// caller still settles (an await that never resolves would strand
				// a gesture, and a boot that never resolves would stall
				// useConnection's connected handoff).
				message.reply?.({ ok: true });
				return { state };
			}
			const view = { kind: "session", projectId: message.target.projectId, stem: message.target.stem } as const;
			return stageOpen(
				state,
				view,
				{
					mode: "boot",
					alias: { projectId: message.aliasProjectId },
					writesRoute: !message.boot,
					reply: message.reply,
				},
				context.epoch,
				nextTransitionId(),
				deps,
			);
		}

		case "project": {
			if (message.mode === "boot") {
				// The URL already names the Project home; nothing to detach.
				deps.port.stageAddress(message.projectId, null);
				return {
					state: {
						...state,
						current: { view: { kind: "project", projectId: message.projectId }, sessionId: null },
						intentEpoch: context.epoch,
					},
				};
			}
			// A pending open may already have its RPC on the wire (admitted while
			// it owned the view), so the server can be attached — or about to
			// attach — to a session the committed view does not name. The staged
			// intent decides the detach, not the committed view alone: reading
			// only `current` left the server attached to the pending open's
			// session while the UI showed the Project home.
			const wasSession = (state.pending ?? state.current).view.kind === "session";
			const epoch = context.epoch;
			const reply = message.reply;
			const projectId = message.projectId;
			const effect: ReactorEffect<NavigationMessage> = {
				run: async () => {
					const client = deps.getClient();
					if (client && wasSession) {
						try {
							const rpc = await client.detach();
							reply?.(rpc?.ok ? { ok: true } : { ok: false, error: errorMessage(rpc?.error, "detach failed") });
						} catch (error) {
							// A failed detach reports to the caller, but the
							// Project home commits regardless (the old behavior:
							// the address change is not conditional on it).
							reply?.({ ok: false, error: errorText(error, "detach failed") });
						}
					} else {
						reply?.({ ok: true });
					}
					return { kind: "projectSettled", epoch, projectId };
				},
			};
			return { state: { ...state, intentEpoch: context.epoch }, effects: [effect] };
		}

		case "launcher": {
			if (message.mode === "boot") {
				deps.port.clearSession();
				deps.port.writeRoute({ kind: "launcher" });
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

		case "openSettled": {
			const pending = state.pending;
			// A cancelled transition's stray RPC completion: the caller settled
			// at cancel time; prune and commit nothing.
			state.cancelled.delete(message.transition);
			if (pending === null || pending.id !== message.transition) return { state };
			return { state: settleOpen(state, pending, message.result, message.ref, deps) };
		}

		case "projectSettled": {
			if (state.intentEpoch !== message.epoch) return { state };
			deps.port.setAddressViaAlias(false);
			deps.port.stageAddress(message.projectId, null);
			deps.port.writeRoute({ kind: "project", projectId: message.projectId });
			return {
				state: { ...state, current: { view: { kind: "project", projectId: message.projectId }, sessionId: null } },
			};
		}

		case "launcherSettled": {
			if (state.intentEpoch !== message.epoch) return { state };
			if (!message.result.ok) return { state };
			deps.port.setAddressViaAlias(false);
			deps.port.clearSession();
			deps.port.writeRoute({ kind: "launcher" });
			return { state: { ...state, current: { view: { kind: "launcher" }, sessionId: null } } };
		}

		case "create": {
			const client = deps.getClient();
			if (!client) {
				message.reply?.(NOT_CONNECTED);
				return { state };
			}
			// A creation is the newest intent: it supersedes a pending open,
			// which settles without sending (or, its RPC already having left,
			// commits nothing on settlement). Nothing is staged optimistically
			// — the address does not exist until the server allocates the
			// file — but the creation records itself, so its attributed
			// initial sync can commit the view later.
			const pending = state.pending;
			if (pending !== null) {
				pending.reply?.({ ok: false, error: "superseded", superseded: true });
			}
			return {
				state: {
					...state,
					pending: null,
					candidate: null,
					creation: { operationId: message.operationId, intentEpoch: context.epoch },
					intentEpoch: context.epoch,
				},
				effects: [createRpcEffect(client, message)],
			};
		}

		case "createSettled": {
			const creation = state.creation;
			// A stray completion (a stale or unknown operation): the slot a
			// newer creation overwrote is not this one's to clear.
			if (creation === null || creation.operationId !== message.operationId) return { state };
			let current = state.current;
			if (state.intentEpoch === creation.intentEpoch && message.result.ok && message.ref) {
				// The push precedes the reply, so the attributed sync already
				// committed; commit defensively only if it somehow did not —
				// and never over an address that was closed meanwhile (the
				// abandoned marker records it).
				const key = `${message.ref.projectId}/${message.ref.stem}`;
				const rendered = deps.port.renderedAddress();
				if (
					state.abandoned?.key !== key &&
					(rendered.projectId !== message.ref.projectId || rendered.stem !== message.ref.stem)
				) {
					commitObservation(message.ref, deps);
				}
				current = {
					view: { kind: "session", projectId: message.ref.projectId, stem: message.ref.stem },
					sessionId: message.ref.sessionId,
				};
			}
			// The creation operation is over either way: its slot frees for
			// the next creation intent.
			return { state: { ...state, current, creation: null } };
		}

		case "closed": {
			// The host's terminal ownership push: the runtime behind an address
			// ended, so nothing for that address can commit or roll back a view
			// anymore. Two paths process it, and only the second is gated:
			//
			//   - A pending transition targeting the address is cancelled
			//     unconditionally. The close may name the attachment that
			//     transition is still acquiring — the server-side attach and the
			//     close crossed on the wire — so its generation is one the actor
			//     has not committed (and may never commit). The runtime is gone;
			//     the open must not attach to a corpse whatever the close names.
			//   - The committed view may be ended only when the close names the
			//     committed attachment (ADR 19): a close from any other
			//     attachment — same address or not — describes an observation the
			//     view does not hold. A null committed generation means no
			//     observation is committed, so nothing is ended.
			const key = `${message.projectId}/${message.stem}`;
			let pending = state.pending;
			let current = state.current;
			const cancelled = state.cancelled;
			// A pending transition targeting the closed address is cancelled:
			// its caller settles here, its prepare admits no RPC (the runtime
			// it targeted is gone), and its late sync and reply commit nothing.
			let cancelledTarget = false;
			if (pending !== null && sessionKey(pending.view) === key) {
				pending.reply?.({ ok: false, error: "session closed" });
				cancelled.add(pending.id);
				pending = null;
				cancelledTarget = true;
			}
			const endsCommitted =
				state.committedGeneration === message.generation &&
				current.view.kind === "session" &&
				sessionKey(current.view) === key;
			if (!cancelledTarget && !endsCommitted) {
				// A stale close (or one for an address nothing here holds): it
				// describes an observation the view does not hold.
				return { state };
			}
			// The closed address must not survive as a rollback target either:
			// a transition in flight to another address would otherwise
			// "restore" the dead session on failure.
			if (
				pending !== null &&
				pending.previous.view.kind === "session" &&
				sessionKey(pending.previous.view) === key
			) {
				pending = {
					...pending,
					previous: { view: { kind: "project", projectId: message.projectId }, sessionId: null },
				};
			}
			const rendered = deps.port.renderedAddress();
			if (rendered.projectId === message.projectId && rendered.stem === message.stem) {
				// The rendered Session's runtime ended: the document can never
				// progress again, so the address, the session id, and the route
				// all go, retaining the Project to land on its home.
				deps.port.clearSession(message.projectId);
				deps.port.writeRoute({ kind: "project", projectId: message.projectId });
				current = { view: { kind: "project", projectId: message.projectId }, sessionId: null };
			}
			return { state: { ...state, pending, current, cancelled, abandoned: { key } } };
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
				if (state.intentEpoch !== pending.intentEpoch) {
					// A newer intent owns the view; the pending transition's
					// sync commits nothing.
					return { state };
				}
				if (message.ops !== null) {
					// Promote the candidate the prepare seeded: the mirror's own
					// application of this delta ran against the old-session
					// base and is discarded (ADR 09).
					const promoted =
						state.candidate !== null ? promoteCandidate(state.candidate, ref.sessionId, message.ops) : null;
					if (promoted) {
						deps.getClient()?.mirror.applyReplace(promoted.doc);
						advanceCacheBase(ref.sessionId, promoted.before);
					}
				}
				commitObservation(ref, deps);
				return {
					state: {
						...state,
						current: { view: pending.view, sessionId: ref.sessionId },
						pending: { ...pending, synced: true },
						candidate: null,
						committedGeneration: message.generation,
					},
				};
			}
			// No pending transition: a creation's initial sync (attributed), or a
			// re-assert of the already-rendered address. Both are admission-gated,
			// not exclusion-guarded: an unattributed frame may only re-assert (a
			// new address has no identity to prove its intent, so it commits
			// nothing), and an attributed frame commits only while its creation
			// is still the newest intent. A superseded or closed target's late
			// sync therefore cannot commit over the successor — unless it
			// re-asserts the already-rendered address, which is idempotent by
			// definition and never a takeover.
			const key = `${ref.projectId}/${ref.stem}`;
			const reasserts = state.current.view.kind === "session" && sessionKey(state.current.view) === key;
			if (message.operationId !== undefined) {
				const creation = state.creation;
				if (
					creation === null ||
					creation.operationId !== message.operationId ||
					state.intentEpoch !== creation.intentEpoch ||
					state.abandoned?.key === key
				) {
					// A superseded or cancelled creation (or one whose address was
					// closed while it was in flight): its sync selects nothing.
					return { state };
				}
				commitObservation(ref, deps);
				return {
					state: {
						...state,
						current: {
							view: { kind: "session", projectId: ref.projectId, stem: ref.stem },
							sessionId: ref.sessionId,
						},
						committedGeneration: message.generation,
						abandoned: state.abandoned?.key === key ? null : state.abandoned,
					},
				};
			}
			if (!reasserts) {
				// Unattributed and not a re-assert: it names a view nothing
				// admitted. (The abandoned marker's check is subsumed — a
				// non-reasserting frame never commits.)
				return { state };
			}
			// A re-assert must come from the committed attachment: the generation
			// names the attachment the frame belongs to, so a mismatch — or a null
			// committed generation, meaning no observation is committed — is a
			// frame the view does not hold (ADR 19).
			if (state.committedGeneration !== message.generation) {
				return { state };
			}
			commitObservation(ref, deps);
			return {
				state: {
					...state,
					current: {
						view: { kind: "session", projectId: ref.projectId, stem: ref.stem },
						sessionId: ref.sessionId,
					},
					committedGeneration: message.generation,
					abandoned: state.abandoned?.key === key ? null : state.abandoned,
				},
			};
		}

		case "localSeed": {
			// A cache-first restore's values arrived (ADR 09); the actor decides
			// whether they become visible (ADR 19). The guard reads the port's
			// own publications on purpose: navigation maintains exactly the
			// invariants it reads — the address is staged before the RPC
			// resolves, and the durable session id lands only with an
			// address-bearing initial sync — so a stale cache read can never
			// overwrite wire data.
			const { projectId, stem, sessionId, doc } = message.seed;
			const rendered = deps.port.renderedAddress();
			const unclaimed = rendered.projectId === null && rendered.stem === null;
			const matchesEmpty =
				rendered.projectId === projectId && rendered.stem === stem && deps.port.renderedDocumentEmpty();
			// A published session id means an address-bearing frame already landed
			// — even for an empty session — so the wire is authoritative.
			if ((!unclaimed && !matchesEmpty) || deps.port.renderedSessionId() !== null) return { state };
			// Address first, then the id (the pipeline's ordering rule):
			// staging unbinds a stale id on an address change, so the pair must
			// land in this order.
			deps.port.stageAddress(projectId, stem);
			deps.port.publishSessionId(sessionId);
			// A local paint is a publication outside the mirror: the store's own
			// revision counter advances, exactly like the restore path it replaces.
			deps.port.paintLocalDocument(doc);
			return { state };
		}
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
	let nextTransitionId = 1;
	runtime.deps = deps;
	runtime.reactor = createReactor<NavigationState, NavigationMessage>({
		initial: {
			current: { view: { kind: "launcher" }, sessionId: null },
			pending: null,
			candidate: null,
			abandoned: null,
			creation: null,
			committedGeneration: null,
			intentEpoch: 0,
			cancelled: new Set<number>(),
		},
		step: (state, message, context) =>
			navigationStep(state, message, context, runtime.deps, () => nextTransitionId++),
		onUnhandledEffectError: (error) => {
			console.error("navigation effect failed", error);
		},
	});
	return runtime;
}

let runtime: NavigationRuntime = createRuntime(defaultDeps);
/** Monotonic creation operation ids: minted for each `navigationCreate`,
 * unique for the module's lifetime (a reset navigation keeps counting, so a
 * frame attributed to a pre-reset creation can never match a newer one). */
let nextOperationId = 1;

/** Test seam: a fresh navigation (reset state) with optional dep overrides.
 * Also clears the cache base (the candidate is reset with the state). */
export function resetNavigationForTests(deps?: Partial<NavigationDeps>): void {
	runtime = createRuntime({ ...defaultDeps, ...deps });
	cacheBase.value = null;
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

/** Open the `@latest` alias (user action): resolve inside the alias's scope,
 * then open the target without leaving the alias URL. Resolves when the
 * resolved target's transition settles; a superseded resolution is a silent
 * no-op. */
export function navigationLatest(aliasProjectId: string | null = null): Promise<NavigationResult> {
	return settled(
		new Promise<NavigationResult>((resolve) => {
			void runtime.reactor.send({ kind: "latest", aliasProjectId, reply: resolve });
		}),
	);
}

/** Resolve the alias at boot/reconnect: with no target, land on the alias's
 * scope (its Project home, or the Launcher for the root form). Resolves when
 * the resolved target's transition settles (or the landing is applied), so a
 * caller gates "connected" on the same completion the old boot path had. */
export function navigationBootLatest(aliasProjectId: string | null = null): Promise<NavigationResult> {
	return settled(
		new Promise<NavigationResult>((resolve) => {
			void runtime.reactor.send({ kind: "bootLatest", aliasProjectId, reply: resolve });
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

/** Create a Session in a Project by sending its first prompt (the
 * newSession verb) as a navigation-owned transition. The operation id is
 * minted here and recorded as the current creation intent; the server
 * carries it onto the transition's initial-sync frame and reply, so both
 * are attributed to this intent and commit only while it is the newest.
 * Resolves with the RPC's outcome (a superseded creation reports
 * `superseded` — the newer intent owns the view). */
export function navigationCreate(
	projectId: string,
	text: string,
	options?: { images?: ImageContent[]; model?: ModelRef; thinkingLevel?: string },
): Promise<NavigationResult> {
	const operationId = `create-${nextOperationId++}`;
	return settled(
		new Promise<NavigationResult>((resolve) => {
			void runtime.reactor.send({
				kind: "create",
				projectId,
				text,
				operationId,
				images: options?.images,
				model: options?.model,
				thinkingLevel: options?.thinkingLevel,
				reply: resolve,
			});
		}),
	);
}

/** The transport pipeline's typed observation delivery (ADR 19): the one
 * seam for the observation events the view actor consumes. The pipeline
 * decodes the wire and hands over values — it decides nothing. A live
 * `patch` is not an actor message yet: the pipeline's coalescer publishes
 * it (the value-only pipeline slice), so the actor decides nothing for it
 * here either.
 */
export function navigationLocalSeed(seed: LocalSessionSeed): Promise<void> {
	return runtime.reactor.send({ kind: "localSeed", seed });
}

export function navigationObservation(event: ViewObservationEvent): void {
	if (event.kind === "initial_sync") {
		void runtime.reactor
			.send({
				kind: "sync",
				ref: event.ref,
				ops: event.ops,
				operationId: event.operationId,
				generation: event.generation,
			})
			.catch(() => {});
	} else if (event.kind === "session_closed") {
		void runtime.reactor
			.send({ kind: "closed", projectId: event.projectId, stem: event.stem, generation: event.generation })
			.catch(() => {});
	}
}

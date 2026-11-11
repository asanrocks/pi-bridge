// ============================================================================
// Protocol slice — store state driven by the wire and the daemon: the
// Document mirror, the connection state machine, the address this tab is
// watching (ADR 11), and the daemon registries (Projects, active sessions,
// models, sidebar folder pages). Everything here is a projection of
// protocol state, not user view state.
// Browser-safe: no node:* imports, no DOM.
// ============================================================================

import type { StateCreator } from "zustand/vanilla";
import { compareQueueRows } from "../../../../src/core/index.ts";
import type {
	Document,
	ModelInfo,
	PinnedModelInfo,
	ProjectInfo,
	SessionAddress,
	SessionInfo,
	SessionListCursor,
	SessionOutcome,
	SessionRef,
} from "../../../../src/core/types.ts";
import type { ComposerDraft } from "./composer.ts";
import type { ClientStore } from "./store.ts";

// ---------------------------------------------------------------------------
// Connection state — drives the TopBar chip (always-on) and the Launcher's
// full-panel down states. A discriminated union so renderers switch on kind.
// `connecting` = first attempt, never yet connected. `reconnecting` = dropped
// after a successful connect, attempt < threshold. `unreachable` = attempts
// exhausted (still auto-retrying, but loud). `init_failed` = WS opened but
// the init RPC (getDaemonInfo + listActiveSessions) failed — distinct from
// unreachable. `version_mismatch` = the daemon answers, but its protocol
// version is not the one this app was built against; it is not a connection
// problem, so nothing retries.
// ---------------------------------------------------------------------------

export type ConnectionState =
	| { kind: "connecting" }
	| { kind: "connected" }
	| { kind: "reconnecting"; attempt: number }
	| { kind: "unreachable"; attempt: number }
	| { kind: "init_failed"; error: string }
	/** `daemon` is null when the reply carried no version at all — a daemon older
	 * than the check, which is the same verdict as a different number. */
	| { kind: "version_mismatch"; daemon: number | null; app: number };

// ---------------------------------------------------------------------------
// Sidebar folder pages — lazily fetched per-Project session lists for the
// sidebar's folder tree (ADR 11). Pure UI cache, keyed by projectId, fetched
// on first expand.
// ---------------------------------------------------------------------------

export type SessionFolderPage =
	| { kind: "loading" }
	| { kind: "error" }
	| { kind: "ready"; sessions: SessionInfo[]; hasMore: boolean; nextCursor: SessionListCursor | null };

// ---------------------------------------------------------------------------
// Settle notices — the queue-wide completion signal (ADR 24).
//
// A queue delta is a sampled state, so a run shorter than the publication
// interval may never appear as running. A settle is therefore its own frame,
// forwarded immediately with how the execution ended; these notices are the
// small hand-off between the push pipeline (which files them) and the
// notification hook (which drains them and decides what counts as news).
// ---------------------------------------------------------------------------

export interface SettlementNotice {
	/** Monotone within one Connection: the hook drains by sequence, so a notice
	 * written while a render was pending is never announced twice. */
	seq: number;
	session: SessionRef;
	/** How the execution ended, reported rather than judged upstream. */
	outcome: SessionOutcome;
	name?: string;
}

/** How many notices the store retains. The hook drains synchronously after each
 * write, so this only bounds memory while nothing is subscribed. */
const SETTLEMENT_LOG_LIMIT = 32;

/** One address's identity in the unread list. */
export function addressKeyOf(address: { projectId: string; stem: string }): string {
	return `${address.projectId}\u0000${address.stem}`;
}

/** The unread list after this page read `address`: attaching a Session clears its
 * novelty. Returns the same array when there is nothing to drop, so a no-op
 * attach cannot re-render its subscribers. */
function readUnread(list: string[], address: SessionAddress | null): string[] {
	if (address === null) return list;
	const key = addressKeyOf(address);
	return list.includes(key) ? list.filter((entry) => entry !== key) : list;
}

// ---------------------------------------------------------------------------
// Slice shape
// ---------------------------------------------------------------------------

/** How the published document relates to the rendered address — the loading
 * tri-state's source. `authoritative`: confirmed by an address-bearing
 * initial sync (live patches after it extend the committed document).
 * `seeded`: the address's own last-known state painted from the local cache,
 * awaiting the initial sync. `staged`: not this address's document — the
 * previous view's document under an optimistically staged address, or the
 * empty placeholder — nothing may be asserted on its behalf. */
export type DocAuthority = "authoritative" | "seeded" | "staged";

export interface ProtocolSlice {
	// Document — replaced on every change. ADR 08 root-flip makes Object.is
	// the change signal for all selectors.
	document: Document;
	/** Durable session id of `document` (ADR 09) — the cache key, set from
	 * initial-sync frames or the boot-time local restore; live patches do not
	 * repeat it. Null when not attached or the session has no id yet. */
	activeSessionId: string | null;
	/** Monotonic revision of `document`: the wire pipeline publishes the
	 * mirror's revision with each flush (wholesale replaces and same-id
	 * entry-root replacements — content changes the structural ViewModel cache
	 * key cannot see); publishers that replace the document outside the mirror
	 * (cache restore, cache seeding) advance the counter by one, so every
	 * publication pairs the document with a revision that changed. The
	 * projection cache compares against the previous key only, so the two
	 * counters can never produce a false hit. */
	docRevision: number;
	/** How the published document relates to the rendered address
	 * (`DocAuthority`) — the loading tri-state's source. */
	docAuthority: DocAuthority;
	connection: ConnectionState;

	// Attachment state — the address this tab is watching (ADR 11)
	currentProjectId: string | null;
	/** Relative stem of the open session, or null on the Project home. */
	currentStem: string | null;

	/** Sidebar folder pages (ADR 11), keyed by projectId. Absent = never
	 * expanded (fetch on expand); reset on reconnect. */
	sessionPages: Record<string, SessionFolderPage>;
	/** Static Project configuration (ADR 11). */
	projects: ProjectInfo[];
	/** The queue's publication revision: the last frame this client applied. A
	 * delta must be exactly one ahead, or the client reconnects for a snapshot
	 * (ADR 24). */
	queueRevision: number;
	/** Queued settle notices not yet drained by the notification hook. */
	settlements: SettlementNotice[];
	settlementsSeq: number;
	/** Addresses (`addressKeyOf`) whose settle this page has not read yet: the
	 * badge's novelty ring. A finished run and a failure are news; an abort is
	 * the reader's own gesture and never lands here. Membership is an occurrence
	 * this page witnessed, so it is deliberately neither synced across tabs nor
	 * persisted — a reload means "nothing new since this page loaded". A local
	 * overlay on the synced count, never a second authority on what it counts. */
	unreadCompletions: string[];
	models: ModelInfo[];
	/** The daemon-global pinned list (ADR 15), resolved from pi's global
	 * `enabledModels`. One concept for the whole daemon: both the Project home
	 * and an attached Session read this, and the picker writes it. */
	pinnedModels: PinnedModelInfo[];
	/** Resolved `provider/modelId` keys of the picker's "normal" tier (ADR 15).
	 * Empty = no filter configured, so every non-pinned model is normal and
	 * nothing folds. Daemon-global; an attached session still uses it for the
	 * catalogue it shows. */
	visibleModels: string[];
	thinkingLevels: string[];
	/** Dev mode — when true, browser console.* calls are relayed to server. */
	devMode: boolean;

	/** True while the current session was reached through an alias address
	 * (ADR 13): the URL keeps the alias form (`/@latest` or
	 * `/<project>/@latest`), so address-bearing
	 * initial-sync frames must not rewrite it. Cleared by boot re-evaluation,
	 * the alias teardown, and every explicit navigation. */
	addressViaAlias: boolean;

	// Actions
	setConnectionState: (state: ConnectionState) => void;
	/** Set the active durable session id (from initial-sync frames). */
	setActiveSessionId: (sessionId: string | null) => void;
	/** Set the static Project list (from getDaemonInfo). */
	setProjects: (projects: ProjectInfo[]) => void;
	/** Enter/leave the alias-addressed view (ADR 13). */
	setAddressViaAlias: (viaAlias: boolean) => void;
	/** The global queue: every Inbox and Later Session, ordered Inbox →
	 * Later, then placement stamp descending. Derived from the applied frames. */
	queue: SessionInfo[];
	/** Replace the daemon-global pinned list (from a `pinned_models_changed` push). */
	setPinnedModels: (pinnedModels: PinnedModelInfo[]) => void;
	/** Commit the address this tab is watching (ADR 11). `null` Project = the
	 * global launcher; `null` stem = that Project's home. Changing the address
	 * also closes the file-viewer and diff-view portals — they showed content
	 * from the session being left — and unbinds `activeSessionId`: the id is
	 * only meaningful paired with its own address, and the initial-sync frame
	 * that opens the session re-pairs both. An address change also marks the
	 * published document `staged` (it belongs to the session being left); a
	 * rollback commits the restored pair through `commitAddress`. */
	setCurrentSession: (projectId: string | null, stem: string | null) => void;
	/** Unbind from the current Project/session (Launcher, open failure). Pass a
	 * `projectId` to land on that Project's home instead of the launcher. */
	clearCurrentSession: (projectId?: string | null) => void;
	/** Mark a sidebar folder page as fetching (expand / retry). */
	beginSessionPage: (projectId: string) => void;
	/** Install the queue baseline (the Connection's first `queue_changed`
	 * frame) and its revision. */
	applyQueueSnapshot: (sessions: SessionInfo[], revision: number) => void;
	/** Apply one queue delta: complete changed rows, removed addresses, and the
	 * Projects whose cached history is now stale. */
	applyQueueDelta: (
		upsert: SessionInfo[],
		remove: SessionAddress[],
		invalidateHistory: string[],
		revision: number,
	) => void;
	/** File one settle occurrence for the notification hook to drain. */
	noteSettlement: (notice: Omit<SettlementNotice, "seq">) => void;
	setSessionPage: (
		projectId: string,
		sessions: SessionInfo[],
		hasMore: boolean,
		nextCursor: SessionListCursor | null,
	) => void;
	/** Mark a sidebar folder page as failed (fetch failure / offline expand). */
	setSessionPageError: (projectId: string) => void;
	/** Append a sidebar folder page from load-more. Upserts by sessionId like
	 * `appendSessionPage`; a no-op unless the page is ready. */
	appendSessionPage: (
		projectId: string,
		incoming: SessionInfo[],
		hasMore: boolean,
		nextCursor?: SessionListCursor | null,
	) => void;
	/** Drop all sidebar folder pages (reconnect — the daemon may have restarted). */
	resetSessionPages: () => void;
	setModels: (
		models: ModelInfo[],
		thinkingLevels: string[],
		pinnedModels: PinnedModelInfo[],
		visibleModels: string[],
	) => void;
	setDevMode: (mode: boolean) => void;
	/** Replace the document from the mirror's root (wire pipeline flushes,
	 * lazy-pull ingests). Keeps `docAuthority`: a flush extends the committed
	 * document; local (non-mirror) publications go through
	 * `paintLocalDocument`. */
	applyReplace: (doc: Document, revision?: number) => void;
	/** Paint the address's own last-known state from the local cache (ADR 09):
	 * never confirmed — sets `docAuthority` to `seeded`. */
	paintLocalDocument: (doc: Document, revision?: number) => void;
	/** Commit an address pair (a navigate rollback restoring the previously
	 * committed view, or an address re-assert with no mirror): the published
	 * document belongs to the address again, so `docAuthority` is
	 * `authoritative`. `doc` — the view's document (a rollback's repaint) —
	 * is published in the same write. */
	commitAddress: (projectId: string | null, stem: string | null, sessionId: string | null, doc?: Document) => void;
	/** Commit an address-bearing initial sync as one store write: the
	 * address, the durable session id, the document, and its revision all
	 * become visible together, so no subscriber can observe a new document
	 * under an old address or the reverse (ADR 19's single-owner rule). The
	 * document is wire-confirmed for the address — `docAuthority` becomes
	 * `authoritative`. Carries the side effects of the former
	 * `setCurrentSession` and `setActiveSessionId` for an address/id change
	 * (the file-viewer portals close on an address change; the peek pin
	 * clears on a session-id change). */
	commitObservation: (ref: SessionRef, doc: Document, revision?: number) => void;
}

/** The queue's canonical order: one comparator shared with the host, so a
 * client never re-derives an order the server already decided. */
function sortedQueue(sessions: readonly SessionInfo[]): SessionInfo[] {
	return [...sessions].sort(compareQueueRows);
}

/** Apply one delta to the queue array: a complete row replaces the row at its
 * address, a removal drops it, and the result is re-sorted. */
function mergeQueueRows(
	current: readonly SessionInfo[],
	upsert: readonly SessionInfo[],
	remove: readonly SessionAddress[],
): SessionInfo[] {
	const rows = new Map(current.map((row) => [queueKey(row), row] as const));
	for (const row of upsert) rows.set(queueKey(row), row);
	for (const address of remove) rows.delete(queueKey(address));
	return sortedQueue([...rows.values()]);
}

function queueKey(row: { projectId: string; stem: string }): string {
	return `${row.projectId}\u0000${row.stem}`;
}

/** Drop the cached pages of the Projects a delta invalidated: the next unfold
 * refetches them from the first page (their cursors may no longer describe the
 * refreshed ordering). */
function withoutPages(
	pages: Record<string, SessionFolderPage>,
	projectIds: readonly string[],
): Record<string, SessionFolderPage> {
	const next = { ...pages };
	for (const projectId of projectIds) delete next[projectId];
	return next;
}

// ---------------------------------------------------------------------------
// Default document (empty mirror state)
// ---------------------------------------------------------------------------

function emptyDocument(): Document {
	return {
		status: {
			leafId: null,
			name: "",
			model: { provider: "", modelId: "" },
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			stats: {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: { total: 0 },
				messages: 0,
			},
			contextUsage: null,
			pendingSteer: [],
		},
		entries: {},
	};
}

/** Fields reset whenever the tab leaves its open session — a Project switch,
 * an open failure, and the Launcher all leave no session state behind. Spans
 * slices by design: leaving a session clears the session-scoped composer and
 * view state too, which is why it lives next to `clearCurrentSession`. */
function clearedSessionState() {
	return {
		currentProjectId: null as string | null,
		currentStem: null as string | null,
		activeSessionId: null as string | null,
		document: emptyDocument(),
		docAuthority: "staged" as const,
		addressViaAlias: false,
		expandedActionGroups: new Set<string>(),
		expandedActions: new Set<string>(),
		uncappedDetails: new Set<string>(),
		frozenActionGroups: new Set<string>(),
		frozenActions: new Set<string>(),
		loadingPaths: new Set<string>(),
		draft: { kind: "idle" } as ComposerDraft,
		selectionPick: null,
		composerExpanded: false,
		focusedTurnId: null as string | null,
		renderLeafId: null as string | null,
		// The browser shows content from the session being left (a file path, or a
		// commit pair in that repo); it must not survive the switch.
		browser: null as ClientStore["browser"],
	};
}

// ---------------------------------------------------------------------------
// Slice factory
// ---------------------------------------------------------------------------

export const createProtocolSlice: StateCreator<ClientStore, [], [], ProtocolSlice> = (set) => ({
	document: emptyDocument(),
	activeSessionId: null,
	docRevision: 0,
	docAuthority: "staged",
	connection: { kind: "connecting" },
	currentProjectId: null,
	currentStem: null,
	sessionPages: {},
	projects: [],
	queue: [],
	queueRevision: 0,
	settlements: [],
	settlementsSeq: 0,
	unreadCompletions: [],
	addressViaAlias: false,
	models: [],
	pinnedModels: [],
	visibleModels: [],
	thinkingLevels: [],
	devMode: false,

	setConnectionState: (connection) => set({ connection }),

	setActiveSessionId: (activeSessionId) =>
		set((s) =>
			// A session change invalidates the peek pin: the pinned entry id
			// belongs to the previous session's tree, and carrying it over would
			// leave the new session diverged (mutation-locked) with a dangling
			// pin. Same-id re-activation (reconnect replace) keeps it — committed
			// ids stay valid across a snapshot restore.
			s.activeSessionId === activeSessionId ? s : { activeSessionId, renderLeafId: null },
		),

	setProjects: (projects) => set({ projects }),

	setAddressViaAlias: (addressViaAlias) => set({ addressViaAlias }),

	applyQueueSnapshot: (sessions, revision) => set({ queue: sortedQueue(sessions), queueRevision: revision }),

	applyQueueDelta: (upsert, remove, invalidateHistory, revision) =>
		set((s) => ({
			queue: mergeQueueRows(s.queue, upsert, remove),
			queueRevision: revision,
			sessionPages: invalidateHistory.length > 0 ? withoutPages(s.sessionPages, invalidateHistory) : s.sessionPages,
		})),

	noteSettlement: (notice) =>
		set((s) => {
			const attached = s.currentProjectId === notice.session.projectId && s.currentStem === notice.session.stem;
			const key = addressKeyOf(notice.session);
			// The Session this tab is reading carries its own completion in the tab
			// title and unread count (`useStatusNotifications`), so it is never news
			// here. A stop is the reader's own gesture and never novelty either;
			// a finished run and a failure both are, until this page attaches the
			// Session. The notice itself is filed whatever the outcome.
			const news = notice.outcome !== "aborted" && !attached;
			const unread =
				!news || s.unreadCompletions.includes(key)
					? s.unreadCompletions
					: [...s.unreadCompletions, key].slice(-SETTLEMENT_LOG_LIMIT);
			return {
				settlements: [...s.settlements, { ...notice, seq: s.settlementsSeq + 1 }].slice(-SETTLEMENT_LOG_LIMIT),
				settlementsSeq: s.settlementsSeq + 1,
				unreadCompletions: unread,
			};
		}),

	setPinnedModels: (pinnedModels) => set({ pinnedModels }),

	// An address change is a different session's content: both portals hold
	// something read from the session being left (a path, or a commit pair in
	// that repository), so they close with it. A same-address re-assert (the
	// initial-sync push after an optimistic open, a reconnect replace) keeps
	// them open. The session id is unbound too: an id paired with a foreign
	// address would make the draft slot (draftKey) read and write the previous
	// session's slot. Until the initial-sync frame re-pairs, the slot is null
	// and draft writes gate — never another slot. An address change also marks
	// the published document `staged` (it belongs to the session being left);
	// the re-pairing frame restores authority via commitObservation.
	setCurrentSession: (currentProjectId, currentStem) =>
		set((s) =>
			s.currentProjectId === currentProjectId && s.currentStem === currentStem
				? s
				: {
						currentProjectId,
						currentStem,
						browser: null,
						activeSessionId: null,
						docAuthority: "staged" as const,
						// The selection pick is session-scoped: it must not ride into
						// another session's sends.
						selectionPick: null,
						// Reading an address is what clears its novelty, and this is the
						// optimistic half of a navigation (the sync confirms it later).
						unreadCompletions: readUnread(
							s.unreadCompletions,
							currentProjectId !== null && currentStem !== null
								? { projectId: currentProjectId, stem: currentStem }
								: null,
						),
					},
		),

	clearCurrentSession: (projectId = null) => set({ ...clearedSessionState(), currentProjectId: projectId }),

	beginSessionPage: (projectId) =>
		set((s) => ({ sessionPages: { ...s.sessionPages, [projectId]: { kind: "loading" } } })),

	setSessionPage: (projectId, sessions, hasMore, nextCursor) =>
		set((s) => ({
			sessionPages: { ...s.sessionPages, [projectId]: { kind: "ready", sessions, hasMore, nextCursor } },
		})),

	setSessionPageError: (projectId) =>
		set((s) => ({ sessionPages: { ...s.sessionPages, [projectId]: { kind: "error" } } })),

	appendSessionPage: (projectId, incoming, hasMore, nextCursor) =>
		set((s) => {
			const page = s.sessionPages[projectId];
			if (page?.kind !== "ready") return s;
			// Upsert by sessionId: update existing, append new, preserve unmatched
			const incomingMap = new Map(incoming.map((x) => [x.sessionId, x]));
			const merged: SessionInfo[] = [];
			for (const cur of page.sessions) {
				const upd = incomingMap.get(cur.sessionId);
				if (upd) {
					merged.push(upd);
					incomingMap.delete(cur.sessionId);
				} else {
					merged.push(cur);
				}
			}
			for (const x of incomingMap.values()) merged.push(x);
			merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
			return {
				sessionPages: {
					...s.sessionPages,
					[projectId]: { kind: "ready", sessions: merged, hasMore, nextCursor: nextCursor ?? page.nextCursor },
				},
			};
		}),

	resetSessionPages: () => set({ sessionPages: {} }),

	setModels: (models, thinkingLevels, pinnedModels, visibleModels) =>
		set({ models, thinkingLevels, pinnedModels, visibleModels }),

	setDevMode: (devMode) => set({ devMode }),

	applyReplace: (document, revision) =>
		set((s) => ({
			document,
			docRevision: revision !== undefined ? revision : s.docRevision + 1,
		})),

	paintLocalDocument: (document, revision) =>
		set((s) => ({
			document,
			docRevision: revision !== undefined ? revision : s.docRevision + 1,
			docAuthority: "seeded",
		})),

	commitAddress: (projectId, stem, sessionId, doc) =>
		set((s) => {
			const addressChanged = s.currentProjectId !== projectId || s.currentStem !== stem;
			const idChanged = s.activeSessionId !== sessionId;
			if (!addressChanged && !idChanged && (doc === undefined || s.document === doc)) return s;
			return {
				currentProjectId: projectId,
				currentStem: stem,
				activeSessionId: sessionId,
				...(doc !== undefined ? { document: doc, docRevision: s.docRevision + 1 } : {}),
				docAuthority: "authoritative",
				browser: addressChanged ? null : s.browser,
				renderLeafId: idChanged ? null : s.renderLeafId,
				selectionPick: addressChanged || idChanged ? null : s.selectionPick,
				unreadCompletions: readUnread(
					s.unreadCompletions,
					projectId !== null && stem !== null ? { projectId, stem } : null,
				),
			};
		}),

	commitObservation: (ref, document, revision) =>
		set((s) => {
			const addressChanged = s.currentProjectId !== ref.projectId || s.currentStem !== ref.stem;
			const idChanged = s.activeSessionId !== ref.sessionId;
			if (!addressChanged && !idChanged && s.document === document && s.docAuthority === "authoritative") return s;
			return {
				currentProjectId: ref.projectId,
				currentStem: ref.stem,
				activeSessionId: ref.sessionId,
				document,
				docRevision: revision !== undefined ? revision : s.docRevision + 1,
				docAuthority: "authoritative",
				browser: addressChanged ? null : s.browser,
				renderLeafId: idChanged ? null : s.renderLeafId,
				selectionPick: addressChanged || idChanged ? null : s.selectionPick,
				unreadCompletions: readUnread(s.unreadCompletions, { projectId: ref.projectId, stem: ref.stem }),
			};
		}),
});

// ============================================================================
// Protocol slice — store state driven by the wire and the daemon: the
// Document mirror, the connection state machine, the address this tab is
// watching (ADR 11), and the daemon registries (Projects, active sessions,
// models, sidebar folder pages). Everything here is a projection of
// protocol state, not user view state.
// Browser-safe: no node:* imports, no DOM.
// ============================================================================

import type { StateCreator } from "zustand/vanilla";
import type {
	Document,
	ModelInfo,
	PinnedModelInfo,
	ProjectInfo,
	SessionInfo,
	SessionListCursor,
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
// unreachable.
// ---------------------------------------------------------------------------

export type ConnectionState =
	| { kind: "connecting" }
	| { kind: "connected" }
	| { kind: "reconnecting"; attempt: number }
	| { kind: "unreachable"; attempt: number }
	| { kind: "init_failed"; error: string };

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
// Slice shape
// ---------------------------------------------------------------------------

export interface ProtocolSlice {
	// Document — replaced on every change. ADR 08 root-flip makes Object.is
	// the change signal for all selectors.
	document: Document;
	/** Durable session id of `document` (ADR 09) — the cache key, set from
	 * initial-sync frames; live patches do not repeat it. Null when not
	 * attached or the session has no id yet. */
	activeSessionId: string | null;
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
	/** Active/streaming sessions across all Projects (ADR 11). */
	activeSessions: SessionInfo[];
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
	 * (ADR 13): the URL keeps the alias form (`/@latest`), so address-bearing
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
	/** Set the global active/streaming snapshot. */
	setActiveSessions: (sessions: SessionInfo[]) => void;
	/** Replace the daemon-global pinned list (from a `pinned_models_changed` push). */
	setPinnedModels: (pinnedModels: PinnedModelInfo[]) => void;
	/** Commit the address this tab is watching (ADR 11). `null` Project = the
	 * global launcher; `null` stem = that Project's home. Changing the address
	 * also closes the file-viewer and diff-view portals — they showed content
	 * from the session being left. */
	setCurrentSession: (projectId: string | null, stem: string | null) => void;
	/** Unbind from the current Project/session (Launcher, open failure). Pass a
	 * `projectId` to land on that Project's home instead of the launcher. */
	clearCurrentSession: (projectId?: string | null) => void;
	/** Mark a sidebar folder page as fetching (expand / retry). */
	beginSessionPage: (projectId: string) => void;
	/** Commit a sidebar folder page (fetch success or sessions_changed). */
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
	applyReplace: (doc: Document) => void;
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
		addressViaAlias: false,
		expandedActionGroups: new Set<string>(),
		expandedActions: new Set<string>(),
		uncappedDetails: new Set<string>(),
		frozenActionGroups: new Set<string>(),
		frozenActions: new Set<string>(),
		loadingPaths: new Set<string>(),
		draft: { kind: "idle" } as ComposerDraft,
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
	connection: { kind: "connecting" },
	currentProjectId: null,
	currentStem: null,
	sessionPages: {},
	projects: [],
	activeSessions: [],
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

	setActiveSessions: (activeSessions) => set({ activeSessions }),

	setPinnedModels: (pinnedModels) => set({ pinnedModels }),

	// An address change is a different session's content: both portals hold
	// something read from the session being left (a path, or a commit pair in
	// that repository), so they close with it. A same-address re-assert (the
	// initial-sync push after an optimistic open, a reconnect replace) keeps
	// them open.
	setCurrentSession: (currentProjectId, currentStem) =>
		set((s) =>
			s.currentProjectId === currentProjectId && s.currentStem === currentStem
				? s
				: { currentProjectId, currentStem, browser: null },
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

	applyReplace: (document) => set({ document }),
});

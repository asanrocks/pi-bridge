// ============================================================================
// Zustand store — single source of truth for the web UI.
// Holds a Document root (not the DocumentMirror).
// Browser-safe: no node:* imports, no DOM.
// Lives in web/src/ because this is web-app state, not protocol.
// ============================================================================

import { createStore } from "zustand/vanilla";
import {
	type Document,
	type ImageContent,
	MAX_IMAGES_PER_MESSAGE,
	type ModelInfo,
	type ProjectInfo,
	type SessionInfo,
	type SessionListCursor,
} from "../../../src/core/types.ts";

// ---------------------------------------------------------------------------
// Toast notification
// ---------------------------------------------------------------------------

export interface Toast {
	id: string;
	message: string;
}

// ---------------------------------------------------------------------------
// Composer draft — the single source of truth for the textarea content.
// Discriminated by kind so the conversation (dimming) and the composer
// (textarea value/placeholder) read one field. It survives composer collapse
// (local React state did not), which is what makes durable drafts possible:
// blur-salvage, offline-tolerant commit, and localStorage persistence.
// ---------------------------------------------------------------------------

export type ComposerDraft =
	| { kind: "idle" }
	| { kind: "compose"; text: string; images?: ImageContent[] }
	| { kind: "edit"; entryId: string; index: number; text: string; initialText: string };

/** Stable empty attachment list — a selector returning a fresh `[]` on every
 * call makes `useStore` (useSyncExternalStore) see the snapshot as changed
 * after each render and loop to the max update depth. */
const NO_IMAGES: ImageContent[] = [];

/** Stable view of the active draft's attachments (empty for idle/edit —
 * edit carries the edited entry's images implicitly). */
export function selectDraftImages(state: { draft: ComposerDraft }): ImageContent[] {
	return state.draft.kind === "compose" ? (state.draft.images ?? NO_IMAGES) : NO_IMAGES;
}

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
// sidebar's folder tree (ADR 11). Distinct from the `sessions` slice (the
// current Project's page, which feeds the Project-home path): folder pages
// are pure UI cache, keyed by projectId, fetched on first expand.
// ---------------------------------------------------------------------------

export type SessionFolderPage =
	| { kind: "loading" }
	| { kind: "error" }
	| { kind: "ready"; sessions: SessionInfo[]; hasMore: boolean; nextCursor: SessionListCursor | null };

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export interface ClientStore {
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

	/** Composer draft — the single source of truth for the textarea content.
	    Discriminated by kind: idle (nothing), compose (new message), edit
	    (forking a past user message). Owned in the store so it survives
	    composer collapse and powers durable-draft behavior (blur salvage,
	    offline-tolerant commit, localStorage persistence). */
	draft: ComposerDraft;
	/** Composer expanded state. Visual only — decoupled from draft: the bar
	    can collapse while a compose draft stays dormant, re-expanding to the
	    saved text. Owned in the store (not local Composer state) so the
	    app-level keybinding layer can drive `/` to expand + focus the
	    textarea without reaching into Composer. */
	composerExpanded: boolean;
	/** Focused turn key for keyboard turn navigation (j/k/g/G). Assistant
	    turns are keyed by turnKey (equal to entryId for run-merged turns, but
	    the entry id is not guaranteed unique as a turn identity). When the
	    focused turn leaves the active path it goes stale; the next j/k snaps
	    to the turn nearest the viewport center. */
	focusedTurnId: string | null;
	/** keys: "${firstEntryId}:${firstBlockIndex}" (first step in group) */
	expandedActionGroups: Set<string>;
	/** keys: "${entryId}:b${blockIndex}" — steps whose details are expanded. */
	expandedSteps: Set<string>;
	/** Keys where the details' max-height cap has been removed. */
	uncappedDetails: Set<string>;
	/** Card content-view toggles (skeleton top-bar controls). Global, not
	    per-card: one flip keeps every card consistent. wrap=false gives code
	    and output horizontal scroll; markdown=false renders .md file content
	    as source instead of prose. */
	cardWrap: boolean;
	cardMarkdown: boolean;
	/** Manually toggled during streaming — streaming state no longer drives them. */
	frozenActionGroups: Set<string>;
	frozenSteps: Set<string>;
	/** fieldPaths with in-flight pulls (dedup). */
	loadingPaths: Set<string>;
	/**
	 * Bumped after every pull ingest and (delayed) after pull failures
	 * (ADR 09). Want-registering components subscribe to it so a bump
	 * re-renders them: fresh summaries after ingest, re-registered wants
	 * after failure.
	 */
	pullTick: number;
	sessions: SessionInfo[];
	sessionsHasMore: boolean;
	/** Compound cursor for the last returned session page (ADR 11). */
	sessionsNextCursor: SessionListCursor | null;
	/** Sidebar folder pages (ADR 11), keyed by projectId. Absent = never
	 * expanded (fetch on expand); reset on reconnect. */
	sessionPages: Record<string, SessionFolderPage>;
	/** Static Project configuration (ADR 11). */
	projects: ProjectInfo[];
	/** Active/streaming sessions across all Projects (ADR 11). */
	activeSessions: SessionInfo[];
	models: ModelInfo[];
	thinkingLevels: string[];
	/** Dev mode — when true, browser console.* calls are relayed to server. */
	devMode: boolean;

	// History pane (docked right on desktop, drawer on mobile)
	historyOpen: boolean;
	setHistoryOpen: (open: boolean) => void;
	/** Entry id to scroll the conversation to after navigation (set by history
	 * pane selection; cleared once the scroll lands). */
	scrollToEntryId: string | null;
	setScrollToEntryId: (id: string | null) => void;

	// File viewer (markdown file links → in-app read of the freshest file)
	/** Raw link href of the file being viewed, or null when closed. The
	 * FileViewer resolves it via the readFile verb on every open — content is
	 * never cached, so re-opening always reads from disk. */
	fileViewerPath: string | null;
	openFileViewer: (path: string) => void;
	closeFileViewer: () => void;

	// Notifications
	notifications: Toast[];
	pushToast: (id: string, message: string) => void;
	dismissToast: (id: string) => void;

	// Actions
	setConnectionState: (state: ConnectionState) => void;
	/** Set the active durable session id (from initial-sync frames). */
	setActiveSessionId: (sessionId: string | null) => void;
	/** Set the static Project list (from getDaemonInfo). */
	setProjects: (projects: ProjectInfo[]) => void;
	/** Set the global active/streaming snapshot. */
	setActiveSessions: (sessions: SessionInfo[]) => void;
	/** Commit the address this tab is watching (ADR 11). `null` Project = the
	 * global launcher; `null` stem = that Project's home. */
	setCurrentSession: (projectId: string | null, stem: string | null) => void;
	/** Unbind from the current Project/session (Launcher, open failure). Pass a
	 * `projectId` to land on that Project's home instead of the launcher. */
	clearCurrentSession: (projectId?: string | null) => void;
	/**
	 * Append a page of sessions from load-more. Upserts by sessionId: new entries
	 * are added, existing entries are updated with fresh metadata. Keeps
	 * sessions not in the incoming page (partial view).
	 */
	appendSessions: (incoming: SessionInfo[], hasMore: boolean, nextCursor?: SessionListCursor | null) => void;
	/**
	 * Replace the entire sessions list. Used on Project switch, where the pool
	 * belongs to a different Project and should not merge with the previous one.
	 */
	replaceSessions: (incoming: SessionInfo[], hasMore: boolean, nextCursor?: SessionListCursor | null) => void;
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
	 * `appendSessions`; a no-op unless the page is ready. */
	appendSessionPage: (
		projectId: string,
		incoming: SessionInfo[],
		hasMore: boolean,
		nextCursor?: SessionListCursor | null,
	) => void;
	/** Drop all sidebar folder pages (reconnect — the daemon may have restarted). */
	resetSessionPages: () => void;
	setModels: (models: ModelInfo[], thinkingLevels: string[]) => void;
	setDevMode: (mode: boolean) => void;
	applyReplace: (doc: Document) => void;
	/** Toggle a group and freeze it against streaming auto-expand.
	 * Passing the group's step card keys also resets those steps to folded
	 * (the header is the master toggle — reopening shows all descendants
	 * folded, not their pre-fold state). On open, a single-step group
	 * auto-expands its lone step's details. Atomic with the group toggle. */
	toggleActionGroup: (key: string, cardKeys?: string[]) => void;
	/** Toggle a step's details and freeze it against streaming auto-expand. */
	toggleStep: (key: string) => void;
	/** Toggle the max-height cap on an expanded step's details. */
	toggleUncapDetails: (key: string) => void;
	/** Toggle line wrap for card content (code + output). */
	toggleCardWrap: () => void;
	/** Toggle markdown rendering for .md file content in cards. */
	toggleCardMarkdown: () => void;
	/** Direct draft replacement (restore-from-localStorage, internal). */
	setDraft: (draft: ComposerDraft) => void;
	/** Update the active draft's text; promotes idle → compose on first keystroke. */
	setDraftText: (text: string) => void;
	/** Append prepared image attachments to a compose draft (promotes idle → compose). */
	addDraftImages: (images: ImageContent[]) => void;
	/** Remove one image attachment from the compose draft by index. */
	removeDraftImage: (index: number) => void;
	/** Enter edit mode for a past user message; pre-fills with the original text. */
	beginEdit: (entryId: string, index: number, text: string) => void;
	/** Blur salvage/discard: modified edit → compose draft; unmodified/empty → idle. Collapses the composer unless streaming/steers keep it up. */
	blurDraft: () => void;
	/** Clear the draft to idle (commit success, instance exit, Escape-on-edit). */
	clearDraft: () => void;
	setComposerExpanded: (expanded: boolean) => void;
	setFocusedTurnId: (id: string | null) => void;
	setLoadingPaths: (paths: Set<string>) => void;
	bumpPullTick: () => void;
	migrateExpandKeys: (oldId: string, newId: string) => void;
	/** Rewrite focusedTurnId on a provisional → durable id move (same move
	    ops as migrateExpandKeys). Turn identity makes the streaming entry
	    focusable at turn granularity (pending:message, or
	    pending:message:b<index> if a turn ever starts mid-entry) — without
	    this the focus ring would vanish at seal. */
	migrateFocusedTurnId: (oldId: string, newId: string) => void;
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
		scopedModels: [],
	};
}

/** Fields reset whenever the tab leaves its open session — a Project switch,
 * an open failure, and the Launcher all leave no session state behind. */
function clearedSessionState() {
	return {
		currentProjectId: null as string | null,
		currentStem: null as string | null,
		activeSessionId: null as string | null,
		document: emptyDocument(),
		sessions: [] as SessionInfo[],
		sessionsHasMore: false,
		sessionsNextCursor: null as SessionListCursor | null,
		expandedActionGroups: new Set<string>(),
		expandedSteps: new Set<string>(),
		uncappedDetails: new Set<string>(),
		frozenActionGroups: new Set<string>(),
		frozenSteps: new Set<string>(),
		loadingPaths: new Set<string>(),
		draft: { kind: "idle" } as ComposerDraft,
		composerExpanded: false,
		focusedTurnId: null as string | null,
	};
}

// ---------------------------------------------------------------------------
// Set helpers (immutable copy-on-write)
// ---------------------------------------------------------------------------

function setToggle(s: Set<string>, key: string): Set<string> {
	const next = new Set(s);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return next;
}

function setAdd(s: Set<string>, key: string): Set<string> {
	if (s.has(key)) return s;
	const next = new Set(s);
	next.add(key);
	return next;
}

// ---------------------------------------------------------------------------
// migrateExpandKeys — rewrite keys on provisionally sealed → durable move
// ---------------------------------------------------------------------------

export interface ExpandKeySets {
	expandedActionGroups: Set<string>;
	expandedSteps: Set<string>;
	frozenActionGroups: Set<string>;
	frozenSteps: Set<string>;
	loadingPaths: Set<string>;
	uncappedDetails: Set<string>;
}

/**
 * On every `move` op (provisional → durable id), rewrite keys in the expand,
 * frozen, and loading sets that start with the old provisional id prefix to
 * use the new committed id. Frozen sets are permanent — this migration is why
 * keys never collide across turns.
 *
 * Key formats:
 *   expandedActionGroups / frozenActionGroups: "${entryId}:${blockIndex}"
 *   expandedSteps / frozenSteps:              "${entryId}:b${blockIndex}"
 *   loadingPaths: fieldPath starting with "/entries/${entryId}/"
 */
export function migrateExpandKeys(sets: ExpandKeySets, oldId: string, newId: string): ExpandKeySets {
	const migrate = (s: Set<string>): Set<string> => {
		const next = new Set<string>();
		for (const key of s) {
			if (key.startsWith(`${oldId}:`)) {
				next.add(newId + key.slice(oldId.length));
			} else if (key.startsWith(`/entries/${oldId}/`)) {
				next.add(`/entries/${newId}/${key.slice("/entries/".length + oldId.length + 1)}`);
			} else {
				next.add(key);
			}
		}
		return next;
	};

	return {
		expandedActionGroups: migrate(sets.expandedActionGroups),
		expandedSteps: migrate(sets.expandedSteps),
		uncappedDetails: migrate(sets.uncappedDetails),
		frozenActionGroups: migrate(sets.frozenActionGroups),
		frozenSteps: migrate(sets.frozenSteps),
		loadingPaths: migrate(sets.loadingPaths),
	};
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

export function createClientStore() {
	return createStore<ClientStore>((set) => ({
		document: emptyDocument(),
		activeSessionId: null,
		connection: { kind: "connecting" },
		currentProjectId: null,
		currentStem: null,
		draft: { kind: "idle" },
		composerExpanded: false,
		focusedTurnId: null,
		expandedActionGroups: new Set(),
		expandedSteps: new Set(),
		uncappedDetails: new Set(),
		cardWrap: true,
		cardMarkdown: true,
		frozenActionGroups: new Set(),
		frozenSteps: new Set(),
		loadingPaths: new Set(),
		pullTick: 0,
		sessions: [],
		sessionsHasMore: false,
		sessionsNextCursor: null,
		sessionPages: {},
		projects: [],
		activeSessions: [],
		models: [],
		thinkingLevels: [],
		devMode: false,

		historyOpen: false,
		scrollToEntryId: null,

		fileViewerPath: null,

		notifications: [],

		pushToast: (id, message) =>
			set((s) => {
				// Upsert: replace an existing toast with the same id (e.g. the
				// connection toast advancing from "Reconnecting…" to "Can't reach").
				const exists = s.notifications.some((t) => t.id === id);
				if (exists) {
					return { notifications: s.notifications.map((t) => (t.id === id ? { id, message } : t)) };
				}
				return { notifications: [...s.notifications, { id, message }] };
			}),

		dismissToast: (id) =>
			set((s) => ({
				notifications: s.notifications.filter((t) => t.id !== id),
			})),

		setConnectionState: (connection) => set({ connection }),

		setActiveSessionId: (activeSessionId) => set({ activeSessionId }),

		setProjects: (projects) => set({ projects }),

		setActiveSessions: (activeSessions) => set({ activeSessions }),

		setCurrentSession: (currentProjectId, currentStem) => set({ currentProjectId, currentStem }),

		clearCurrentSession: (projectId = null) => set({ ...clearedSessionState(), currentProjectId: projectId }),

		appendSessions: (incoming, hasMore, nextCursor) =>
			set((s) => {
				// Upsert by sessionId: update existing, append new, preserve unmatched
				const incomingMap = new Map(incoming.map((x) => [x.sessionId, x]));
				const merged: SessionInfo[] = [];
				for (const cur of s.sessions) {
					const upd = incomingMap.get(cur.sessionId);
					if (upd) {
						merged.push(upd);
						incomingMap.delete(cur.sessionId);
					} else {
						merged.push(cur);
					}
				}
				for (const x of incomingMap.values()) merged.push(x);
				// Stable sort by timestamp desc
				merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
				return {
					sessions: merged,
					sessionsHasMore: hasMore,
					sessionsNextCursor: nextCursor ?? s.sessionsNextCursor,
				};
			}),

		replaceSessions: (incoming, hasMore, nextCursor) =>
			set({ sessions: incoming, sessionsHasMore: hasMore, sessionsNextCursor: nextCursor ?? null }),

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

		setModels: (models, thinkingLevels) => set({ models, thinkingLevels }),

		setDevMode: (devMode) => set({ devMode }),

		setHistoryOpen: (historyOpen) => set({ historyOpen }),
		setScrollToEntryId: (scrollToEntryId) => set({ scrollToEntryId }),

		openFileViewer: (path) => set({ fileViewerPath: path }),
		closeFileViewer: () => set({ fileViewerPath: null }),

		applyReplace: (document) => set({ document }),

		// Freeze on interaction (ADR 07 §Expand-state keys): a manual toggle
		// adds the key to the frozen set so streaming auto-expand no longer
		// drives it. Frozen sets are permanent.
		// Header is the master toggle (nit 3): toggling the group also resets
		// every step below it to folded, so reopening always shows descendants
		// folded rather than their pre-fold expand state. Atomic with the group
		// toggle so the two never paint a mixed state. On open, a single-step
		// group auto-expands its lone step's details — opening a one-step
		// group to see a folded step is a wasted click.
		toggleActionGroup: (key, cardKeys = []) =>
			set((s) => {
				const wasExpanded = s.expandedActionGroups.has(key);
				const expandedActionGroups = setToggle(s.expandedActionGroups, key);
				const frozenActionGroups = setAdd(s.frozenActionGroups, key);
				if (cardKeys.length === 0) return { expandedActionGroups, frozenActionGroups };
				const expandedSteps = new Set(s.expandedSteps);
				const frozenSteps = new Set(s.frozenSteps);
				for (const ck of cardKeys) {
					expandedSteps.delete(ck);
					frozenSteps.delete(ck);
				}
				if (!wasExpanded && cardKeys.length === 1) expandedSteps.add(cardKeys[0]);
				return { expandedActionGroups, frozenActionGroups, expandedSteps, frozenSteps };
			}),

		toggleStep: (key) =>
			set((s) => ({
				expandedSteps: setToggle(s.expandedSteps, key),
				frozenSteps: setAdd(s.frozenSteps, key),
			})),

		toggleUncapDetails: (key) => set((s) => ({ uncappedDetails: setToggle(s.uncappedDetails, key) })),
		toggleCardWrap: () => set((s) => ({ cardWrap: !s.cardWrap })),
		toggleCardMarkdown: () => set((s) => ({ cardMarkdown: !s.cardMarkdown })),

		setDraft: (draft) => set({ draft }),

		setDraftText: (text) =>
			set((s) => {
				if (s.draft.kind === "idle") return { draft: { kind: "compose", text } };
				// Spread, not rebuild: attachments must survive every keystroke.
				if (s.draft.kind === "compose") return { draft: { ...s.draft, text } };
				return {
					draft: {
						kind: "edit",
						entryId: s.draft.entryId,
						index: s.draft.index,
						text,
						initialText: s.draft.initialText,
					},
				};
			}),

		addDraftImages: (images) =>
			set((s) => {
				if (images.length === 0) return {};
				if (s.draft.kind === "compose") {
					// Clamp to the wire limit: two rapid addFiles calls can both compute
					// the same `room` before the async prep lands.
					const merged = [...(s.draft.images ?? []), ...images].slice(0, MAX_IMAGES_PER_MESSAGE);
					return { draft: { ...s.draft, images: merged } };
				}
				if (s.draft.kind === "idle") {
					return { draft: { kind: "compose", text: "", images }, composerExpanded: true };
				}
				// Edit drafts carry the edited entry's images implicitly (the fork
				// re-sends them); new attachments in edit mode are not supported.
				return {};
			}),

		removeDraftImage: (index) =>
			set((s) => {
				if (s.draft.kind !== "compose" || !s.draft.images) return {};
				const images = s.draft.images.filter((_, i) => i !== index);
				return { draft: { ...s.draft, images } };
			}),

		beginEdit: (entryId, index, text) =>
			set({ draft: { kind: "edit", entryId, index, text, initialText: text }, composerExpanded: true }),

		// Blur rule:
		//  - edit draft → no-op. Edit is a sticky mode, decoupled from
		//    textarea focus: window-switch/copy/click-away blur must NOT drop
		//    the edit target, or a later send takes the compose branch
		//    (fork from the leaf = append) instead of the edit branch (fork
		//    from the edited message's parent). Exit paths are explicit Cancel
		//    (Escape / the composer Cancel button) and successful commit.
		//  - compose draft, non-empty → keep, keep expanded
		//  - compose draft, empty → discard to idle, collapse
		// Streaming or queued steers keep the bar up regardless.
		blurDraft: () =>
			set((s) => {
				const streaming = s.document.status.isStreaming || s.document.status.pendingSteer.length > 0;
				if (s.draft.kind === "edit") return {};
				if (s.draft.kind === "compose") {
					const hasImages = s.draft.images !== undefined && s.draft.images.length > 0;
					if (s.draft.text.trim() || hasImages) return {};
					return { draft: { kind: "idle" }, composerExpanded: streaming };
				}
				return { composerExpanded: streaming };
			}),

		clearDraft: () => set({ draft: { kind: "idle" } }),

		setComposerExpanded: (composerExpanded) => set({ composerExpanded }),
		setFocusedTurnId: (focusedTurnId) => set({ focusedTurnId }),

		setLoadingPaths: (loadingPaths) => set({ loadingPaths }),

		bumpPullTick: () => set((s) => ({ pullTick: s.pullTick + 1 })),

		migrateExpandKeys: (oldId, newId) => set((s) => migrateExpandKeys(s, oldId, newId)),
		migrateFocusedTurnId: (oldId, newId) =>
			set((s) => {
				const focused = s.focusedTurnId;
				if (focused === null) return s;
				if (focused === oldId) return { focusedTurnId: newId };
				if (focused.startsWith(`${oldId}:b`)) return { focusedTurnId: newId + focused.slice(oldId.length) };
				return s;
			}),
	}));
}

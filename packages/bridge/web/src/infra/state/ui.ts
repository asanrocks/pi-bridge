// ============================================================================
// UI slice — ephemeral view state: conversation expand/collapse sets and their
// freeze/migrate machinery, keyboard focus, pull orchestration tickers,
// chrome (history pane, file viewer), and toast notifications. Nothing here
// is protocol state; all of it is session-scoped or app-chrome.
// Browser-safe: no node:* imports, no DOM.
// ============================================================================

import type { StateCreator } from "zustand/vanilla";
import type { Entry } from "../../../../src/core/types.ts";
import type { ClientStore } from "./store.ts";

// ---------------------------------------------------------------------------
// Toast notification
// ---------------------------------------------------------------------------

export interface Toast {
	id: string;
	message: string;
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
	expandedActions: Set<string>;
	frozenActionGroups: Set<string>;
	frozenActions: Set<string>;
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
 *   expandedActions / frozenActions:              "${entryId}:b${blockIndex}"
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
		expandedActions: migrate(sets.expandedActions),
		uncappedDetails: migrate(sets.uncappedDetails),
		frozenActionGroups: migrate(sets.frozenActionGroups),
		frozenActions: migrate(sets.frozenActions),
		loadingPaths: migrate(sets.loadingPaths),
	};
}

// ---------------------------------------------------------------------------
// Rendered-leaf override (peek)
// ---------------------------------------------------------------------------

/** Diverged = the rendered leaf is pinned away from the live leaf. The
 * mutation lock is derived from this — no separate mode flag to drift. When
 * the daemon navigates to exactly the pinned entry, equality re-syncs the
 * client by ground truth. */
export function selectRenderDiverged(s: ClientStore): boolean {
	return s.renderLeafId !== null && s.renderLeafId !== s.document.status.leafId;
}

/** Peek-target resolution: the nearest committed (sealed, `ord`-carrying)
 * ancestor-or-self of `id`. Returns null when the walk reaches the live leaf
 * first (the target IS live — the pin normalizes to follow-live), undefined
 * when nothing committed exists beneath (the pin is a no-op — a target that
 * would dangle at seal). Shared by `setRenderLeaf` (the pin) and the
 * HistoryPane click matrix (the anchor — scroll to what will actually render,
 * not to a clicked id that can be a pending entry stranded off the rendered
 * path). */
export function resolveRenderLeafTarget(
	entries: Record<string, Entry>,
	id: string,
	liveLeafId: string | null,
): string | null | undefined {
	let cursor: string | null = id;
	while (cursor) {
		if (cursor === liveLeafId) return null;
		const entry: Entry | undefined = entries[cursor];
		if (entry && entry.ord !== undefined) return cursor;
		cursor = entry?.parentId ?? null;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Slice shape
// ---------------------------------------------------------------------------

export interface UiSlice {
	/** Focused turn key for keyboard turn navigation (j/k/g/G). Assistant
	    turns are keyed by turnKey (equal to entryId for run-merged turns, but
	    the entry id is not guaranteed unique as a turn identity). When the
	    focused turn leaves the active path it goes stale; the next j/k snaps
	    to the turn nearest the viewport center. */
	focusedTurnId: string | null;
	/** keys: "${firstEntryId}:${firstBlockIndex}" (first action in group) */
	expandedActionGroups: Set<string>;
	/** keys: "${entryId}:b${blockIndex}" — actions whose details are expanded. */
	expandedActions: Set<string>;
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
	frozenActions: Set<string>;
	/** fieldPaths with in-flight pulls (dedup). */
	loadingPaths: Set<string>;
	/**
	 * Bumped after every pull ingest and (delayed) after pull failures
	 * (ADR 09). Pull-requesting components subscribe to it so a bump
	 * re-renders them: fresh summaries after ingest, re-registered pulls
	 * after failure.
	 */
	pullTick: number;

	/** Rendered-leaf override for read-only branch peeking. `null` = follow
	 * the live leaf (`status.leafId`); a non-null id pins the projection to
	 * that entry's root→leaf path. Peek never mutates the session: the value
	 * is UI-ephemeral, cleared on session teardown or when a different session
	 * activates (`setActiveSessionId` — a pinned id belongs to one session's
	 * tree), and every mutating verb (send/edit/navigate) is gated on
	 * `selectRenderDiverged`. Only committed entries (with `ord`) are accepted — a `pending:` id would dangle at
	 * seal. `setRenderLeaf(null)` is the single return-to-live gesture. */
	renderLeafId: string | null;
	setRenderLeaf: (id: string | null) => void;

	/** Entry id to scroll the conversation to after navigation (set by history
	 * pane selection; cleared once the scroll lands). The history pane's
	 *  open/mode state is NOT here — it lives with useHistoryPaneShell
	 *  (usePaneMode), like the sidebar's. */
	scrollToEntryId: string | null;
	setScrollToEntryId: (id: string | null) => void;

	// File viewer (markdown file links → in-app read of the freshest file)
	/** The file being viewed, or null when closed. `line` is a `path:98` /
	 * `#L98` scroll anchor from the link, applied by the viewer after load.
	 * The FileViewer resolves the path via the readFile verb on every open —
	 * content is never cached, so re-opening always reads from disk. */
	fileViewer: { path: string; line?: number } | null;
	openFileViewer: (path: string, line?: number) => void;
	closeFileViewer: () => void;

	// Notifications
	notifications: Toast[];
	pushToast: (id: string, message: string) => void;
	dismissToast: (id: string) => void;

	// Actions
	setFocusedTurnId: (id: string | null) => void;
	/** Toggle a group and freeze it against streaming auto-expand.
	 * Passing the group's action card keys also resets those actions to collapsed
	 * (the header is the master toggle — reopening shows all descendants
	 * collapsed, not their pre-collapse state). On open, a single-action group
	 * auto-expands its lone action's details. Atomic with the group toggle. */
	toggleActionGroup: (key: string, cardKeys?: string[]) => void;
	/** Toggle an action's details and freeze it against streaming auto-expand. */
	toggleAction: (key: string) => void;
	/** Toggle the max-height cap on an expanded action's details. */
	toggleUncapDetails: (key: string) => void;
	/** Toggle line wrap for card content (code + output). */
	toggleCardWrap: () => void;
	/** Toggle markdown rendering for .md file content in cards. */
	toggleCardMarkdown: () => void;
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
// Slice factory
// ---------------------------------------------------------------------------

export const createUiSlice: StateCreator<ClientStore, [], [], UiSlice> = (set) => ({
	focusedTurnId: null,
	expandedActionGroups: new Set(),
	expandedActions: new Set(),
	uncappedDetails: new Set(),
	cardWrap: true,
	cardMarkdown: true,
	frozenActionGroups: new Set(),
	frozenActions: new Set(),
	loadingPaths: new Set(),
	pullTick: 0,

	scrollToEntryId: null,

	renderLeafId: null,

	fileViewer: null,

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

	setScrollToEntryId: (scrollToEntryId) => set({ scrollToEntryId }),

	setRenderLeaf: (id) =>
		set((s) => {
			if (id === null) return { renderLeafId: null };
			const target = resolveRenderLeafTarget(s.document.entries, id, s.document.status.leafId);
			// undefined: no committed entry beneath — nothing to render (no-op).
			return target === undefined ? s : { renderLeafId: target };
		}),

	openFileViewer: (path, line) => set({ fileViewer: line === undefined ? { path } : { path, line } }),
	closeFileViewer: () => set({ fileViewer: null }),

	setFocusedTurnId: (focusedTurnId) => set({ focusedTurnId }),

	// Freeze on interaction (ADR 07 §Expand-state keys): a manual toggle
	// adds the key to the frozen set so streaming auto-expand no longer
	// drives it. Frozen sets are permanent.
	// Header is the master toggle (nit 3): toggling the group also resets
	// every action below it to collapsed, so reopening always shows descendants
	// collapsed rather than their pre-collapse expand state. Atomic with the group
	// toggle so the two never paint a mixed state. On open, a single-action
	// group auto-expands its lone action's details — opening a one-action
	// group to see a collapsed action is a wasted click.
	toggleActionGroup: (key, cardKeys = []) =>
		set((s) => {
			const wasExpanded = s.expandedActionGroups.has(key);
			const expandedActionGroups = setToggle(s.expandedActionGroups, key);
			const frozenActionGroups = setAdd(s.frozenActionGroups, key);
			if (cardKeys.length === 0) return { expandedActionGroups, frozenActionGroups };
			const expandedActions = new Set(s.expandedActions);
			const frozenActions = new Set(s.frozenActions);
			for (const ck of cardKeys) {
				expandedActions.delete(ck);
				frozenActions.delete(ck);
			}
			if (!wasExpanded && cardKeys.length === 1) expandedActions.add(cardKeys[0]);
			return { expandedActionGroups, frozenActionGroups, expandedActions, frozenActions };
		}),

	toggleAction: (key) =>
		set((s) => ({
			expandedActions: setToggle(s.expandedActions, key),
			frozenActions: setAdd(s.frozenActions, key),
		})),

	toggleUncapDetails: (key) => set((s) => ({ uncappedDetails: setToggle(s.uncappedDetails, key) })),
	toggleCardWrap: () => set((s) => ({ cardWrap: !s.cardWrap })),
	toggleCardMarkdown: () => set((s) => ({ cardMarkdown: !s.cardMarkdown })),

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
});

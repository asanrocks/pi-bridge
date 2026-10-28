// ============================================================================
// Entry projection — the one place where live forms and persisted entries
// become a Document.
//
// pi is an asynchronous machine: an entry is authoritative once it appears in
// pi's entry list, and an event is a hint that something moved plus, for an item
// in flight, a stream of live content. This module owns that merge:
//
//   refresh(snapshot)  installs the appended authoritative suffix, seals the
//                      matching live forms, and selects pi's leaf;
//   applyEvent(event)  creates or updates the live form of the item in flight;
//   settle()           drops live forms that never became entries.
//
// Two rules keep the merge total. A sealed entry is never written by an event,
// so a delayed stream cannot overwrite persisted content. A live form is only
// addressed by the id pi reserved for the item, so there is no matching
// heuristic to get wrong.
//
// Browser-safe: no Node, no DOM.
// ============================================================================

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	applyEvent as applyLiveEvent,
	applyPatch,
	deriveSessionName,
	deriveStatsForEntries,
	projectEntry,
	type SessionLifecycleEvent,
	setAtPath,
} from "./document.ts";
import type { Document, Entry, JsonValue, Patch, PatchOp } from "./types.ts";
import { isEntrySealed } from "./types.ts";

/** One synchronous read of pi's entry list: see `SessionManager.readEntries`. */
export interface EntrySnapshot {
	/** The appended authoritative entries, in file order, starting at `from`. */
	entries: SessionEntry[];
	/** The position to read from next. */
	next: number;
	/** The leaf pi currently selects. */
	leafId: string | null;
	/** Changes when the ordered list is replaced wholesale. */
	version: number;
}

export interface EntryProjection {
	/** Apply a live event. Never writes an entry that already sealed. */
	applyEvent(event: SessionLifecycleEvent): Patch | null;
	/** Install authoritative entries, derive status, and select pi's leaf. */
	refresh(snapshot: EntrySnapshot): Patch | null;
	/** Read through `read` and refresh. A version change re-reads from zero,
	 * because a suffix read from the old position describes a list that no
	 * longer exists. */
	refreshFrom(read: (from: number) => EntrySnapshot): Patch | null;
	/** Remove live forms that have no authoritative entry. */
	settle(): Patch | null;
	/** The position the next refresh must read from. */
	readonly position: number;
}

/** Entry lookup that may include entries a Patch has not been applied for. */
type Lookup = (id: string) => Entry | undefined;

/**
 * Build a projection over `holder.document`. The holder is mutated in place, so
 * the caller keeps the Document in one place while the projection owns how it
 * changes.
 */
export function createEntryProjection(holder: { document: Document }): EntryProjection {
	/** Live forms by id, in creation order. */
	const live = new Set<string>();
	// pi's leaf as of the last refresh. Live forms may extend it; events never
	// move it.
	let piLeaf: string | null = null;
	let position = 0;
	let version: number | null = null;

	const emit = (ops: PatchOp[]): Patch | null => {
		if (ops.length === 0) return null;
		holder.document = applyPatch(holder.document, ops);
		return { ops };
	};

	/** pi's selected path (its leaf and ancestors), cached per leaf. Sealed
	 * entries are immutable, so the ancestor chain of one leaf only changes
	 * when the leaf does; a wholesale rewrite invalidates the cache because it
	 * can reuse a leaf id against new ancestors. */
	let selectedPath: { leaf: string | null; ids: Set<string> } | null = null;
	const selectedPathOf = (lookup: Lookup): Set<string> => {
		if (selectedPath?.leaf === piLeaf) return selectedPath.ids;
		const ids = new Set<string>();
		let cursor = piLeaf;
		while (cursor !== null) {
			ids.add(cursor);
			const entry = lookup(cursor);
			if (!entry) break;
			cursor = entry.parentId;
		}
		selectedPath = { leaf: piLeaf, ids };
		return ids;
	};

	/**
	 * The deepest live entry attached to pi's selected path, else pi's leaf.
	 * "Attached" means the parent chain reaches pi's selected leaf or one of
	 * its ancestors: a live form parented onto a sealed entry of another
	 * branch is not the selected continuation and must not be rendered as
	 * such, and a live form whose chain reaches nothing is not rendered.
	 */
	const effectiveLeaf = (lookup: Lookup): string | null => {
		if (live.size === 0) return piLeaf;
		const selected = selectedPathOf(lookup);
		for (const id of [...live].reverse()) {
			let cursor: string | null = id;
			while (cursor !== null && live.has(cursor)) {
				cursor = lookup(cursor)?.parentId ?? null;
			}
			// `cursor` is the first sealed ancestor (null for a live root).
			if (cursor !== null && selected.has(cursor)) return id;
		}
		return piLeaf;
	};

	const leafOp = (leaf: string | null): PatchOp | null =>
		(holder.document.status.leafId ?? null) === leaf
			? null
			: { op: "replace", path: "/status/leafId", value: (leaf ?? null) as unknown as JsonValue };

	const refresh = (snapshot: EntrySnapshot): Patch | null => {
		const doc = holder.document;
		const ops: PatchOp[] = [];
		let base = position;
		let rewrite = false;

		if (version !== null && snapshot.version !== version) {
			// The entry list was replaced wholesale: no installed position
			// describes it any more, so this snapshot starts the new prefix and
			// installed entries not in it are gone.
			base = 0;
			rewrite = true;
			selectedPath = null;
		}
		version = snapshot.version;

		// A refresh that installs nothing and is not a rewrite must stay O(live
		// forms): the Manager refreshes after every event, so copying or
		// enumerating the entry map here would put history-sized work on the
		// token cadence. A refresh that installs a suffix copies the map once
		// and inserts plainly — routing the ops through applyPatch instead
		// would shallow-copy the map per op, quadratic on a bootstrap-sized
		// suffix.
		const after: Record<string, Entry> = snapshot.entries.length > 0 || rewrite ? { ...doc.entries } : doc.entries;

		for (let i = 0; i < snapshot.entries.length; i++) {
			const entry = projectEntry(snapshot.entries[i]!, base + i);
			live.delete(entry.id);
			after[entry.id] = entry;
			// Replace wholesale: the persisted entry is authoritative for its
			// content, metadata, and position, and a live form may differ in all
			// three.
			ops.push({ op: "add", path: `/entries/${entry.id}`, value: entry as unknown as JsonValue });
		}
		// The suffix ends at the snapshot's own next position: it is the length
		// of the whole list, so a reader that clamped or lied about `from` still
		// converges instead of drifting.
		position = snapshot.next;
		piLeaf = snapshot.leafId;

		if (rewrite) {
			const authoritative = new Set(snapshot.entries.map((entry) => entry.id));
			for (const id of Object.keys(after)) {
				if (authoritative.has(id) || live.has(id)) continue;
				delete after[id];
				ops.push({ op: "remove", path: `/entries/${id}` });
			}
		}

		const lookup: Lookup = (id) => after[id];
		const leaf = effectiveLeaf(lookup);
		let status = doc.status;
		// Stats describe the rendered branch, so they move when an entry was
		// installed *or* the selection moved — a branch switch with no append
		// still changes the path the totals describe.
		if (ops.length > 0 || (status.leafId ?? null) !== leaf) {
			const stats = deriveStatsForEntries(after, leaf);
			if (JSON.stringify(stats) !== JSON.stringify(status.stats)) {
				ops.push({ op: "replace", path: "/status/stats", value: stats as unknown as JsonValue });
				status = { ...status, stats };
			}
		}
		// An installed session_info is an authoritative rename: re-derive the
		// name so a reopen (bootstrap) or a silent append publishes it. The
		// rename event lands after the append, so the two agree; deriving only
		// when the suffix carries one keeps an unrelated refresh from touching
		// the name a live event just set.
		if (snapshot.entries.some((entry) => entry.type === "session_info")) {
			const name = deriveSessionName(after);
			if (name !== status.name) {
				ops.push({ op: "replace", path: "/status/name", value: name });
				status = { ...status, name };
			}
		}
		if ((status.leafId ?? null) !== leaf) {
			ops.push({ op: "replace", path: "/status/leafId", value: (leaf ?? null) as unknown as JsonValue });
			status = { ...status, leafId: leaf };
		}
		if (ops.length === 0) return null;
		holder.document = { status, entries: after };
		return { ops };
	};

	/** True when the event's target entry is already authoritative. */
	const targetsSealed = (event: SessionLifecycleEvent): boolean => {
		const entryId = (event as { entryId?: string }).entryId;
		if (entryId === undefined) return false;
		const entry = holder.document.entries[entryId];
		return entry !== undefined && isEntrySealed(entry);
	};

	const applyEvent = (event: SessionLifecycleEvent): Patch | null => {
		// A delayed stream for an entry that already sealed must not overwrite
		// persisted content, and must not recreate a live form.
		const contentEvent =
			event.type === "message_start" ||
			event.type === "message_update" ||
			event.type === "message_end" ||
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_update" ||
			event.type === "tool_execution_end";
		if (contentEvent && targetsSealed(event)) return null;

		const patch = applyLiveEvent(holder.document, event);
		if (!patch) return null;

		const entryId = (event as { entryId?: string }).entryId;
		const created = patch.ops.some(
			(op) => op.op === "add" && entryId !== undefined && op.path === `/entries/${entryId}`,
		);
		if (created && entryId !== undefined) live.add(entryId);

		const ops = [...patch.ops];
		const leafChange = leafOp(effectiveLeaf((id) => holder.document.entries[id]));
		if (leafChange) ops.push(leafChange);
		return emit(ops);
	};

	/** Read through `read` and refresh, re-reading from zero when the entry
	 * list was replaced wholesale: the suffix the old position selects belongs
	 * to a list this projection no longer holds. */
	const refreshFrom = (read: (from: number) => EntrySnapshot): Patch | null => {
		let snapshot = read(position);
		if (version !== null && snapshot.version !== version) {
			snapshot = read(0);
		}
		return refresh(snapshot);
	};

	const settle = (): Patch | null => {
		const doc = holder.document;
		const ops: PatchOp[] = [];
		const after: Record<string, Entry> = { ...doc.entries };
		for (const id of [...live]) {
			live.delete(id);
			if (after[id] === undefined) continue;
			delete after[id];
			ops.push({ op: "remove", path: `/entries/${id}` });
		}
		if (ops.length === 0) return null;

		const leaf = effectiveLeaf((id) => after[id]);
		const stats = deriveStatsForEntries(after, leaf);
		ops.push({ op: "replace", path: "/status/stats", value: stats as unknown as JsonValue });
		if ((doc.status.leafId ?? null) !== leaf) {
			ops.push({ op: "replace", path: "/status/leafId", value: (leaf ?? null) as unknown as JsonValue });
		}
		return emit(ops);
	};

	return {
		applyEvent,
		refresh,
		refreshFrom,
		settle,
		get position() {
			return position;
		},
	};
}

/** Set one status field, returning the op only when the value changed. */
export function statusOp(doc: Document, path: string, value: unknown): PatchOp | null {
	const current = getStatusAt(doc, path);
	if (JSON.stringify(current) === JSON.stringify(value)) return null;
	return { op: "replace", path, value: (value ?? null) as unknown as JsonValue };
}

function getStatusAt(doc: Document, path: string): unknown {
	let cursor: unknown = doc;
	for (const key of path.split("/").filter((part) => part !== "")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[key];
	}
	return cursor;
}

export { setAtPath };

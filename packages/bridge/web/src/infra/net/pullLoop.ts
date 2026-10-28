// ============================================================================
// Pull loop (ADR 09) — drains the pull queue, issues one batched pull.
// The sole fetcher: no component calls `pull` directly. Components declare
// pending pulls during render (enqueuePulls); this layer drains them (microtask-scheduled
// via setDrainer) and ingests the reply into the DocumentMirror.
// ============================================================================

import { getAtPath, isEntrySealed, type JsonValue, planPull } from "../../../../src/core/index.ts";
import { getStore } from "../state/store.tsx";
import { getGlobalClient } from "./client.ts";
import { drainPullQueue } from "./pullQueue.ts";

/** Consecutive-failure backoff for pull retries: 1s doubling, capped at 30s. */
let pullRetryDelay = 1000;
const PULL_RETRY_CAP = 30_000;
let pullRetryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRetryBump(): void {
	if (pullRetryTimer) return;
	const delay = pullRetryDelay;
	pullRetryDelay = Math.min(pullRetryDelay * 2, PULL_RETRY_CAP);
	pullRetryTimer = setTimeout(() => {
		pullRetryTimer = null;
		getStore().getState().bumpPullTick();
	}, delay);
}

export async function flushPullQueue(): Promise<void> {
	const client = getGlobalClient();
	const pending = drainPullQueue();
	// Disconnected: drop the pending pulls. On reconnect the replace push bumps
	// pullTick, components re-render and re-register.
	if (!client || pending.length === 0) return;

	const store = getStore();
	const loading = store.getState().loadingPaths;
	const needed = planPull(pending, client.mirror, loading);
	if (needed.length === 0) return;

	// The lifecycle form each pulled entry had when the request left. A pull
	// reads the canonical Document at that moment, so a reply describes that
	// form: a seal replaces the streamed entry under the same id with persisted
	// content, and filling an older read over it would show stale content that
	// no later patch repairs (the seal already landed).
	const sealedAtIssue = new Map<string, boolean>();
	for (const item of needed) {
		const entry = client.mirror.document.entries[item.entryId];
		if (entry) sealedAtIssue.set(item.entryId, isEntrySealed(entry));
	}

	// Mark in-flight
	const pathStrings = new Set(needed.map((n) => n.fieldPath));
	store.getState().setLoadingPaths(new Set([...loading, ...pathStrings]));

	try {
		const reply = await client.pull(needed);
		if (!reply.ok) throw new Error(String(reply.error ?? "pull failed"));

		// Stale-client guard: a reconnect replaces the global client, so this
		// reply belongs to a socket nothing listens to anymore — neither its
		// values nor its (frozen) mirror may reach the store. The reconnect's
		// replace push bumps pullTick, so visible fields re-register on their
		// own; no retry is scheduled for the dead request.
		if (getGlobalClient() !== client) return;

		const values = (reply as Record<string, unknown>).values as
			| Array<{ entryId: string; fieldPath: string; value: unknown }>
			| undefined;
		// Stale-value guards. A reply is a read of the state the request left, so
		// it may only fill a field that is still unfetched in the entry it was
		// issued for:
		//   - a session switch on this socket replaced the mirror, so the entries
		//     this pull addressed are gone — writing them would have `setAtPath`
		//     auto-create the missing parents and fabricate the old session's
		//     entries inside the successor (entry ids are unique per session, so
		//     a surviving id means the pull's session is still the mirror's);
		//   - a seal replaced the entry under the same id with persisted content;
		//   - a live patch already filled the field, and it is newer than a read
		//     taken before it (streamed appends included).
		const current = (values ?? []).filter((v) => {
			const entry = client.mirror.document.entries[v.entryId];
			if (entry === undefined) return false;
			if (sealedAtIssue.get(v.entryId) !== isEntrySealed(entry)) return false;
			const held = getAtPath(client.mirror.document, v.fieldPath);
			return held === null || held === undefined;
		});
		if (current.length > 0) {
			client.mirror.ingestPullResponse(
				current.map((v) => ({ entryId: v.entryId, fieldPath: v.fieldPath, value: v.value as JsonValue })),
			);
			// One store write, revision included: the document and its revision
			// describe the same mirror snapshot.
			store.getState().applyReplace(client.mirror.document, client.mirror.revision);
		}

		// Progress-gated bump (ADR 09 convergence): bump immediately only
		// when a non-null value was ingested. A null reply means the field
		// is not filled yet on an in-flight entry (deltas/seal will push
		// it) — retry rides the capped backoff, not the render cadence.
		// Committed entries never answer null (the persisted form installs
		// complete content) — if one does, that is a server bug and the
		// backoff merely degrades it instead of flickering.
		const gotValue = current.some((v) => v.value !== null);
		if (gotValue) {
			pullRetryDelay = 1000;
			// Bump so the VM recomputes with the ingested values — identical
			// VMs skip re-render via memo.
			store.getState().bumpPullTick();
		} else {
			scheduleRetryBump();
		}
	} catch {
		// ADR 09 failure policy: evict from loadingPaths (below, finally) and
		// bump pullTick after a capped-backoff delay so pull-requesting
		// components re-render and re-register. No tight loop: the retry rides
		// the render cadence.
		scheduleRetryBump();
	} finally {
		const remaining = new Set(getStore().getState().loadingPaths);
		for (const p of pathStrings) remaining.delete(p);
		getStore().getState().setLoadingPaths(remaining);
	}
}

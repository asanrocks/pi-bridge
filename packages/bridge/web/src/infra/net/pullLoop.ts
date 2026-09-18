// ============================================================================
// Pull loop (ADR 09) — drains the pull queue, issues one batched pull.
// The sole fetcher: no component calls `pull` directly. Components declare
// pending pulls during render (enqueuePulls); this layer drains them (microtask-scheduled
// via setDrainer) and ingests the reply into the DocumentMirror.
// ============================================================================

import { type JsonValue, planPull } from "../../../../src/core/index.ts";
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

	// Mark in-flight
	const pathStrings = new Set(needed.map((n) => n.fieldPath));
	store.getState().setLoadingPaths(new Set([...loading, ...pathStrings]));

	try {
		const reply = await client.pull(needed);
		if (!reply.ok) throw new Error(String(reply.error ?? "pull failed"));

		const values = (reply as Record<string, unknown>).values as
			| Array<{ entryId: string; fieldPath: string; value: unknown }>
			| undefined;
		if (values && values.length > 0) {
			client.mirror.ingestPullResponse(
				values.map((v) => ({ entryId: v.entryId, fieldPath: v.fieldPath, value: v.value as JsonValue })),
			);
			store.getState().applyReplace(client.mirror.document);
		}

		// Progress-gated bump (ADR 09 convergence): bump immediately only
		// when a non-null value was ingested. A null reply means the field
		// is not filled yet on an in-flight entry (deltas/seal will push
		// it) — retry rides the capped backoff, not the render cadence.
		// Committed entries never answer null (invariant 7; reconcile
		// backfills at seal) — if one does, that is a server bug and the
		// backoff merely degrades it instead of flickering.
		const gotValue = (values ?? []).some((v) => v.value !== null);
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

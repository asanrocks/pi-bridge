// In-flight tool elapsed — anchored to the host, ticked on the client.
//
// The daemon stamps a tool's start on `tool_execution_start` and projects
// `status.inFlightTools[toolCallId]` — milliseconds the tool had already run
// when that status was produced, measured on the host's monotonic clock. That
// value is a *host* clock reading, so subtracting it from a client `Date.now()`
// would show a skewed browser's clock error. Instead we rebase: on (re)receipt
// we compute a local anchor `Date.now() - serverElapsed`, then tick against the
// local clock. A stale server value must not re-anchor every render (that
// would freeze the elapsed at the value's age); only a *changed* server value
// — a reconnect initial sync carrying a fresh elapsed — re-anchors.
//
// Cache keyed by (session scope, toolCallId): the tool-call id is stable
// across the provisional→durable entry move and turn-subtree remounts, but it
// is only unique within one session, so the scope keeps a later session from
// inheriting an anchor left behind by an abandoned one. Mirrors the old
// client-stamped `useToolTiming`, but seeded from the host so a reload or a
// reconnect recovers the elapsed instead of losing it.

import { useEffect, useState } from "react";
import type { ToolActionVM } from "../../../../../src/viewmodel/index.ts";

/** One tool's local anchor plus the server value it was derived from. */
export interface ElapsedAnchor {
	/** Client `Date.now()` corresponding to the tool's start. */
	localAnchor: number;
	/** The `status.inFlightTools` value this anchor was computed from. */
	serverElapsed: number | undefined;
}

/** Pure rebase step: keep the anchor unless the server value changed. */
export function anchorElapsed(
	prev: ElapsedAnchor | undefined,
	now: number,
	serverElapsedMs: number | undefined,
): ElapsedAnchor {
	if (prev === undefined || serverElapsedMs !== prev.serverElapsed) {
		return { localAnchor: now - (serverElapsedMs ?? 0), serverElapsed: serverElapsedMs };
	}
	return prev;
}

const anchorsByScope = new Map<string, Map<string, ElapsedAnchor>>();

function anchorsFor(scope: string | null): Map<string, ElapsedAnchor> {
	const key = scope ?? "";
	let anchors = anchorsByScope.get(key);
	if (anchors === undefined) {
		anchors = new Map();
		anchorsByScope.set(key, anchors);
	}
	return anchors;
}

/** Drop every anchor for a scope other than `scope`. Called when the active
 * session changes, so a session left behind with a tool still running does not
 * pin its anchor in memory or leak it into a later session reusing the id. */
export function keepOnlyInFlightScope(scope: string | null): void {
	const keep = scope ?? "";
	for (const key of anchorsByScope.keys()) {
		if (key !== keep) anchorsByScope.delete(key);
	}
}

/** Clear one tool's anchor once it settles. */
export function clearInFlightAnchor(scope: string | null, toolCallId: string): void {
	// No scope entry means the tool never anchored — do not create an empty map.
	anchorsByScope.get(scope ?? "")?.delete(toolCallId);
}

/** Read-or-create the anchor for one tool and return the live elapsed. Owns
 * the module cache; exported so the scope isolation is unit-testable. */
export function resolveInFlightElapsed(
	scope: string | null,
	toolCallId: string,
	now: number,
	serverElapsedMs: number | undefined,
): number {
	const anchors = anchorsFor(scope);
	const anchor = anchorElapsed(anchors.get(toolCallId), now, serverElapsedMs);
	anchors.set(toolCallId, anchor);
	return now - anchor.localAnchor;
}

/**
 * Live elapsed for a running tool, or null when there is nothing to show
 * (not running, no id). `scope` is the active session id: the anchor cache is
 * per-session so a session switch cannot reuse another session's anchor for a
 * colliding tool-call id. The first render anchors at the server-provided
 * elapsed (0 when the tool just started); a tick re-renders once per second;
 * a changed server value re-anchors (reconnect). Settled tools fall back to
 * pi's measured `durationMs`, so the anchor is dropped.
 */
export function useInFlightElapsed(
	scope: string | null,
	toolCallId: string,
	status: ToolActionVM["status"],
	serverElapsedMs: number | undefined,
): number | null {
	const [, setTick] = useState(0);

	useEffect(() => {
		if (status !== "running") return;
		const id = setInterval(() => setTick((t) => t + 1), 1000);
		return () => clearInterval(id);
	}, [status]);

	// Entering a different session discards the anchor cache of the session we
	// left behind — its running tools will never settle in this tab.
	useEffect(() => {
		keepOnlyInFlightScope(scope);
	}, [scope]);

	useEffect(() => {
		if (status !== "done" && status !== "error") return;
		clearInFlightAnchor(scope, toolCallId);
	}, [status, scope, toolCallId]);

	if (status !== "running" || !toolCallId) return null;
	// Lazy-init in render (idempotent, safe under strict-mode double render) so
	// the first paint carries the value; an effect would miss the post-seal
	// remount case.
	return resolveInFlightElapsed(scope, toolCallId, Date.now(), serverElapsedMs);
}

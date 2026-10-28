// ============================================================================
// Projection driver — a test seam that drives createEntryProjection the way
// the Manager does: live events in, authoritative snapshots in, settle at
// boundaries. Pure; no harness, no Node services.
// ============================================================================

import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createEntryProjection, type Document, type Patch } from "../../src/core/index.ts";

export interface ProjectionDriver {
	/** The canonical document the projection mutates in place. */
	readonly document: Document;
	/** Apply one live event: creates or updates the live form of the item in flight. */
	applyEvent(event: AgentSessionEvent): Patch | null;
	/** Refresh from an append-only entry list: installs the suffix past the read position. */
	refresh(entries: SessionEntry[], leafId?: string | null): Patch | null;
	/** Replace the entry list wholesale (fork/reload): new version, read from zero. */
	rewrite(entries: SessionEntry[], leafId?: string | null): Patch | null;
	/** Drop live forms that never persisted. */
	settle(): Patch | null;
	/** The projection's read position: how many entries it has installed. */
	readonly position: number;
}

export function createDriver(initial: Document): ProjectionDriver {
	const holder = { document: initial };
	const projection = createEntryProjection(holder);
	let version = 1;

	const leafOf = (entries: SessionEntry[], leafId?: string | null): string | null =>
		leafId !== undefined ? leafId : (entries[entries.length - 1]?.id ?? null);

	return {
		get document() {
			return holder.document;
		},
		applyEvent: (event) => projection.applyEvent(event),
		refresh: (entries, leafId) =>
			projection.refresh({
				entries: entries.slice(projection.position),
				next: entries.length,
				leafId: leafOf(entries, leafId),
				version,
			}),
		rewrite: (entries, leafId) => {
			version += 1;
			return projection.refresh({
				entries: [...entries],
				next: entries.length,
				leafId: leafOf(entries, leafId),
				version,
			});
		},
		settle: () => projection.settle(),
		get position() {
			return projection.position;
		},
	};
}

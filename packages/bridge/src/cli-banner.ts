// ============================================================================
// The startup banner — the CLI's one human-facing output shape.
//
// Both roles print the same four facts: which build this is, what role it took
// and over which socket, which Project ids it serves, and the address a browser
// opens. The address is always the `/@latest` alias: it resolves to the newest
// Session and falls back to the launcher, so one line covers a fresh and a busy
// deployment alike, and no link has to name a Project or a stem.
//
// A Worker may not know the address: its registration has no reply to carry it,
// so it comes from the probe, and a daemon whose listener was still binding when
// the probe ran reports none. That case says so instead of printing a guess.
//
// Warnings and hints come last, so the facts stay in the same place whatever
// the role.
// ============================================================================

import { commit, date, version } from "./version.ts";

export interface BannerInput {
	/** The role and the socket it owns or dialed, e.g. `worker (connected to …)`. */
	readonly role: string;
	/** The Project ids this process serves; omitted when empty. */
	readonly projects: readonly string[];
	/** The daemon's browser base URL, or null when unknown. */
	readonly web: string | null;
	readonly note?: string;
}

export function bannerLines(info: BannerInput): string[] {
	const lines = [`pi-bridge ${version} (${commit}, ${date})`, `Role: ${info.role}`];
	if (info.projects.length > 0) lines.push(`Projects: ${info.projects.join(", ")}`);
	lines.push(
		info.web === null ? "Visit: unavailable (the daemon reported no web address)" : `Visit: ${info.web}/@latest`,
	);
	if (info.note !== undefined) lines.push(info.note);
	return lines;
}

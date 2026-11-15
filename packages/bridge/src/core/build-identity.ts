// ============================================================================
// build-identity — which build a peer runs, and whether two peers are one build.
//
// The app, the Daemon, and a Worker ship together: the Daemon serves the app's
// assets out of its own install. A peer running another build is not a
// compatible peer with fewer features, it is a different program, so identity is
// compared and never negotiated.
//
// The Daemon is the authority: it reports its stamp in `getDaemonInfo` (and in
// every `daemon_info_changed`), in the daemon-socket probe, and in the Worker
// handshake. A Worker or a launcher that disagrees is refused; a browser cannot
// be refused — it is already running — so it compares and acts on the answer.
//
// Identity is the commit, not the instant: a rebuild of one tree is the same
// program, and demanding a reload for it would be noise. `version` and `date`
// exist so the UI can say *which* build is on either side.
// ============================================================================

/** One build's identity, the shape every peer reports. `version` and `date` are
 * display metadata; `commit` is what is compared — with a `-dirty` suffix when
 * the tree the build was made from had uncommitted changes, so two dirty builds
 * of one tree still match each other. */
export interface BuildStamp {
	readonly version: string;
	readonly commit: string;
	readonly date: string;
}

/** The stamp of a build made without the stamp step: a source checkout's plain
 * `npm run build`, or a web bundle built in development mode. It is the marker
 * that switches the comparison off — a developer's loop is the developer's
 * problem, not a reading of the panel's. */
export const DEV_BUILD: BuildStamp = { version: "0.0.0", commit: "dev", date: "1970-01-01" };

/** True for a stamp that names a real revision. */
export function isReleaseBuild(stamp: BuildStamp): boolean {
	return stamp.commit !== DEV_BUILD.commit && stamp.commit !== "" && stamp.commit !== "unknown";
}

/** True when two peers run the same revision (see the module header). */
export function sameBuild(a: BuildStamp, b: BuildStamp): boolean {
	return a.commit === b.commit;
}

/** A structurally valid stamp from wire input, or null. The three boundaries
 * that read a stamp — the browser reply, the daemon-socket probe, and the Worker
 * handshake — all parse it here, because the peer on the other end may predate
 * the field. */
export function parseBuildStamp(value: unknown): BuildStamp | null {
	if (typeof value !== "object" || value === null) return null;
	const stamp = value as { version?: unknown; commit?: unknown; date?: unknown };
	if (typeof stamp.version !== "string" || typeof stamp.commit !== "string" || typeof stamp.date !== "string") {
		return null;
	}
	return { version: stamp.version, commit: stamp.commit, date: stamp.date };
}

/** What a host-side comparison found: the peer's stamp (null when it predates the
 * field) and the local one. The Daemon is canonical, so `own` is the Daemon's
 * stamp at the registration boundary and `peer` is the Daemon's at the probe.
 * A mismatch is reported, never enforced — a host link that already carries a
 * frame stream keeps it. */
export interface BuildMismatch {
	readonly peer: BuildStamp | null;
	readonly own: BuildStamp;
}

/** How a stamp is stated to a reader: `1.5.0+69a37925f`, or "a development
 * build" when there is no revision to name. */
export function buildLabel(stamp: BuildStamp): string {
	return isReleaseBuild(stamp) ? `${stamp.version}+${stamp.commit}` : "a development build";
}

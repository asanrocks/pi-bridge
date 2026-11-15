// ============================================================================
// buildMismatch — the app's half of the build check.
//
// The Daemon reports its build in `getDaemonInfo` (core/build-identity.ts).
// This app carries the stamp it was compiled with, so the two are compared as
// one fact: same commit, same program. A difference means the tab is running
// another build than the one the Daemon serves and answers, which is not a
// connection problem and cannot be repaired by retrying.
//
// Development is derived from the canonical side: the Daemon. A checkout daemon
// carries the marker stamp and switches the comparison off for every peer,
// including this one. The app's own stamp never disables it — a dev app against
// a stamped daemon is a real disagreement, and it is the page that has to move.
// ============================================================================

import type { BuildStamp, GetDaemonInfoReply } from "../../../../src/core/index.ts";
import { isReleaseBuild, parseBuildStamp, sameBuild } from "../../../../src/core/index.ts";

export interface BuildMismatch {
	/** The Daemon's reported build, null when its reply carried none — a Daemon
	 * older than the field, which is the same verdict as another commit. */
	readonly daemon: BuildStamp | null;
	/** The build this app was compiled with. */
	readonly app: BuildStamp;
}

/** Null when the app and the Daemon are one build, or when the Daemon's own stamp
 * says development. */
export function detectBuildMismatch(reply: GetDaemonInfoReply, app: BuildStamp): BuildMismatch | null {
	// Wire input: the field is required by the reply type, but a Daemon built
	// before the check omits it — exactly the disagreement the comparison names.
	const daemon = parseBuildStamp(reply.build);
	if (daemon === null) return { daemon: null, app };
	if (!isReleaseBuild(daemon)) return null;
	return sameBuild(daemon, app) ? null : { daemon, app };
}

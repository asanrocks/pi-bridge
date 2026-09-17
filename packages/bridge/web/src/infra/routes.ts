// ============================================================================
// routes — URL projection of the current session address (ADR 11).
//
//   /                                 project picker + active sessions
//   /<projectId>                      the Project's home: prompt input + sessions
//   /<projectId>/<relative-stem>      one session
//
// The session path is the remainder of the URL after the Project segment, so
// nested stems are supported. Each segment is percent-encoded; parsing decodes
// each segment once, so a stem containing a literal `%2F` round-trips as
// `%252F`. The URL is read at boot and written with replaceState — never a
// second live navigation state machine.
//
// The first segment is structurally a Project id; whether it is a *known* one
// is resolved against getDaemonInfo by the caller (useConnection), which
// falls back to `/` for unknown ids — the same treatment as any project route.
// ============================================================================

export type Route =
	| { kind: "launcher" }
	| { kind: "project"; projectId: string }
	| { kind: "session"; projectId: string; stem: string };

export function parseRoute(pathname: string): Route {
	const parts = pathname.split("/").filter((p) => p !== "");
	if (parts.length === 0) return { kind: "launcher" };
	let projectId: string;
	try {
		projectId = decodeURIComponent(parts[0]);
	} catch {
		return { kind: "launcher" };
	}
	if (parts.length === 1) return { kind: "project", projectId };
	try {
		const stem = parts
			.slice(1)
			.map((p) => decodeURIComponent(p))
			.join("/");
		if (stem === "") return { kind: "project", projectId };
		return { kind: "session", projectId, stem };
	} catch {
		return { kind: "project", projectId };
	}
}

function encodeSegment(segment: string): string {
	return encodeURIComponent(segment);
}

export function launcherPath(): string {
	return "/";
}

export function projectPath(projectId: string): string {
	return `/${encodeSegment(projectId)}`;
}

export function sessionPath(projectId: string, stem: string): string {
	const encoded = stem.split("/").map(encodeSegment).join("/");
	return `/${encodeSegment(projectId)}/${encoded}`;
}

/** Write the address into the URL without a history entry (ADR 11). */
export function writeRoute(route: Route): void {
	const path =
		route.kind === "launcher"
			? launcherPath()
			: route.kind === "project"
				? projectPath(route.projectId)
				: sessionPath(route.projectId, route.stem);
	if (window.location.pathname !== path) {
		window.history.replaceState(null, "", path);
	}
}

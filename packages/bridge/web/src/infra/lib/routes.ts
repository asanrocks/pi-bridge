// ============================================================================
// routes — URL projection of the current session address (ADR 11) plus the
// alias namespace (ADR 13).
//
//   /                                 project picker + active sessions
//   /@<alias>                         an alias — resolved at launch, never
//                                     rewritten to its target (ADR 13)
//   /<projectId>                      the Project's home: prompt input + sessions
//   /<projectId>/<relative-stem>      one session
//
// The session path is the remainder of the URL after the Project segment, so
// nested stems are supported. Each segment is percent-encoded; parsing decodes
// each segment once, so a stem containing a literal `%2F` round-trips as
// `%252F`. The URL is read at boot and written with replaceState — never a
// second live navigation state machine.
//
// Aliases are single-segment and begin with `@`, a character outside the
// Project-id charset (`PROJECT_ID_RE`), so the alias namespace is structurally
// disjoint from Project ids: no reservation, no shadowing. An alias resolves
// to a session address once per boot/reconnect; the URL keeps the alias form
// while the store holds the resolved address until an explicit navigation
// writes a real one. Unknown or malformed aliases fall back to `/`.
// ============================================================================

/** Alias charset — same shape as PROJECT_ID_RE, minus the `@` sigil that
 * keeps the namespace disjoint from Project ids. */
const ALIAS_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type Route =
	| { kind: "launcher" }
	| { kind: "alias"; alias: string }
	| { kind: "project"; projectId: string }
	| { kind: "session"; projectId: string; stem: string };

export function parseRoute(pathname: string): Route {
	const parts = pathname.split("/").filter((p) => p !== "");
	if (parts.length === 0) return { kind: "launcher" };
	let first: string;
	try {
		first = decodeURIComponent(parts[0]);
	} catch {
		return { kind: "launcher" };
	}
	// Aliases are single-segment (ADR 13): anything after `/@x` is not an
	// alias route, and a `@` segment can never be a Project id.
	if (first.startsWith("@")) {
		const alias = first.slice(1);
		return parts.length === 1 && ALIAS_RE.test(alias) ? { kind: "alias", alias } : { kind: "launcher" };
	}
	const projectId = first;
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

/** The alias URL keeps its literal sigil: `@` is a legal path character and
 * stays outside the encoded Project-id charset. */
export function aliasPath(alias: string): string {
	return `/@${alias}`;
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
			: route.kind === "alias"
				? aliasPath(route.alias)
				: route.kind === "project"
					? projectPath(route.projectId)
					: sessionPath(route.projectId, route.stem);
	if (window.location.pathname !== path) {
		window.history.replaceState(null, "", path);
	}
}

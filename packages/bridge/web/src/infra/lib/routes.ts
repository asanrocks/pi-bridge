// ============================================================================
// routes — URL projection of the current session address (ADR 11) plus the
// alias namespace (ADR 13).
//
//   /                                 project picker + active sessions
//   /@<alias>                         a cross-Project alias — resolved at
//                                     boot/reconnect, never rewritten
//   /<projectId>/@<alias>             that Project's alias, same rules
//   /<projectId>                      the Project's home: prompt input + sessions
//   /<projectId>/<relative-stem>      one session
//
// The session path is the remainder of the URL after the Project segment, so
// nested stems are supported. Each segment is percent-encoded; parsing decodes
// each segment once, so a stem containing a literal `%2F` round-trips as
// `%252F`. The URL is read at boot and written with replaceState — never a
// second live navigation state machine.
//
// An alias begins with `@`, a prefix no Project id may carry, so the alias
// namespace is structurally disjoint from Project ids: no reservation, no
// shadowing. Its position is its scope — at the root it resolves across
// Projects, as a Project's last segment it resolves inside that Project, so
// the hierarchy always says what "latest" means. An alias resolves
// to a session address once per boot/reconnect; the URL keeps the alias form
// while the store holds the resolved address until an explicit navigation
// writes a real one. Unknown or malformed aliases fall back to `/`.
// ============================================================================

/** Alias charset — a narrower shape than Project ids, which may be any
 * non-empty, non-relative segment that does not begin with `@`. */
const ALIAS_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type Route =
	| { kind: "launcher" }
	/** `projectId` is the alias's scope: null spans Projects (the root form). */
	| { kind: "alias"; alias: string; projectId: string | null }
	| { kind: "project"; projectId: string }
	| { kind: "session"; projectId: string; stem: string };

export function parseRoute(pathname: string): Route {
	const parts = pathname.split("/").filter((p) => p !== "");
	if (parts.length === 0) return { kind: "launcher" };
	let segments: string[];
	try {
		segments = parts.map((part) => decodeURIComponent(part));
	} catch {
		return { kind: "launcher" };
	}
	const first = segments[0] as string;
	// Aliases live in their own namespace: a segment beginning with `@` can
	// never be a Project id, so nothing is reserved. Position is scope — the
	// root form spans Projects, a Project's last segment names that Project —
	// and anything else in an `@` position is not an alias route at all.
	if (first.startsWith("@")) {
		const alias = first.slice(1);
		return segments.length === 1 && ALIAS_RE.test(alias)
			? { kind: "alias", alias, projectId: null }
			: { kind: "launcher" };
	}
	if (segments.length === 2) {
		const second = segments[1] as string;
		if (second.startsWith("@")) {
			const alias = second.slice(1);
			return ALIAS_RE.test(alias) ? { kind: "alias", alias, projectId: first } : { kind: "launcher" };
		}
	}
	const projectId = first;
	if (segments.length === 1) return { kind: "project", projectId };
	const stem = segments.slice(1).join("/");
	if (stem === "") return { kind: "project", projectId };
	return { kind: "session", projectId, stem };
}

function encodeSegment(segment: string): string {
	return encodeURIComponent(segment);
}

export function launcherPath(): string {
	return "/";
}

/** The alias URL keeps its literal sigil: `@` is a legal path character and
 * stays outside the encoded Project-id charset. */
export function aliasPath(alias: string, projectId: string | null = null): string {
	return projectId === null ? `/@${alias}` : `/${encodeSegment(projectId)}/@${alias}`;
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
				? aliasPath(route.alias, route.projectId)
				: route.kind === "project"
					? projectPath(route.projectId)
					: sessionPath(route.projectId, route.stem);
	if (window.location.pathname !== path) {
		window.history.replaceState(null, "", path);
	}
}

// ============================================================================
// links — classify markdown link hrefs for click handling.
//
// LLM-authored markdown links are a mix of real URLs and filesystem paths
// (absolute, cwd-relative, `~`-relative, `file://` URIs). Streamdown's default
// link renderer treats every href as an external URL (link-safety modal →
// window.open), so a `./README.md` link would navigate to a 404 on the
// daemon origin. Classification decides the click target: URLs keep the
// external-link flow; paths go to the in-app file viewer via the readFile
// verb (resolved against the attached instance's cwd, server-side).
// ============================================================================

/** A classified link href. `file` paths are raw (unresolved) — the daemon
 * resolves them against the instance cwd. `line` is a `path:98` / `path:98:12`
 * suffix or a GitHub-style `#L98` fragment — a scroll anchor for the viewer,
 * stripped from the path before resolution. */
export type HrefTarget = { kind: "url"; url: string } | { kind: "file"; path: string; line?: number };

/** Streamdown's placeholder href for a link whose markdown is still
 * streaming (the label exists, the target doesn't yet). Not clickable. */
const INCOMPLETE_LINK_HREF = "streamdown:incomplete-link";

/** URL scheme per RFC 3986: letter followed by letters/digits/+/-/. and a
 * colon. Matched case-insensitively so `HTTPS://` classifies as a URL too. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export function classifyHref(href: string): HrefTarget | null {
	const raw = href.trim();
	if (raw === "" || raw === INCOMPLETE_LINK_HREF) return null;

	if (raw.startsWith("file://")) {
		// Malformed percent-escapes throw — fall back to the raw path.
		let decoded = raw.slice("file://".length);
		try {
			decoded = decodeURIComponent(decoded);
		} catch {
			// keep raw
		}
		const line = parseLineFragment(decoded);
		const path = stripFragment(decoded);
		return path ? { kind: "file", path, ...(line !== undefined ? { line } : {}) } : null;
	}

	// A trailing `path:98[:12]` suffix is an editor-idiom line anchor, not a
	// URL scheme — strip it before the scheme check so `foo.ts:98` classifies
	// as a file. If the remainder turns out to be a real URL (scheme + port
	// at the end, e.g. `http://host:8080`), the suffix was a port: return the
	// original href untouched.
	const lineSuffix = LINE_SUFFIX_RE.exec(raw);
	if (lineSuffix) {
		const remainder = raw.slice(0, raw.length - lineSuffix[0].length);
		if (!(SCHEME_RE.test(remainder) && remainder.indexOf(":") > 1)) {
			const line = Number(lineSuffix[1]);
			return remainder ? { kind: "file", path: remainder, line } : null;
		}
		return { kind: "url", url: raw };
	}

	// Single-letter "schemes" are Windows drive letters (C:\x, c:/x) — not URLs.
	if (SCHEME_RE.test(raw) && raw.indexOf(":") > 1) return { kind: "url", url: raw };

	const line = parseLineFragment(raw);
	const path = stripFragment(raw);
	return path ? { kind: "file", path, ...(line !== undefined ? { line } : {}) } : null;
}

/** Trailing line/column anchor: `:98` or `:98:12` at end of string. The
 * first number is the line; the optional second is a column (stripped). */
const LINE_SUFFIX_RE = /:(\d+)(?::\d+)?$/;

/** GitHub-style `#L98` fragment — the only fragment form carrying meaning
 * for a file read; heading anchors have no analogue on disk. */
function parseLineFragment(path: string): number | undefined {
	const hash = path.indexOf("#");
	if (hash < 0) return undefined;
	const match = /^L(\d+)$/.exec(path.slice(hash + 1));
	return match ? Number(match[1]) : undefined;
}

/** Drop a markdown fragment (`file.md#section`) — `#` is legal in filenames
 * but far more often a heading anchor in a file link. Query strings stay:
 * `?` in a file link is not an idiom. */
function stripFragment(path: string): string {
	const hash = path.indexOf("#");
	return hash >= 0 ? path.slice(0, hash) : path;
}

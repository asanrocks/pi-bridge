// ============================================================================
// paths — pure path arithmetic for the browser's absolute addressing (ADR 14).
//
// The browser's queries carry absolute paths; link and tool-card entry points
// carry whatever the agent wrote (cwd-relative, `~`-rooted, or absolute). These
// helpers turn the latter into the former client-side, so the host never has to
// guess a base. `~` is the one form left for the host to expand (it owns HOME).
//
// Browser-safe: no node:* imports. POSIX and Windows separators are both
// accepted, because the daemon may run on Windows.
// ============================================================================

/** True for an absolute POSIX path (`/x`) or Windows path (`C:\x`, `C:/x`,
 * `\\server\share`). */
export function isAbsolutePath(path: string): boolean {
	if (path.startsWith("/")) return true;
	if (path.startsWith("\\\\")) return true;
	return /^[a-zA-Z]:[\\/]/.test(path);
}

/** True for a `~`-rooted path (expanded host-side, which owns HOME). */
export function isHomePath(path: string): boolean {
	return path === "~" || path.startsWith("~/") || path.startsWith("~\\");
}

/** Parent directory of an absolute path. Returns the path unchanged when it is
 * already a root (`/`, `C:\`, `~`). */
export function parentDirectory(path: string): string {
	if (path === "/" || path === "~" || /^[a-zA-Z]:[\\/]?$/.test(path)) return path;
	const trimmed = path.length > 1 && /[\\/]$/.test(path) ? path.slice(0, -1) : path;
	const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	if (cut < 0) return trimmed;
	if (cut === 0) return "/";
	// A Windows drive root (`C:\x` → `C:\`) keeps its separator.
	return /^[a-zA-Z]:$/.test(trimmed.slice(0, cut)) ? `${trimmed.slice(0, cut)}\\` : trimmed.slice(0, cut);
}

/** Join a base directory with a relative path, collapsing `.` and `..`.
 * An already-absolute path is returned unchanged (only normalized). */
export function resolveAgainst(base: string, path: string): string {
	const windows = /^[a-zA-Z]:[/]/.test(base) || base.includes("\\");
	const sep = windows ? "\\" : "/";
	const joined = isAbsolutePath(path) ? path : `${base}${base.endsWith("/") || base.endsWith("\\") ? "" : sep}${path}`;
	// Keep the root: a Windows drive (`C:\`) or a leading separator.
	const drive = /^([a-zA-Z]:)[\\/]?/.exec(joined);
	const prefix = drive ? `${drive[1]}${sep}` : isAbsolutePath(joined) ? sep : "";
	const rest = drive ? joined.slice(drive[0].length) : prefix === sep ? joined.replace(/^[\\/]+/, "") : joined;
	const parts: string[] = [];
	for (const segment of rest.split(/[\\/]/)) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			parts.pop();
			continue;
		}
		parts.push(segment);
	}
	return prefix + parts.join(sep) || prefix;
}

/** True when `path` is inside (or equal to) `root`. Compares whole path
 * segments, so `/a/bc` is not under `/a/b`. */
export function isUnder(root: string, path: string): boolean {
	if (root === path) return true;
	const trimmed = root.endsWith("/") || root.endsWith("\\") ? root.slice(0, -1) : root;
	return path.startsWith(`${trimmed}/`) || path.startsWith(`${trimmed}\\`);
}

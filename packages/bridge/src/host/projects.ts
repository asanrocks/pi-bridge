// ============================================================================
// Project configuration and session addressing (ADR 11) — Node-only.
//
// A Project is one allowlisted cwd plus its pi session storage namespace. A
// session is addressed by `(projectId, stem)`, where `stem` is the relative
// path of its file under the Project's session directory, minus `.jsonl`.
// ============================================================================

import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getDefaultSessionDir } from "@earendil-works/pi-coding-agent";

/** Validated project id shape (ADR 11). */
export const PROJECT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ProjectConfig {
	id: string;
	/** Canonical absolute cwd. */
	cwd: string;
	/** pi's cwd-derived session storage directory. Internal — never on the wire. */
	sessionDir: string;
}

/**
 * Split `--allow <path>` / `--allow <id>=<path>` at the first `=` only, so a
 * path may itself contain `=`.
 */
export function parseAllowEntry(entry: string): { id?: string; path: string } {
	const eq = entry.indexOf("=");
	if (eq > 0) return { id: entry.slice(0, eq), path: entry.slice(eq + 1) };
	return { path: entry };
}

/** Resolve and realpath a cwd, rejecting missing and non-directory paths. */
export function canonicalizeCwd(path: string): string {
	const abs = resolve(path);
	let real: string;
	try {
		real = realpathSync(abs);
	} catch {
		throw new Error(`--allow path does not exist: ${path}`);
	}
	if (!statSync(real).isDirectory()) throw new Error(`--allow path is not a directory: ${path}`);
	return real;
}

/** Lowercase basename of a canonical cwd. Empty for a filesystem root. */
export function deriveProjectId(cwd: string): string {
	return basename(cwd).toLowerCase();
}

/**
 * Materialize the daemon's Project list from `--allow` entries. Rejects
 * invalid or empty derived ids, invalid explicit ids, duplicate ids, and two
 * Projects resolving to the same pi session storage namespace.
 */
export function buildProjects(entries: string[], agentDir: string): ProjectConfig[] {
	const projects: ProjectConfig[] = [];
	const ids = new Set<string>();
	const sessionDirs = new Map<string, string>();

	for (const entry of entries) {
		const { id: explicitId, path } = parseAllowEntry(entry);
		const cwd = canonicalizeCwd(path);
		const id = explicitId ?? deriveProjectId(cwd);

		if (id === "") {
			throw new Error(`--allow ${path}: empty project id; use --allow <id>=<path>`);
		}
		if (!PROJECT_ID_RE.test(id)) {
			throw new Error(`Invalid project id "${id}": must match ${PROJECT_ID_RE} (use --allow <id>=<path>)`);
		}
		if (ids.has(id)) throw new Error(`Duplicate project id: ${id}`);
		ids.add(id);

		const sessionDir = getDefaultSessionDir(cwd, agentDir);
		const owner = sessionDirs.get(sessionDir);
		if (owner !== undefined) {
			throw new Error(`Projects "${owner}" and "${id}" share a session storage directory: ${sessionDir}`);
		}
		sessionDirs.set(sessionDir, id);

		projects.push({ id, cwd, sessionDir });
	}

	return projects;
}

/**
 * Normalize and validate a client-supplied stem. Returns the canonical form
 * (forward slashes, no empty/`.`/`..` components, no leading/trailing slash,
 * no `.jsonl` extension). Throws on anything that could escape the Project's
 * session directory.
 */
export function normalizeStem(stem: string): string {
	if (stem === "") throw new Error("Empty session stem");
	if (stem.includes("\0")) throw new Error("Invalid session stem");
	if (isAbsolute(stem) || /^[A-Za-z]:/.test(stem) || stem.startsWith("\\")) {
		throw new Error("Session stem must be relative");
	}
	if (stem.startsWith("/") || stem.endsWith("/")) throw new Error("Invalid session stem");
	const parts = stem.split("/");
	for (const part of parts) {
		if (part === "" || part === "." || part === "..") throw new Error("Invalid session stem");
	}
	if (parts[parts.length - 1].endsWith(".jsonl")) throw new Error("Session stem must not include .jsonl");
	return parts.join("/");
}

/**
 * Resolve a canonical stem to an absolute `.jsonl` path inside `sessionDir`.
 * Containment is enforced by filesystem resolution, not lexical normalization:
 * an existing target is realpath'd and re-checked, so intermediate and final
 * symlinks cannot escape.
 */
export function resolveStemPath(sessionDir: string, stem: string): string {
	const candidate = `${join(sessionDir, ...stem.split("/"))}.jsonl`;
	const dir = sessionDir.endsWith(sep) ? sessionDir : sessionDir + sep;
	if (!candidate.startsWith(dir)) throw new Error("Session stem escapes the project directory");
	if (existsSync(candidate)) {
		const real = realpathSync(candidate);
		if (!real.startsWith(dir)) throw new Error("Session stem escapes the project directory");
		return real;
	}
	return candidate;
}

/** The inverse of `resolveStemPath`: a session file's canonical stem. */
export function stemFromSessionPath(sessionDir: string, file: string): string {
	const rel = relative(sessionDir, file);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`Session file outside the project directory: ${file}`);
	}
	const stem = rel.split(sep).join("/");
	return stem.endsWith(".jsonl") ? stem.slice(0, -".jsonl".length) : stem;
}

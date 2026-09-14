// Git identity stamps (ADR 10) — shared payload definition for the host-side
// writer extension and the browser-side reader fold. Pure and browser-safe.
//
// A stamp is a pi `custom` entry that records the repository identity observed
// at a session boundary. Stamps store *transitions*: a stamp is written only
// when the identity differs from the last stamp on the active path, and the
// reader carries the last stamp forward to every subsequent user turn.

/** Reserved custom entry type. Namespaced to avoid collisions with user extensions. */
export const GIT_STAMP_CUSTOM_TYPE = "pi-bridge.git-stamp";

/** Which session boundary the observation was taken at. Delta storage makes
 * position alone ambiguous, so the payload is explicit. */
export type GitStampAnchor = "prompt" | "turn_end";

/** Persisted payload. Versioned because session entries outlive the code that
 * wrote them; unknown versions never establish a baseline and never render. */
export interface GitStampData {
	v: 1;
	anchor: GitStampAnchor;
	/** Full lower-case object ID (40 hex chars, or 64 for SHA-256 repos).
	 * Null for an unborn or otherwise unresolved HEAD. */
	commit: string | null;
	/** Short symbolic branch name. Null for detached HEAD. An unborn branch
	 * has a branch name with a null commit. */
	branch: string | null;
}

/** The identity key compared between observations. */
export interface GitIdentity {
	commit: string | null;
	branch: string | null;
}

const COMMIT_ID_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
// A single non-empty line with no control characters. Git itself produced the
// name, so no stricter refname-syntax check (would risk rejecting legitimate
// names).
const BRANCH_NAME_RE = /^[^\u0000-\u001f\u007f]+$/;

export function isValidCommitId(value: string): boolean {
	return COMMIT_ID_RE.test(value);
}

export function isValidBranchName(value: string): boolean {
	return value.length > 0 && !value.includes("\n") && BRANCH_NAME_RE.test(value);
}

/** Parse and validate raw git plumbing output into an identity value, or null
 * when the output shape is invalid (extra output, embedded newlines, wrong
 * length). `raw` is the trimmed stdout of a successful command. */
export function parseGitIdentity(commitRaw: string | null, branchRaw: string | null): GitIdentity | null {
	if (commitRaw !== null && !isValidCommitId(commitRaw)) return null;
	if (branchRaw !== null && !isValidBranchName(branchRaw)) return null;
	return { commit: commitRaw, branch: branchRaw };
}

/** Validate a stamp payload of unknown provenance (session file, wire mirror).
 * Returns null for anything that is not a well-formed v1 stamp. */
export function parseGitStampData(data: unknown): GitStampData | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
	const d = data as { v?: unknown; anchor?: unknown; commit?: unknown; branch?: unknown };
	if (d.v !== 1) return null;
	if (d.anchor !== "prompt" && d.anchor !== "turn_end") return null;
	if (d.commit !== null && typeof d.commit !== "string") return null;
	if (d.branch !== null && typeof d.branch !== "string") return null;
	if (d.commit !== null && !isValidCommitId(d.commit)) return null;
	if (d.branch !== null && !isValidBranchName(d.branch)) return null;
	return { v: 1, anchor: d.anchor, commit: d.commit, branch: d.branch };
}

/** Entry shape accepted by {@link parseGitStampEntry}: pi session entries use
 * `type`, bridge Document entries use `kind`. */
interface StampEntryLike {
	type?: unknown;
	kind?: unknown;
	customType?: unknown;
	data?: unknown;
}

/** Extract a valid v1 git stamp from a custom entry of either flavor
 * (pi SessionEntry or bridge Entry). Returns null for other entry kinds,
 * other custom types, and malformed payloads. */
export function parseGitStampEntry(entry: StampEntryLike): GitStampData | null {
	if (entry.type !== "custom" && entry.kind !== "custom") return null;
	if (entry.customType !== GIT_STAMP_CUSTOM_TYPE) return null;
	return parseGitStampData(entry.data);
}

/** Identity-key comparison for transition detection. */
export function sameGitIdentity(a: GitIdentity, b: GitIdentity): boolean {
	return a.commit === b.commit && a.branch === b.branch;
}

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
export type GitStampAnchor = "prompt" | "tool_end" | "turn_end" | "user_bash_end";

/** v1 payload (implemented baseline). Anchor set predates tool and user-bash
 * boundaries; no commit subject. */
export interface GitStampDataV1 {
	v: 1;
	anchor: "prompt" | "turn_end";
	commit: string | null;
	branch: string | null;
}

/** v2 payload: adds the HEAD commit subject and the tool/user-bash anchors. */
export interface GitStampDataV2 {
	v: 2;
	anchor: GitStampAnchor;
	commit: string | null;
	branch: string | null;
	/** First line of HEAD's commit message, best-effort: null for an unborn
	 * HEAD, a failed lookup, or a v1 stamp. Subject problems never invalidate
	 * a valid identity. */
	commitSubject: string | null;
}

/** Persisted payload. Versioned because session entries outlive the code that
 * wrote them; versions may be mixed in one file, and unknown versions never
 * establish a baseline and never render. */
export type GitStampData = GitStampDataV1 | GitStampDataV2;

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

/** All v2 anchors. */
const V2_ANCHORS = new Set<GitStampAnchor>(["prompt", "tool_end", "turn_end", "user_bash_end"]);

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

/** Validate a subject line of unknown provenance: non-empty, single line, no
 * control characters. Returns the subject or null (best-effort metadata — an
 * invalid subject clears itself, never the identity). */
export function parseCommitSubject(value: string): string | null {
	if (value.length === 0 || /[\n\r]/.test(value) || !BRANCH_NAME_RE.test(value)) return null;
	return value;
}

/** Validate a stamp payload of unknown provenance (session file, wire mirror).
 * Returns null for anything that is not a well-formed v1 or v2 stamp. A
 * mistyped or invalid `commitSubject` clears the subject but keeps the stamp:
 * subject lookup was best-effort at write time too. */
export function parseGitStampData(data: unknown): GitStampData | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
	const d = data as { v?: unknown; anchor?: unknown; commit?: unknown; branch?: unknown; commitSubject?: unknown };
	if (d.commit !== null && typeof d.commit !== "string") return null;
	if (d.branch !== null && typeof d.branch !== "string") return null;
	if (d.commit !== null && !isValidCommitId(d.commit)) return null;
	if (d.branch !== null && !isValidBranchName(d.branch)) return null;
	if (d.v === 1) {
		if (d.anchor !== "prompt" && d.anchor !== "turn_end") return null;
		return { v: 1, anchor: d.anchor, commit: d.commit, branch: d.branch };
	}
	if (d.v === 2) {
		if (typeof d.anchor !== "string" || !V2_ANCHORS.has(d.anchor as GitStampAnchor)) return null;
		const subject =
			d.commitSubject === undefined || d.commitSubject === null
				? null
				: typeof d.commitSubject === "string"
					? parseCommitSubject(d.commitSubject)
					: null;
		return { v: 2, anchor: d.anchor as GitStampAnchor, commit: d.commit, branch: d.branch, commitSubject: subject };
	}
	return null;
}

/** Entry shape accepted by {@link parseGitStampEntry}: pi session entries use
 * `type`, bridge Document entries use `kind`. */
interface StampEntryLike {
	type?: unknown;
	kind?: unknown;
	customType?: unknown;
	data?: unknown;
}

/** Extract a valid v1 or v2 git stamp from a custom entry of either flavor
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

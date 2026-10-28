// ============================================================================
// repository — the repository and filesystem read surface behind the
// daemon's attachment-free verbs (ADR 12/14): snapshot reads, directory
// listings, the review diff directive, `git show`, the comparison base, and
// Project-cwd path completion. Pure host-side Node: no Document, no
// Connection — callers hand absolute (or `~`-rooted) paths in and get wire
// values out. Extracted from the Daemon so the in-process execution link
// and a future remote one can share one implementation.
//
// Every spawn is bounded (a hard lifetime, a byte cap) and every wire
// argument is validated before a process starts; a missing path or
// directory is a value (`absent`), while an unusable state or a spawn
// failure is an error.
// ============================================================================

import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type {
	DirectoryEntry,
	DirectoryListing,
	GitDiffFileStat,
	GitDiffFileStatus,
	SnapshotFile,
} from "../core/index.ts";

// ── Snapshot reads (viewer + review payloads) ─────────────────────────────

/** Byte cap for snapshot reads. Larger content returns a prefix with
 * `truncated=true` — this is a human reading surface, not a data channel, and
 * an unbounded reply would stall the socket on huge files. A truncated
 * snapshot cannot be diffed; the review surface refuses it rather than
 * rendering a phantom tail. */
export const MAX_READ_FILE_BYTES = 256 * 1024;

// ── Git show (ADR 10 v2 change-card expansion) ──────────────────────────

/** Byte cap for `git show` output. Same rationale as MAX_READ_FILE_BYTES:
 a human reading surface, not a data channel. */
export const MAX_GIT_SHOW_BYTES = 128 * 1024;

/** Hard lifetime for the `git show` spawn, so a hanging git (interactive
 * hooks, exotic filters) cannot stall the RPC. */
const GIT_SHOW_TIMEOUT_MS = 5000;

/** Strict commit-id check before any spawn — the value arrives from the
 * wire, and `execFile` passes it as one argv entry, but it is also
 * interpolated into a git revision expression, so only a known-shape
 * object id is acceptable. */
const GIT_COMMIT_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** Run `git show --stat --no-color <commit>` in `cwd`. Exported for
 * Connection-level tests (the DaemonVerbs seam takes the same function).
 * Throws on non-hex commits, spawn failures, timeouts, and exit-nonzero
 * (unreachable commits — rebased/reset away — included), so the Connection
 * converts the message into an `ok:false` reply. */
export async function runGitShow(commit: string, cwd: string): Promise<{ output: string; truncated: boolean }> {
	if (!GIT_COMMIT_RE.test(commit)) throw new Error("Invalid commit id");
	return new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			["show", "--stat", "--no-color", commit],
			{ cwd, timeout: GIT_SHOW_TIMEOUT_MS, maxBuffer: MAX_GIT_SHOW_BYTES * 2, windowsHide: true },
			(err, stdout) => {
				if (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
					return;
				}
				const buf = Buffer.from(stdout, "utf8");
				resolve({
					output: buf.subarray(0, MAX_GIT_SHOW_BYTES).toString("utf8"),
					truncated: buf.length > MAX_GIT_SHOW_BYTES,
				});
			},
		);
		// execFile's timeout kills the child; the callback still fires with
		// an error, so no extra bookkeeping is needed.
		void child;
	});
}

// ── Review surface: diff + file-at-commit queries over the stamp timeline ──

/** Cap on changed files one diff directive returns; the remainder is reported
 * through `filesOmitted`. Keeps a pathological diff (a mass rename, a bad
 * commit) from crossing the wire and rendering as an unbounded review. */
export const MAX_DIFF_FILES = 2000;

/** Byte cap on each diff directive stream. `MAX_DIFF_FILES` bounds the
 * *returned* list, but a byte-truncated numstat cannot supply an exact
 * `filesOmitted`, so this is a memory guard whose breach is an error rather
 * than a silently partial review. Sized far above a realistic diff: one
 * numstat record is a few dozen bytes, so 16 MiB is hundreds of thousands of
 * changed files. */
const MAX_DIFF_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Review-state selector: a pinned object id, or the "head"/"index"/
 * "worktree" sentinels (see GitDiffState). Validated before any spawn. */
const GIT_DIFF_STATE_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|head|index|worktree)$/;

/** Map a validated non-index review state to its git revision argument.
 * "index" is not a revision: it selects the staged tree, which the argv
 * builder expresses with `--cached`. */
function diffStateArg(state: string): string {
	return state === "head" ? "HEAD" : state;
}

/** Validate a review path (from the wire). A `~`-rooted path is expanded by
 * the caller; anything else must be absolute (ADR 14), with no NUL and no
 * option-style leading dash, so it can safely be interpolated into a git
 * argument. */
function validateAbsolutePath(path: string): void {
	if (path === "" || path.includes("\0") || path.startsWith("-")) throw new Error("Invalid path");
}

/** Shared git-diff argv prefix. Fixed flags keep the output deterministic:
 * repo config cannot inject external diff drivers, textconv filters, color
 * codes, or `diff.relative` path rewriting; -M keeps rename detection on
 * regardless of git version. `--relative` (given explicitly, so it overrides
 * `diff.relative` config) makes every path relative to the process cwd — the
 * browser's `absDirectory` — and scopes the directive to that subtree, so
 * changes outside it are not listed. `--literal-pathspecs` is a global
 * option, so it precedes the subcommand. */
const GIT_DIFF_FLAGS = [
	"--literal-pathspecs",
	"diff",
	"--no-color",
	"--no-ext-diff",
	"--no-textconv",
	"--relative",
	"-M",
];

/** The directive argv for one state pair. Three trees make this a matrix
 * rather than a symmetric pair: `--cached` compares against the staged tree,
 * and an index-valued base is the reverse of the canonical commit → index
 * diff. `--relative` (in GIT_DIFF_FLAGS) scopes the result to the cwd subtree
 * and makes every path relative to it. */
function gitDiffArgv(oldState: string, newState: string, format: "numstat" | "raw"): string[] {
	const argv = [...GIT_DIFF_FLAGS, format === "raw" ? "--raw" : "--numstat", "-z"];
	if (oldState === "index") {
		// index → worktree is plain `git diff`; index → head/commit is the
		// reverse of `git diff --cached`.
		if (newState === "worktree") return argv;
		argv.push("--cached", "-R", diffStateArg(newState));
		return argv;
	}
	if (newState === "index") {
		argv.push("--cached", diffStateArg(oldState));
		return argv;
	}
	argv.push(diffStateArg(oldState));
	// "worktree" is expressed by omitting the second revision.
	if (newState !== "worktree") argv.push(diffStateArg(newState));
	return argv;
}

/** Run a git command with a bounded lifetime and a byte-capped stdout.
 * Streams (unlike execFile's maxBuffer, which kills with an error), so an
 * oversized diff truncates cleanly instead of failing: once the cap is hit
 * the child is killed and the exit code is no longer meaningful. Other
 * nonzero exits and spawn failures reject, except the codes listed in
 * `allowExitCodes` — `git diff --no-index` exits 1 whenever the paths differ,
 * which is its normal success path. */
function execGitCapped(
	argv: string[],
	cwd: string,
	cap = MAX_GIT_SHOW_BYTES,
	allowExitCodes: readonly number[] = [0],
): Promise<{ output: string; truncated: boolean }> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", argv, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const chunks: Buffer[] = [];
		let total = 0;
		let truncated = false;
		let failure: Error | null = null;
		let stderrTail = "";
		let exitCode: number | null = 0;
		let settled = false;
		let forceKillTimer: NodeJS.Timeout | undefined;
		// SIGTERM first, then SIGKILL: a child that ignores the graceful signal
		// must not leave the promise (and the RPC) pending forever.
		const killHard = () => {
			child.kill("SIGTERM");
			forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
		};
		const timer = setTimeout(() => {
			failure = new Error("git timed out");
			killHard();
		}, GIT_SHOW_TIMEOUT_MS);
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			fn();
		};
		child.stdout!.on("data", (chunk: Buffer) => {
			if (truncated || total >= cap) {
				if (!truncated) {
					truncated = true;
					killHard();
				}
				return;
			}
			if (total + chunk.length > cap) {
				chunks.push(chunk.subarray(0, cap - total));
				truncated = true;
				killHard();
				return;
			}
			chunks.push(chunk);
			total += chunk.length;
		});
		child.stderr!.on("data", (chunk: Buffer) => {
			if (stderrTail.length < 2048) stderrTail += chunk.toString("utf8");
		});
		child.on("error", (err) => {
			failure = err;
			killHard();
		});
		child.on("close", (code) => {
			exitCode = code;
			if (failure) {
				finish(() => reject(failure!));
				return;
			}
			const output = Buffer.concat(chunks).toString("utf8");
			if (truncated) finish(() => resolve({ output, truncated: true }));
			else if (exitCode === null || !allowExitCodes.includes(exitCode))
				finish(() => reject(new Error(stderrTail.trim() || `git exited ${exitCode}`)));
			else finish(() => resolve({ output, truncated: false }));
		});
	});
}

/** One numstat record before the raw directive supplies its status. */
interface NumstatRecord {
	path: string;
	oldPath?: string;
	additions: number;
	deletions: number;
	binary: boolean;
}

/** Parse `git diff --numstat -z` output. Regular records are
 * `adds\tdels\tpath\0`; rename/copy records carry the source in two extra
 * NUL-separated tokens (`adds\tdels\t\0src\0dst\0`). Binary files report
 * `-` counts. Only the first two tabs are separators: a filename may itself
 * contain a tab, and splitting on every tab would truncate it. */
function parseNumstat(output: string): NumstatRecord[] {
	const files: NumstatRecord[] = [];
	const tokens = output.split("\0");
	for (let i = 0; i < tokens.length; i++) {
		const record = tokens[i]!;
		const firstTab = record.indexOf("\t");
		const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
		if (secondTab === -1) continue;
		const addsRaw = record.slice(0, firstTab);
		const delsRaw = record.slice(firstTab + 1, secondTab);
		const path = record.slice(secondTab + 1);
		const binary = addsRaw === "-" || delsRaw === "-";
		const additions = binary ? 0 : Number(addsRaw) || 0;
		const deletions = binary ? 0 : Number(delsRaw) || 0;
		if (path === "") {
			// Rename/copy: the empty path announces two more NUL tokens.
			const src = tokens[++i];
			const dst = tokens[++i];
			if (src === undefined || dst === undefined || dst === "") continue;
			files.push({ path: dst, oldPath: src, additions, deletions, binary });
			continue;
		}
		files.push({ path, additions, deletions, binary });
	}
	return files;
}

/** Cap on untracked files one review directive lists. git's own diff omits
 * untracked paths, so the host enumerates them separately; the count is
 * bounded and the remainder reported as `untrackedOmitted` rather than
 * silently dropped. Untracked entries carry no line counts — content comes
 * from the payload fetch, so no per-file `--no-index` spawn is needed. */
export const MAX_UNTRACKED_FILES = 200;

/** Byte cap on the untracked listing itself, so a pathological tree cannot
 * stream an unbounded path list through the RPC. */
const MAX_UNTRACKED_LIST_BYTES = 4 * 1024 * 1024;

/** Untracked, non-ignored files as Project-cwd-relative paths, in git's
 * sorted order. Without `--full-name`, `ls-files` reports cwd-relative paths
 * and only paths under cwd — the same base as the tracked numstat
 * (`git diff --relative`). */
async function listUntracked(cwd: string): Promise<string[]> {
	const listing = await execGitCapped(
		["ls-files", "--others", "--exclude-standard", "-z"],
		cwd,
		MAX_UNTRACKED_LIST_BYTES,
	);
	const tokens = listing.output.split("\0").filter((p) => p !== "");
	// A byte-truncated listing can end mid-path: the last token is a fragment.
	if (listing.truncated) tokens.pop();
	return tokens;
}

/** Change kind from git's raw status letter (`--raw`). */
function parseRawStatus(code: string): GitDiffFileStatus {
	switch (code.charAt(0)) {
		case "A":
			return "added";
		case "M":
			return "modified";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "C":
			return "copied";
		case "T":
			return "typechange";
		case "U":
			return "unmerged";
		default:
			return "unknown";
	}
}

/** Parse `git diff --raw -z`: one `:oldmode newmode oldoid newoid status\0`
 * header per path, followed by the path — or, for a rename/copy, the source
 * path first and the destination second. Keyed by destination path. */
function parseRawStatuses(output: string): Map<string, { status: GitDiffFileStatus; oldPath?: string }> {
	const statuses = new Map<string, { status: GitDiffFileStatus; oldPath?: string }>();
	const tokens = output.split("\0");
	for (let i = 0; i < tokens.length; i++) {
		const header = tokens[i]!;
		if (!header.startsWith(":")) continue;
		const status = parseRawStatus(header.split(" ")[4] ?? "");
		const first = tokens[++i];
		if (first === undefined || first === "") continue;
		if (status === "renamed" || status === "copied") {
			const destination = tokens[++i];
			if (destination === undefined || destination === "") continue;
			statuses.set(destination, { status, oldPath: first });
			continue;
		}
		statuses.set(first, { status });
	}
	return statuses;
}

/** The diff *directive*: which files differ between two review states, with
 * git's line counts, statuses, binary flags, and rename pairs — never patch
 * text. Paths are relative to `absDirectory`, so they resolve through
 * `readFileAtSnapshot` like every other path in the protocol. Content is
 * fetched per file, so the renderer diffs whole snapshots instead of parsing
 * git's patch format. Untracked files belong to a worktree-side diff (git's
 * own diff omits them) and are listed without counts. Exported for
 * Connection-level tests (the same seam as runGitShow). Throws on invalid
 * states, spawn failures, timeouts, and exit-nonzero (unreachable commits
 * included). */
export async function runGitDiff(
	oldState: string,
	newState: string,
	absDirectory: string,
): Promise<{ files: GitDiffFileStat[]; filesOmitted?: number; untrackedOmitted: number }> {
	if (!GIT_DIFF_STATE_RE.test(oldState) || !GIT_DIFF_STATE_RE.test(newState)) throw new Error("Invalid diff states");
	if (oldState === "worktree") throw new Error("Invalid diff states");
	if (oldState === "index" && newState === "index") throw new Error("Invalid diff states");
	if (!isAbsolute(absDirectory)) throw new Error("Invalid directory");
	// Two directives, two parsers: numstat is the authority for which files are
	// listed (one record per file, so the argv is not byte-capped — the list is
	// exact and only the *returned* slice is capped), and raw supplies the
	// status letters. The worktree can drift between the spawns; the browser
	// does not claim they are one atomic observation.
	const [stat, raw] = await Promise.all([
		execGitCapped(gitDiffArgv(oldState, newState, "numstat"), absDirectory, MAX_DIFF_OUTPUT_BYTES),
		execGitCapped(gitDiffArgv(oldState, newState, "raw"), absDirectory, MAX_DIFF_OUTPUT_BYTES),
	]);
	// numstat is the file list, so a byte-truncated stream cannot yield an exact
	// `filesOmitted` (the records past the cut are uncountable) and is refused
	// instead of reported as a partial list. Raw is only the status letters: a
	// truncated tail leaves those paths `unknown`, which the renderer already
	// treats as an uncolored row.
	if (stat.truncated) throw new Error("Diff is too large to list");
	const statuses = parseRawStatuses(raw.output);
	const records = parseNumstat(stat.output);
	const files: GitDiffFileStat[] = records.slice(0, MAX_DIFF_FILES).map((record) => ({
		...record,
		status: statuses.get(record.path)?.status ?? "unknown",
	}));
	const filesOmitted = Math.max(0, records.length - MAX_DIFF_FILES);
	let untrackedOmitted = 0;
	if (newState === "worktree") {
		const untracked = await listUntracked(absDirectory);
		untrackedOmitted = Math.max(0, untracked.length - MAX_UNTRACKED_FILES);
		for (const path of untracked.slice(0, MAX_UNTRACKED_FILES)) {
			files.push({ path, status: "added", additions: 0, deletions: 0, binary: false, untracked: true });
		}
	}
	if (filesOmitted > 0) return { files, filesOmitted, untrackedOmitted };
	return { files, untrackedOmitted };
}

// ── Snapshot content (the payload half of the review surface) ────────────

/** True when the bytes look binary: a NUL in the first 8 KB, git's own
 * heuristic. */
function looksBinary(buf: Buffer): boolean {
	return buf.subarray(0, 8192).includes(0);
}

/** True when a state resolves to a tree; distinguishes "path not in this
 * tree" from "this state does not exist" after a failed object read. Peels to
 * `^{tree}`, not `^{commit}`: a commit peels to its tree, and the empty-tree
 * oid a root-commit review uses as its baseline is already one (ADR 14), so
 * both are states a path lookup can legitimately miss in. */
async function treeResolves(rev: string, cwd: string): Promise<boolean> {
	try {
		await execGitCapped(["rev-parse", "--verify", "--quiet", `${rev}^{tree}`], cwd);
		return true;
	} catch {
		return false;
	}
}

/** True when the index is listable. Paired with `treeResolves` so a failed
 * `cat-file` can be told apart: an index that reads fine but lacks the path
 * (or holds it unmerged, with no stage-0 blob) is `absent`, while an index
 * that cannot be read at all stays an error. */
async function indexResolves(root: string, rel: string): Promise<boolean> {
	try {
		await execGitCapped(["ls-files", "-z", "--cached", "--", rel === "" ? "." : rel], root, MAX_DIRECTORY_LIST_BYTES);
		return true;
	} catch {
		return false;
	}
}

/** The worktree half of the snapshot read: a direct, capped filesystem read.
 * Missing, non-file, or unreadable paths are `absent`. */
function readWorktreeAt(abs: string): SnapshotFile {
	try {
		const st = statSync(abs);
		if (!st.isFile()) return { kind: "absent", state: "worktree", path: abs };
		const len = Math.min(st.size, MAX_READ_FILE_BYTES);
		const buf = Buffer.alloc(len);
		const fd = openSync(abs, "r");
		try {
			readSync(fd, buf, 0, len, 0);
		} finally {
			closeSync(fd);
		}
		if (looksBinary(buf)) return { kind: "binary", state: "worktree", path: abs, bytes: st.size };
		return {
			kind: "file",
			state: "worktree",
			path: abs,
			content: buf.toString("utf8"),
			truncated: st.size > MAX_READ_FILE_BYTES,
			bytes: st.size,
		};
	} catch {
		return { kind: "absent", state: "worktree", path: abs };
	}
}

// ── Repository browser (ADR 14): absolute-path reads and listings ────────

/** Cap on entries one directory listing returns; the remainder is reported
 * through `omitted`. */
export const MAX_DIRECTORY_ENTRIES = 2000;

/** Byte cap on one staged-path listing. A directory with more staged content
 * than this is refused rather than silently reported as complete, because a
 * truncated flat path list cannot be converted into a trustworthy child set. */
const MAX_DIRECTORY_LIST_BYTES = 8 * 1024 * 1024;

/** Nearest existing directory at or above an absolute path, so git can be
 * asked about a file (or a path whose file is gone) from a directory that is
 * still there. */
function nearestExistingAncestor(abs: string): string | null {
	let current = abs;
	for (;;) {
		try {
			if (statSync(current).isDirectory()) return current;
		} catch {
			// Missing or unreadable: keep walking up.
		}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/** Repository root containing `absPath`, or null when it is outside a
 * repository. */
async function repoRootFor(absPath: string): Promise<string | null> {
	const start = nearestExistingAncestor(absPath);
	if (start === null) return null;
	try {
		const { output } = await execGitCapped(["rev-parse", "--show-toplevel"], start);
		const root = output.trim();
		return root === "" ? null : root;
	} catch {
		return null;
	}
}

/** `absPath` relative to `root` with forward slashes; null when outside.
 * The empty string is the repository root itself. */
function repoRelativePath(root: string, absPath: string): string | null {
	const rel = relative(root, absPath).split(sep).join("/");
	if (rel === ".." || rel.startsWith("../")) return null;
	return rel === "." ? "" : rel;
}

/** Expand a leading `~` — the one non-absolute form accepted from the wire.
 * Markdown links use it and the client has no HOME to expand it with. */
function expandTilde(path: string): string {
	if (path !== "~" && !path.startsWith("~/") && !path.startsWith("~\\")) return path;
	return (process.env.HOME ?? process.env.USERPROFILE ?? "") + path.slice(1);
}

/** Read one path at one repository state (ADR 14). Worktree reads
 * hit the filesystem; head/index/commit reads translate the path to a
 * repository-relative one and read git's tree or index. A path outside a
 * repository has no snapshot view: it is `absent`, not an error. Throws on an
 * invalid state, a relative path, or a spawn/timeout failure. */
export async function readFileAtSnapshot(path: string, state: string): Promise<SnapshotFile> {
	const absPath = expandTilde(path);
	validateAbsolutePath(absPath);
	if (!isAbsolute(absPath)) throw new Error("Invalid path");
	if (state === "worktree") return readWorktreeAt(absPath);
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64}|head|index)$/.test(state)) throw new Error("Invalid snapshot state");
	const root = await repoRootFor(absPath);
	const rel = root === null ? null : repoRelativePath(root, absPath);
	if (root === null || rel === null) return { kind: "absent", state, path: absPath };
	// `<rev>:<path>` resolves from the repository root; `:<path>` reads the index.
	const rev = state === "index" ? `:${rel}` : `${diffStateArg(state)}:${rel}`;
	let output: string;
	let truncated: boolean;
	try {
		// `cat-file blob` (rather than `show`) rejects a tree with a nonzero
		// exit, so asking to read a directory is `absent`, matching the
		// worktree side instead of returning git's tree listing as content.
		({ output, truncated } = await execGitCapped(["cat-file", "blob", rev], root, MAX_READ_FILE_BYTES));
	} catch (err) {
		// A nonzero exit means the path is absent from that tree — unless the
		// state itself does not resolve, which is a real failure (an unreachable
		// recorded commit, an unreadable index).
		const stateResolves =
			state === "index" ? await indexResolves(root, rel) : await treeResolves(diffStateArg(state), root);
		if (stateResolves) return { kind: "absent", state, path: absPath };
		throw err;
	}
	if (output.includes("\u0000")) {
		return { kind: "binary", state, path: absPath, bytes: Buffer.byteLength(output, "utf8") };
	}
	return {
		kind: "file",
		state,
		path: absPath,
		content: output,
		truncated,
		bytes: Buffer.byteLength(output, "utf8"),
	};
}

/** List one absolute directory's immediate children at one repository state
 * (ADR 14). Live listings read the filesystem; head/index/commit listings read
 * git's tree or index. A missing directory — or a snapshot state for a path
 * outside a repository — is `absent`, not an error. `.git` is never listed:
 * it is machine state, not project content. Throws on an invalid state, a
 * relative path, a spawn/timeout failure, or a staged listing over the byte
 * cap. */
export async function listDirectory(path: string, state: string): Promise<DirectoryListing> {
	const absPath = expandTilde(path);
	validateAbsolutePath(absPath);
	if (!isAbsolute(absPath)) throw new Error("Invalid path");
	if (state === "worktree") return listWorktreeDirectory(absPath);
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64}|head|index)$/.test(state)) throw new Error("Invalid snapshot state");
	const root = await repoRootFor(absPath);
	const rel = root === null ? null : repoRelativePath(root, absPath);
	if (root === null || rel === null) return { path: absPath, state, entries: [], omitted: 0, absent: true };
	if (state === "index") return listIndexDirectory(root, absPath, rel);
	return listTreeDirectory(root, absPath, rel, state);
}

/** Sort (directories first, then name), cap, and report the remainder. */
function finishListing(path: string, state: string, entries: DirectoryEntry[]): DirectoryListing {
	entries.sort((a, b) => {
		if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	const omitted = Math.max(0, entries.length - MAX_DIRECTORY_ENTRIES);
	return { path, state, entries: entries.slice(0, MAX_DIRECTORY_ENTRIES), omitted, absent: false };
}

/** The live half of `listDirectory`. A symlink to a directory is a directory. */
function listWorktreeDirectory(abs: string): DirectoryListing {
	let dirents: Dirent[];
	try {
		dirents = readdirSync(abs, { withFileTypes: true });
	} catch {
		return { path: abs, state: "worktree", entries: [], omitted: 0, absent: true };
	}
	const entries: DirectoryEntry[] = [];
	for (const dirent of dirents) {
		if (dirent.name === ".git") continue;
		let isDirectory = dirent.isDirectory();
		if (!isDirectory && dirent.isSymbolicLink()) {
			try {
				isDirectory = statSync(join(abs, dirent.name)).isDirectory();
			} catch {
				// Broken symlink: keep it as a file.
			}
		}
		entries.push({ name: dirent.name, path: join(abs, dirent.name), isDirectory });
	}
	return finishListing(abs, "worktree", entries);
}

/** A commit/head listing: `git ls-tree` is already non-recursive, so it
 * returns exactly the immediate children. */
async function listTreeDirectory(root: string, abs: string, rel: string, state: string): Promise<DirectoryListing> {
	const rev = diffStateArg(state);
	const revPath = rel === "" ? `${rev}:` : `${rev}:${rel}`;
	let output: string;
	try {
		({ output } = await execGitCapped(["ls-tree", "-z", revPath], root, Number.MAX_SAFE_INTEGER));
	} catch (err) {
		// A directory missing from this tree is `absent`; an unresolvable
		// state is an error (a missing git object is not an empty directory).
		if (await treeResolves(rev, root)) return { path: abs, state, entries: [], omitted: 0, absent: true };
		throw err;
	}
	const entries: DirectoryEntry[] = [];
	for (const token of output.split("\0")) {
		if (token === "") continue;
		const tab = token.indexOf("\t");
		if (tab === -1) continue;
		const type = token.slice(0, tab).split(" ")[1];
		const name = token.slice(tab + 1);
		// A tree is a directory; a submodule gitlink ("commit") is one too.
		entries.push({ name, path: join(abs, name), isDirectory: type === "tree" || type === "commit" });
	}
	return finishListing(abs, state, entries);
}

/** An index listing. The index holds no tree objects, so immediate children
 * are derived from the flat staged path list: its sorted order groups a
 * directory's children together, so the first path component after the
 * requested directory names them. */
async function listIndexDirectory(root: string, abs: string, rel: string): Promise<DirectoryListing> {
	const { output, truncated } = await execGitCapped(
		["ls-files", "-z", "--cached", "--stage", "--", rel === "" ? "." : rel],
		root,
		MAX_DIRECTORY_LIST_BYTES,
	);
	if (truncated) throw new Error("Directory listing is too large");
	const prefix = rel === "" ? "" : `${rel}/`;
	const children = new Map<string, boolean>();
	for (const token of output.split("\0")) {
		if (token === "") continue;
		const tab = token.indexOf("\t");
		if (tab === -1) continue;
		const path = token.slice(tab + 1);
		if (!path.startsWith(prefix)) continue;
		const rest = path.slice(prefix.length);
		if (rest === "") continue;
		const slash = rest.indexOf("/");
		const name = slash === -1 ? rest : rest.slice(0, slash);
		children.set(name, slash !== -1 || children.get(name) === true);
	}
	if (children.size === 0) return { path: abs, state: "index", entries: [], omitted: 0, absent: true };
	const entries: DirectoryEntry[] = [...children].map(([name, isDirectory]) => ({
		name,
		path: join(abs, name),
		isDirectory,
	}));
	return finishListing(abs, "index", entries);
}

/** Resolve the comparison base for reviewing one commit (ADR 14): the first
 * parent, or the repository's empty-tree oid for a root commit. The empty
 * tree is an internal diff base — it is not a commit and never a picker
 * value; clients only see it as the `baseline` of a commit review. Throws on
 * an invalid directory/commit, an unreachable commit, or a spawn failure. */
export async function resolveGitBase(directory: string, commit: string): Promise<{ baseline: string }> {
	if (!isAbsolute(directory) || directory.includes("\0")) throw new Error("Invalid directory");
	if (!GIT_COMMIT_RE.test(commit)) throw new Error("Invalid commit");
	// `^{commit}` distinguishes an unreachable commit (exit 1) from an existing
	// one; `^` then fails only for a root commit, whose base is the empty tree.
	const resolved = await execGitCapped(
		["rev-parse", "--verify", "--quiet", `${commit}^{commit}`],
		directory,
		MAX_GIT_SHOW_BYTES,
		[0, 1],
	);
	if (resolved.output.trim() === "") throw new Error("Unreachable commit");
	const parent = await execGitCapped(
		["rev-parse", "--verify", "--quiet", `${commit}^`],
		directory,
		MAX_GIT_SHOW_BYTES,
		[0, 1],
	);
	const parentOid = parent.output.trim();
	if (parentOid !== "") return { baseline: parentOid };
	// Empty stdin (stdio "ignore") makes hash-object emit the empty tree oid
	// for this repository's hash algorithm — sha1 or sha256, never hardcoded.
	const empty = await execGitCapped(["hash-object", "-t", "tree", "--stdin"], directory);
	return { baseline: empty.output.trim() };
}

// ── File path completion ─────────────────────────────────────────────────

const MAX_COMPLETIONS = 40;

/** Path completion (ADR 12): `prefix` resolves against the Project cwd, so
 * the Project home completes pre-send with no session attached. Directories
 * first, then name; hidden entries only when the prefix itself starts with a
 * dot; at most `MAX_COMPLETIONS` results. */
export function listFiles(prefix: string, cwd: string): Array<{ path: string; isDirectory: boolean }> {
	let searchDir: string;
	let fileFilter: string;

	if (prefix === "" || prefix === "./" || prefix === ".") {
		searchDir = cwd;
		fileFilter = "";
	} else if (prefix.startsWith("~")) {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "/";
		const rest = prefix.slice(1);
		if (rest === "" || rest === "/") {
			searchDir = home + rest;
			fileFilter = "";
		} else if (rest.endsWith("/")) {
			// A trailing slash names a directory itself; dirname would strip
			// the empty final component and list the parent instead.
			searchDir = (home + rest).replace(/\/+$/, "");
			fileFilter = "";
		} else {
			searchDir = dirname(home + rest);
			fileFilter = basename(rest);
		}
	} else if (prefix.endsWith("/")) {
		searchDir = isAbsolute(prefix) ? prefix : join(cwd, prefix);
		fileFilter = "";
	} else {
		const dir = dirname(prefix);
		fileFilter = basename(prefix);
		searchDir = dir === "." ? cwd : isAbsolute(dir) ? dir : join(cwd, dir);
	}

	try {
		const entries = readdirSync(searchDir, { withFileTypes: true });
		const results: Array<{ path: string; isDirectory: boolean }> = [];

		for (const entry of entries) {
			if (entry.name.startsWith(".") && !fileFilter.startsWith(".")) continue;
			if (fileFilter && !entry.name.toLowerCase().startsWith(fileFilter.toLowerCase())) continue;

			let isDirectory = entry.isDirectory();
			if (!isDirectory && entry.isSymbolicLink()) {
				try {
					isDirectory = statSync(join(searchDir, entry.name)).isDirectory();
				} catch {
					// broken symlink
				}
			}

			const entryPath =
				prefix.endsWith("/") || prefix === "" || prefix === "~"
					? (prefix === "~" ? "~/" : prefix) + entry.name
					: prefix.slice(0, prefix.lastIndexOf("/") + 1) + entry.name;

			results.push({ path: entryPath, isDirectory });
			if (results.length >= MAX_COMPLETIONS) break;
		}

		results.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
			return a.path.localeCompare(b.path);
		});

		return results;
	} catch {
		return [];
	}
}

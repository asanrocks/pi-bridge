// ============================================================================
// browserTree — the browser's two tree shapes, normalized to one node type
// (ADR 14). Pure and store-free: the container owns async loading and calls
// these on render.
//
//   • `all` scope — the visible slice of a lazily listed directory tree: a
//     directory node has children only once it is expanded and fetched.
//   • `changed` scope — a nested tree derived from the diff directive's paths
//     (never from walking the repository), with each file's change status.
//
// Browser-safe: no node:* imports.
// ============================================================================

import type { DirectoryEntry, GitDiffFileStat, GitDiffFileStatus } from "../../../../src/core/index.ts";
import type { TreeNode } from "./FileTree.tsx";

/** Join an absolute directory with git's `/`-separated relative path. */
function joinPath(dir: string, rel: string): string {
	const trimmed = dir.endsWith("/") || dir.endsWith("\\") ? dir.slice(0, -1) : dir;
	return `${trimmed}/${rel}`;
}

/** Directories first, then name — the order a file browser uses. */
function sortNodes(nodes: TreeNode[]): TreeNode[] {
	return nodes.sort((a, b) => {
		if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

/** The visible slice of the lazily listed tree: children appear only for
 * expanded directories that have been fetched. `changed` overlays status onto
 * listed paths (the full tree with change markers); `errored` marks
 * directories whose listing failed, which stay collapsed and clickable so the
 * next toggle retries instead of the node reading as empty. */
export function buildDirectoryTree(
	root: string,
	dirs: ReadonlyMap<string, DirectoryEntry[]>,
	expanded: ReadonlySet<string>,
	changed: ReadonlyMap<string, GitDiffFileStatus>,
	errored: ReadonlySet<string> = new Set(),
): TreeNode[] {
	const build = (dir: string): TreeNode[] =>
		sortNodes(
			(dirs.get(dir) ?? []).map((entry) => {
				const status = changed.get(entry.path);
				if (entry.isDirectory && errored.has(entry.path)) {
					return { name: entry.name, path: entry.path, isDirectory: true, error: true };
				}
				return {
					name: entry.name,
					path: entry.path,
					isDirectory: entry.isDirectory,
					...(status === undefined ? {} : { status }),
					...(entry.isDirectory && expanded.has(entry.path) ? { children: build(entry.path) } : {}),
				};
			}),
		);
	return build(root);
}

/** A nested tree over the directive's changed paths. Intermediate directories
 * are synthesized from the paths themselves. Changed children are prebuilt, so
 * expansion is expressed as the inverse: a directory in `collapsed` omits its
 * children (the all-scope tree lists lazily and uses the opposite set). */
export function buildChangedTree(
	root: string,
	files: readonly GitDiffFileStat[],
	collapsed: ReadonlySet<string> = new Set(),
): TreeNode[] {
	interface Dir {
		children: Map<string, Dir>;
		fileStatus: GitDiffFileStatus | null;
		fileOldPath: string | null;
		path: string;
	}
	const rootDir: Dir = { children: new Map(), fileStatus: null, fileOldPath: null, path: root };
	for (const file of files) {
		const segments = file.path.split("/").filter((s) => s !== "");
		let dir = rootDir;
		for (let i = 0; i < segments.length; i++) {
			const segment = segments[i]!;
			const last = i === segments.length - 1;
			let child = dir.children.get(segment);
			if (child === undefined) {
				child = { children: new Map(), fileStatus: null, fileOldPath: null, path: joinPath(dir.path, segment) };
				dir.children.set(segment, child);
			}
			if (last) {
				child.fileStatus = file.status;
				// A rename's source is relative to the directive root, like `file.path`.
				child.fileOldPath = file.oldPath === undefined ? null : joinPath(root, file.oldPath);
			}
			dir = child;
		}
	}
	const toNodes = (dir: Dir): TreeNode[] =>
		sortNodes(
			[...dir.children].map(([name, child]) => {
				const isDirectory = child.children.size > 0;
				return {
					name,
					path: child.path,
					isDirectory,
					...(child.fileStatus === null ? {} : { status: child.fileStatus }),
					...(child.fileOldPath === null ? {} : { oldPath: child.fileOldPath }),
					...(isDirectory && !collapsed.has(child.path) ? { children: toNodes(child) } : {}),
				};
			}),
		);
	return toNodes(rootDir);
}

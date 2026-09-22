// ============================================================================
// FileTree — the browser's presentational tree (ADR 14).
//
// Rendered from normalized nodes; the container owns loading, expansion, and
// selection. Two shapes feed it: the `all` scope's lazily listed directory
// nodes (a directory without `children` is not fetched yet) and the `changed`
// scope's prebuilt tree derived from the diff directive. A node's `status`
// carries the change overlay, which is what colors the row.
//
// Browser-safe: no node:* imports.
// ============================================================================

import { memo } from "react";
import type { GitDiffFileStatus } from "../../../../src/core/index.ts";
import styles from "./FileBrowser.module.css";

export interface TreeNode {
	name: string;
	/** Absolute path, for selection and for the next listing. */
	path: string;
	isDirectory: boolean;
	/** Change kind, when the tree has one (changed scope, or an overlay). */
	status?: GitDiffFileStatus;
	/** The listing for this directory failed; it is not empty. */
	error?: boolean;
	/** Absolute source path of a rename/copy, when git detected one. */
	oldPath?: string;
	/** Loaded children; undefined means "not fetched yet" for a directory. */
	children?: TreeNode[];
}

/** Row status letters, matching git's vocabulary rather than an icon set —
 * the same letters the diff directive reports. */
function statusLetter(status: GitDiffFileStatus | undefined): string {
	switch (status) {
		case "added":
			return "A";
		case "deleted":
			return "D";
		case "renamed":
			return "R";
		case "copied":
			return "C";
		case "typechange":
			return "T";
		case "unmerged":
			return "U";
		case "modified":
			return "M";
		default:
			return "";
	}
}

/** Basename of a `/`- or `\`-separated path. */
function baseName(path: string): string {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return cut === -1 ? path : path.slice(cut + 1);
}

/** True when `path` is `ancestor` itself or below it — the active-directory
 * test for the tree's highlight. */
function isAncestorOf(ancestor: string, path: string | undefined): boolean {
	if (path === undefined) return false;
	return path === ancestor || path.startsWith(`${ancestor}/`) || path.startsWith(`${ancestor}\\`);
}

export const FileTree = memo(function FileTree({
	nodes,
	selectedPath,
	onSelect,
	onToggle,
}: {
	nodes: TreeNode[];
	selectedPath?: string;
	onSelect: (node: TreeNode) => void;
	onToggle: (node: TreeNode) => void;
}) {
	return (
		<div className={styles.tree} role="tree">
			{nodes.map((node) => (
				<TreeRow
					key={node.path}
					node={node}
					depth={0}
					selectedPath={selectedPath}
					onSelect={onSelect}
					onToggle={onToggle}
				/>
			))}
		</div>
	);
});

function TreeRow({
	node,
	depth,
	selectedPath,
	onSelect,
	onToggle,
}: {
	node: TreeNode;
	depth: number;
	selectedPath?: string;
	onSelect: (node: TreeNode) => void;
	onToggle: (node: TreeNode) => void;
}) {
	const letter = statusLetter(node.status);
	const active = node.path === selectedPath;
	const inActivePath = node.isDirectory && isAncestorOf(node.path, selectedPath);
	// A rename carries both paths (ADR 14): the source basename the file came
	// from, struck through before the current name.
	const oldName = node.oldPath === undefined ? null : baseName(node.oldPath);
	const onClick = () => (node.isDirectory ? onToggle(node) : onSelect(node));
	return (
		<>
			<button
				type="button"
				role="treeitem"
				aria-expanded={node.isDirectory ? node.children !== undefined : undefined}
				aria-selected={active}
				className={styles.treeRow}
				data-active={active || undefined}
				data-on-path={inActivePath || undefined}
				data-status={letter || undefined}
				data-error={node.error || undefined}
				style={{ paddingLeft: `${depth * 12 + 6}px` }}
				title={
					node.error
						? `${node.path} — could not list this directory`
						: node.oldPath === undefined
							? node.path
							: `${node.oldPath} → ${node.path}`
				}
				onClick={onClick}
			>
				<span className={styles.treeMark}>{node.isDirectory ? (node.children === undefined ? "▸" : "▾") : ""}</span>
				{oldName !== null && <span className={styles.treeOldName}>{oldName}</span>}
				<span className={styles.treeName}>{node.name}</span>
				{letter && <span className={styles.treeStatus}>{letter}</span>}
				{!letter && node.error && (
					<span className={styles.treeStatus} role="img" aria-label="could not list">
						!
					</span>
				)}
			</button>
			{node.isDirectory &&
				node.children?.map((child) => (
					<TreeRow
						key={child.path}
						node={child}
						depth={depth + 1}
						selectedPath={selectedPath}
						onSelect={onSelect}
						onToggle={onToggle}
					/>
				))}
		</>
	);
}

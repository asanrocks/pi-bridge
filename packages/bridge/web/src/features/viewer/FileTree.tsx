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
import { baseName } from "../../infra/lib/paths.ts";
import { CaretIcon, FolderIcon, WarningIcon } from "../../render/icons.tsx";
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
/** True when `path` is `ancestor` itself or below it — the active-directory
 * test for the tree's highlight. */
function isAncestorOf(ancestor: string, path: string | undefined): boolean {
	if (path === undefined) return false;
	return path === ancestor || path.startsWith(`${ancestor}/`) || path.startsWith(`${ancestor}\\`);
}

export const FileTree = memo(function FileTree({
	nodes,
	root,
	selectedPath,
	onSelect,
	onToggle,
	onSelectRoot,
}: {
	nodes: TreeNode[];
	/** The tree's root, drawn as its own row: it is the one target that clears
	 * the selection, so "nothing selected" stays reachable once a file is. */
	root?: { path: string; name: string };
	selectedPath?: string;
	onSelect: (node: TreeNode) => void;
	onToggle: (node: TreeNode) => void;
	onSelectRoot?: () => void;
}) {
	return (
		<div className={styles.tree} role="tree">
			{root !== undefined && (
				// No caret: this row is the scope the listing already shows, not a fold —
				// a caret here would promise a collapse it cannot perform. The folder mark
				// keeps the depth-0 indent grid of the rows below it.
				<button
					type="button"
					role="treeitem"
					aria-selected={selectedPath === undefined}
					className={styles.treeRow}
					data-active={selectedPath === undefined || undefined}
					style={{ paddingLeft: "6px" }}
					title={root.path}
					onClick={onSelectRoot}
				>
					<span className={styles.treeMark}>
						<FolderIcon size={12} />
					</span>
					<span className={styles.treeName}>{root.name}</span>
				</button>
			)}
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
				<span className={styles.treeMark}>
					{node.isDirectory ? (
						<CaretIcon size={12} direction={node.children === undefined ? "right" : "down"} />
					) : null}
				</span>
				{oldName !== null && <span className={styles.treeOldName}>{oldName}</span>}
				<span className={styles.treeName}>{node.name}</span>
				{letter && <span className={styles.treeStatus}>{letter}</span>}
				{!letter && node.error && (
					<span className={styles.treeStatusMark} role="img" aria-label="could not list">
						<WarningIcon size={12} />
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

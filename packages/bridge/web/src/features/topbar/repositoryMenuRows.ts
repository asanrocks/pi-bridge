// The TopBar repository menu's rows: the Project's files, always reachable, and
// the review of its live dirt when there is any. Pure — the component owns the
// actions; this owns what the menu says and in which order.

/** The worktree read the review row describes. */
export interface RepositoryMenuDirt {
	/** Files differing from `HEAD`, untracked included. */
	count: number;
	/** Untracked files the review leaves out (it lists tracked diffs). */
	omitted: number;
}

export interface RepositoryMenuRow {
	key: "review" | "browse";
	label: string;
	detail?: string;
}

/** Review first — it is the immediate verb when there is something to review —
 * then the browse row, which exists in every state. That row is what keeps the
 * menu reachable at all: a clean worktree, a Project that is not a git repo, and
 * an unreadable one would otherwise have no entry to the browser. */
export function repositoryMenuRows(dirt: RepositoryMenuDirt | null): RepositoryMenuRow[] {
	const browse: RepositoryMenuRow = { key: "browse", label: "Browse files" };
	if (dirt === null || dirt.count === 0) return [browse];
	const omittedNote = dirt.omitted > 0 ? ` (+${dirt.omitted} omitted)` : "";
	return [
		{
			key: "review",
			label: `Review ${dirt.count} uncommitted file${dirt.count === 1 ? "" : "s"}`,
			detail: `HEAD → working tree${omittedNote}`,
		},
		browse,
	];
}

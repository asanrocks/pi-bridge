// formatTimestamp moved to infra/lib/time.ts (shared with HistoryPane).

// formatGitIdentity — ADR 10 stamp chip text for a user-turn header.
// "main @ a1b2c3d" normally; "a1b2c3d" for detached HEAD; "main" for an unborn
// branch. Returns "" when nothing is known (both null). The git mark itself is a
// glyph (`BranchIcon`), not a character: `⎇` is a font glyph that renders at the
// text baseline and varies by font, which is exactly what the icon contract
// bans, and it cannot take the control's ink.
export function formatGitIdentity(identity: { commit: string | null; branch: string | null }): string {
	const branch = identity.branch;
	const commit = identity.commit ? identity.commit.slice(0, 8) : null;
	if (branch && commit) return `${branch} @ ${commit}`;
	if (branch) return branch;
	if (commit) return commit;
	return "";
}

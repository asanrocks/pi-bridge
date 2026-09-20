// formatTimestamp moved to infra/lib/time.ts (shared with HistoryPane).

// formatGitIdentity — ADR 10 stamp chip text for a user-turn header.
// "⎇ main @ a1b2c3d" normally; "⎇ a1b2c3d" for detached HEAD; "⎇ main"
// for an unborn branch. Returns "" when nothing is known (both null).
export function formatGitIdentity(identity: { commit: string | null; branch: string | null }): string {
	const branch = identity.branch;
	const commit = identity.commit ? identity.commit.slice(0, 8) : null;
	if (branch && commit) return `⎇ ${branch} @ ${commit}`;
	if (branch) return `⎇ ${branch}`;
	if (commit) return `⎇ ${commit}`;
	return "";
}

// formatDuration — compact wall-clock ms as used in turn headers
// ("thought for", "worked for", "tools"). <1s reads as "<1s" so a fast
// reply or a near-instant turn isn't shown as "0s"; hours collapse to
// "1h 5m" so a long-running turn stays legible.
export function formatDuration(ms: number | undefined): string {
	if (ms === undefined || Number.isNaN(ms) || ms < 0) return "";
	if (ms < 1000) return "<1s";
	const totalSec = Math.round(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const totalMin = Math.floor(totalSec / 60);
	const remSec = totalSec % 60;
	if (totalMin < 60) return remSec ? `${totalMin}m ${remSec}s` : `${totalMin}m`;
	const hr = Math.floor(totalMin / 60);
	const remMin = totalMin % 60;
	return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

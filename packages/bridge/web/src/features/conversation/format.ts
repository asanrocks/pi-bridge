// formatTimestamp — HH:MM from an ISO string. Shared by user/assistant turns.

export function formatTimestamp(iso: string): string {
	try {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return "";
		const hh = String(d.getHours()).padStart(2, "0");
		const mm = String(d.getMinutes()).padStart(2, "0");
		return `${hh}:${mm}`;
	} catch {
		return "";
	}
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

// ============================================================================
// time — shared time formatting. Pure functions; no DOM, no React. Lives in
// infra/lib because conversation turns, the history pane, and the sidebar all
// render timestamps and must share one spec per format.
// ============================================================================

// formatTimestamp — HH:MM (24h) from an ISO string. Turn headers, history
// rows. Returns "" for unparseable input.
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

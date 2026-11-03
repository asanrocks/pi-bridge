// ============================================================================
// time — the one module that writes a time. Two classifiers and one detail
// string; no other file formats a date or a duration. Pure; no DOM, no React
// (the shared clock lives in useNow.ts, the <time> hosts in the components).
//
// Labels use a single ladder: relative while the reader's question is "how
// fresh is this", then a clock, then a weekday, then a date. Escalation is
// what keeps a row answerable at a glance — a clock-only label cannot say
// which day an older row belongs to, and a hover-only detail cannot answer on
// touch. The bucket boundaries (sessionGroup) read the same classifier, so a
// row can never sit under a header its own label contradicts.
//
// Policy: locale is pinned to en-US and instants render in device-local time,
// matching the app's English copy; the relative wording ("just now", "N min
// ago", "yesterday") is deliberate compact microcopy for space-constrained
// rows, so it stays typed rather than delegated to Intl.RelativeTimeFormat.
// Calendar parts (clock, weekday, month/day) come from Intl, so DST and
// month-length are never computed here. A remote host's clock would need an
// explicit timezone argument; the daemon is local, so none is taken.
// ============================================================================

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WEEK = 7 * 24 * HOUR;

// 24h clock. hourCycle "h23" (not hour12: false) so midnight is 00:00, never
// 24:00 — engines differ on the h24 cycle.
const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const MONTH_DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
// The hover/accessible truth: date, clock, and the zone offset, so "14:05"
// is never ambiguous about which clock it came from.
const FULL = new Intl.DateTimeFormat("en-US", {
	year: "numeric",
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
	timeZoneName: "short",
});

/** Where an instant sits relative to `now`. Exported so the session buckets
 *  and the label ladder share one boundary set instead of re-deriving it. */
export type InstantKind = "recent" | "today" | "yesterday" | "thisWeek" | "older";

function parse(iso: string): Date | null {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? null : d;
}

function sameDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function classify(d: Date, now: number): InstantKind {
	// Freshness outranks the calendar: a 5-minute-old session just after
	// midnight reads better as "5 min ago" than as "yesterday, 23:58", and its
	// bucket follows the label (see sessionGroup).
	if (now - d.getTime() < HOUR) return "recent";
	const today = new Date(now);
	if (sameDay(d, today)) return "today";
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (sameDay(d, yesterday)) return "yesterday";
	// A rolling 7×24h window, not a calendar week: it is the widest span whose
	// labels can still name a weekday, so buckets and labels agree.
	if (now - d.getTime() < WEEK) return "thisWeek";
	return "older";
}

/** Kind for an ISO instant, or null when it does not parse. */
export function classifyInstant(iso: string, now: number): InstantKind | null {
	const d = parse(iso);
	return d === null ? null : classify(d, now);
}

/** The one label: "just now" / "N min ago" / "14:05" / "yesterday, 14:05" /
 *  "Tue, 14:05" / "Nov 3" / "Nov 3, 2025". "" for unparseable input. */
export function formatWhen(iso: string, now: number): string {
	const d = parse(iso);
	if (d === null) return "";
	switch (classify(d, now)) {
		case "recent": {
			const mins = Math.floor((now - d.getTime()) / MINUTE);
			return mins < 1 ? "just now" : `${mins} min ago`;
		}
		case "today":
			return CLOCK.format(d);
		case "yesterday":
			return `yesterday, ${CLOCK.format(d)}`;
		case "thisWeek":
			return `${WEEKDAY.format(d)}, ${CLOCK.format(d)}`;
		case "older": {
			// The year is noise inside the current year and load-bearing outside
			// it — which is exactly when a bare "Nov 3" would be a lie.
			const fmt = d.getFullYear() === new Date(now).getFullYear() ? MONTH_DAY : MONTH_DAY_YEAR;
			return fmt.format(d);
		}
	}
}

/** The full instant for a hover title or an accessible name: date, clock, and
 *  zone. "" for unparseable input. */
export function formatWhenFull(iso: string): string {
	const d = parse(iso);
	return d === null ? "" : FULL.format(d);
}

/** Elapsed time: one decimal below 10s (tool runs), whole seconds below a
 *  minute, then "2m 03s" / "1h 05m". "" for unusable input. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const seconds = ms / 1000;
	if (seconds < 10) return `${seconds.toFixed(1)}s`;
	const whole = Math.round(seconds);
	if (whole < 60) return `${whole}s`;
	const minutes = Math.floor(whole / 60);
	const rest = whole % 60;
	if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${String(rest).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return mins === 0 ? `${hours}h` : `${hours}h ${String(mins).padStart(2, "0")}m`;
}

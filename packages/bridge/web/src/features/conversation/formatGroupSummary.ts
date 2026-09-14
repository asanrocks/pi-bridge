// ============================================================================
// formatGroupSummary — categorizes a list of action steps into a compact
// collapsed label grouped by tool kind. Categories appear in a fixed
// precedence order that matches the group's family dots (edit+write
// collapse to the mutate family):
//   edit > write > bash-family > read  →  mutate > bash > read
//   edit: a.ts, b.ts, c.ts · run 2 tools · read 3 files
// Only edit/write carry file names — the named outcomes of the group, listed
// together under one "edit:" category (edit vs write stays visible in the
// expanded step rows and card identities); every other tool (bash, grep, …)
// is a count under "run N tools", so the header needs no arguments beyond
// edit/write paths. Thinking steps are not summarized — the header surfaces
// tool actions only — except when thinking is all a group holds, where a
// bare "think" keeps the fold row readable.
// ============================================================================

/** Per-step data extracted from live store args. */
export interface StepSummaryItem {
	toolName: string;
	/** Path basename for edit/write tools (null if unknown). */
	basename: string | null;
}

/**
 * Build a categorized group label from step items. Each category appears at
 * most once, with dedup and truncation inside it. Edit and write share the
 * "edit:" category — modify-existing vs create-new stays visible in the
 * expanded rows; the collapsed header cares only about which files changed.
 */
export function formatGroupSummary(items: StepSummaryItem[]): string {
	const editMap = new Map<string, number>(); // basename → count
	let readCount = 0;
	let otherToolCount = 0;
	let thinkCount = 0;

	for (const item of items) {
		const name = item.toolName;
		if (name === "edit" || name === "write") {
			const key = item.basename ?? "?";
			editMap.set(key, (editMap.get(key) ?? 0) + 1);
		} else if (name === "read") {
			readCount++;
		} else if (name === "thinking") {
			thinkCount++;
		} else {
			// bash, grep, find, ls, glob, unknown tools — counted, not named.
			otherToolCount++;
		}
	}

	const groups: string[] = [];

	// --- edit (edit + write basenames, one list) ---
	const editGroup = formatPathGroup("edit", editMap);
	if (editGroup) groups.push(editGroup);

	// --- other tools ---
	if (otherToolCount > 0) {
		groups.push(`run ${otherToolCount} tool${otherToolCount === 1 ? "" : "s"}`);
	}

	// --- read ---
	if (readCount > 0) {
		groups.push(`read ${readCount} ${readCount === 1 ? "file" : "files"}`);
	}

	// Thinking-only group (thinking followed by text is a common shape):
	// no tool category applies, but the fold row must not be a bare
	// triangle — fall back to a minimal "think" label.
	if (groups.length === 0 && thinkCount > 0) {
		return "think";
	}

	return groups.join(" · ");
}

/** "edit: a.ts, b.ts, +1 more" — deduped basenames, truncated to 3. */
function formatPathGroup(label: string, map: Map<string, number>): string | null {
	if (map.size === 0) return null;
	const entries = [...map.keys()].sort();
	const shown = entries.slice(0, 3);
	const rest = entries.length - shown.length;
	if (rest > 0) shown.push(`+${rest} more`);
	return `${label}: ${shown.join(", ")}`;
}

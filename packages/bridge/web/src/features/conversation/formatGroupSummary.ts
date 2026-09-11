// ============================================================================
// formatGroupSummary — categorizes a list of action steps into a compact
// collapsed label grouped by tool kind. Categories appear in a fixed
// precedence order that matches the group's family dots (edit+write
// collapse to the mutate family):
//   edit > write > bash > read > think  →  mutate > bash > read > think
//   edit: a.ts, b.ts, +1 more · write: c.ts · bash: npm install · read 3 files · think
// ============================================================================

/** Per-step data extracted from live store args. */
export interface StepSummaryItem {
	toolName: string;
	/** Path basename for edit/write/read tools (null if unknown). */
	basename: string | null;
	/** Full command string for bash. */
	command: string | null;
}

// Commands too trivial to surface in the bash summary.
const TRIVIAL_COMMANDS = new Set(["cd", "ls", "echo", "export", "set", "source", "pwd", "clear"]);

/**
 * Build a categorized group label from step items. Each category appears at
 * most once, with dedup and truncation inside it. `edit` and `write` are
 * separate categories — they share a band hue (the mutate family) but are
 * semantically distinct (modify-existing vs create-new), so the label
 * keeps them apart.
 */
export function formatGroupSummary(items: StepSummaryItem[]): string {
	const editMap = new Map<string, number>(); // basename → count
	const writeMap = new Map<string, number>();
	const bashCmds: string[] = [];
	let readCount = 0;
	let thinkCount = 0;

	for (const item of items) {
		const name = item.toolName;
		if (name === "edit") {
			const key = item.basename ?? "?";
			editMap.set(key, (editMap.get(key) ?? 0) + 1);
		} else if (name === "write") {
			const key = item.basename ?? "?";
			writeMap.set(key, (writeMap.get(key) ?? 0) + 1);
		} else if (name === "bash") {
			if (item.command) bashCmds.push(item.command);
		} else if (name === "read") {
			readCount++;
		} else if (name === "thinking") {
			thinkCount++;
		}
	}

	const groups: string[] = [];

	// --- edit / write (separate categories, same shape) ---
	const editGroup = formatPathGroup("edit", editMap);
	if (editGroup) groups.push(editGroup);
	const writeGroup = formatPathGroup("write", writeMap);
	if (writeGroup) groups.push(writeGroup);

	// --- bash ---
	if (bashCmds.length > 0) {
		const keyCmds = bashCmds.map(extractKeyCommand).filter((s): s is string => s !== null && s.length > 0);
		const deduped = [...new Set(keyCmds)];
		if (deduped.length === 0) {
			groups.push(`bash (${bashCmds.length} cmd${bashCmds.length > 1 ? "s" : ""})`);
		} else {
			const shown = deduped.slice(0, 2);
			const rest = bashCmds.length - shown.length;
			const label = rest > 0 ? `${shown.join(", ")} · +${rest} more` : shown.join(", ");
			groups.push(`bash: ${label}`);
		}
	}

	// --- read ---
	if (readCount > 0) {
		groups.push(`read ${readCount} ${readCount === 1 ? "file" : "files"}`);
	}

	// --- think ---
	if (thinkCount > 0) {
		groups.push("think");
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

/**
 * Extract a meaningful command from a bash command string.
 * Splits on &&/;/|, skips trivial commands, returns the first non-trivial one.
 * Returns null when the command is all trivial.
 */
function extractKeyCommand(fullCmd: string): string | null {
	const parts = fullCmd
		.split(/\s*[;&|]\s*/)
		.map((s) => s.trim())
		.filter(Boolean);
	for (const part of parts) {
		const firstWord = part.split(/\s+/)[0];
		if (firstWord && !TRIVIAL_COMMANDS.has(firstWord)) {
			return truncateCommand(part);
		}
	}
	// All trivial — show the first part anyway so the group label isn't empty
	const first = parts[0];
	return first ? truncateCommand(first) : null;
}

function truncateCommand(cmd: string): string {
	return cmd.length > 45 ? `${cmd.slice(0, 42)}…` : cmd;
}

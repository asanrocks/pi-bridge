// resultText parsing — the pi tools append status lines and truncation
// footers to the *text* of tool results (they are not separate wire
// fields). The card layer parses them back out so they can render as
// meta (status chips in the top bar, notice strips under content) instead
// of leaking into the content itself.
//
// The formats are a deliberate contract with the coding-agent tools
// (bash.ts appendStatus/formatOutput, read.ts continuation notices) — same
// repo, and the TUI does the same text dance for the bash footer.
//
// All functions are pure; co-located tests pin each format variant.

// ---------------------------------------------------------------------------
// Paragraph splitting
// ---------------------------------------------------------------------------

/** Split the last "\n\n"-separated paragraph from the text. */
function splitLastParagraph(text: string): { body: string; last: string } {
	const idx = text.lastIndexOf("\n\n");
	if (idx === -1) return { body: "", last: text };
	return { body: text.slice(0, idx), last: text.slice(idx + 2) };
}

// ---------------------------------------------------------------------------
// Bash — status line + truncation footer
// ---------------------------------------------------------------------------

export type BashStatus = { kind: "exit"; code: number } | { kind: "timeout"; secs: number } | { kind: "aborted" };

export interface ParsedBashResult {
	/** Output with the status line and truncation footer stripped. */
	output: string;
	status: BashStatus | null;
	/** Truncation footer text without the "Full output: path" tail. */
	notice: string | null;
	/** Temp-file path holding the full output, when truncated. */
	fullPath: string | null;
}

/** `Command exited with code N` / `Command timed out after N seconds` / `Command aborted` */
function parseStatusLine(line: string): BashStatus | null {
	let m = /^Command exited with code (\d+)$/.exec(line);
	if (m) return { kind: "exit", code: Number(m[1]) };
	m = /^Command timed out after (\d+) seconds$/.exec(line);
	if (m) return { kind: "timeout", secs: Number(m[1]) };
	if (line === "Command aborted") return { kind: "aborted" };
	return null;
}

/** `[Showing ... . Full output: <path>]` — three phrasings, same tail. */
function parseBashNotice(line: string): { notice: string; fullPath: string } | null {
	const m = /^\[(Showing .+)\. Full output: (.+)\]$/.exec(line);
	if (!m) return null;
	return { notice: m[1], fullPath: m[2] };
}

/**
 * Parse a bash result text into output + status + truncation footer.
 * Unmatched paragraphs stay in `output` verbatim (a real output that ends
 * with a status-line lookalike is indistinguishable from the appended one;
 * the risk is accepted — the TUI footer strip makes the same tradeoff).
 */
export function parseBashResult(text: string): ParsedBashResult {
	let rest = text;
	let status: BashStatus | null = null;
	let notice: string | null = null;
	let fullPath: string | null = null;

	// The status line is appended after the truncation footer, so strip it
	// first; with it gone, the footer is the new last paragraph.
	const statusSplit = splitLastParagraph(rest);
	const parsedStatus = parseStatusLine(statusSplit.last);
	if (parsedStatus) {
		status = parsedStatus;
		rest = statusSplit.body;
	}
	const noticeSplit = splitLastParagraph(rest);
	const parsedNotice = parseBashNotice(noticeSplit.last);
	if (parsedNotice) {
		notice = parsedNotice.notice;
		fullPath = parsedNotice.fullPath;
		rest = noticeSplit.body;
	}

	return { output: rest, status, notice, fullPath };
}

// ---------------------------------------------------------------------------
// Read — continuation notices
// ---------------------------------------------------------------------------

export interface ParsedReadResult {
	/** File content with the continuation notice stripped. */
	content: string;
	/** Continuation notice text (bracketed), when the read was truncated. */
	notice: string | null;
}

const READ_NOTICE =
	/^\[(?:(?:Showing lines \d+-\d+ of \d+(?: \([^)]+ limit\))?\. Use offset=\d+ to continue\.)|(?:\d+ more lines in file\. Use offset=\d+ to continue\.)|(?:Line \d+ is .+ exceeds .+ limit\. Use bash: .+))\]$/;

/**
 * Parse a read result text into content + continuation notice. The notice
 * variants all end with `]` and either instruct an offset continuation or
 * flag a size-exceeded first line; the anchored regex keeps false positives
 * (a file whose own last paragraph looks like a notice) unlikely.
 */
export function parseReadNotice(text: string): ParsedReadResult {
	const split = splitLastParagraph(text);
	if (READ_NOTICE.test(split.last)) {
		return { content: split.body, notice: split.last };
	}
	return { content: text, notice: null };
}

// ---------------------------------------------------------------------------
// Chip projection
// ---------------------------------------------------------------------------

export interface StatusChip {
	text: string;
	tone: "error" | "warning";
}

/** Project a parsed bash status into a top-bar chip. */
export function bashStatusChip(status: BashStatus): StatusChip {
	switch (status.kind) {
		case "exit":
			return { text: `exit ${status.code}`, tone: "error" };
		case "timeout":
			return { text: `timed out after ${status.secs}s`, tone: "error" };
		case "aborted":
			return { text: "aborted", tone: "error" };
	}
}

// ---------------------------------------------------------------------------
// Collapsed-band preview
// ---------------------------------------------------------------------------

/**
 * Bash expanded-tail bound — the middle state of the bash card's
 * three-state progression (folded: one-line command; expanded: earlier-lines
 * hint + this many tail lines; show-all: the whole output).
 */
export const BASH_TAIL_LINES = 20;

/** Bash tail preview — slices the last `maxLines` lines with a skipped count. */
export function bashTailPreview(output: string, maxLines: number): { lines: string[]; skipped: number } {
	const lines = output.split("\n");
	const skipped = Math.max(0, lines.length - maxLines);
	return { lines: skipped > 0 ? lines.slice(-maxLines) : lines, skipped };
}

/** Head preview — for match/listing results where the first hits matter. */
export function headPreview(output: string, maxLines: number): { lines: string[]; skipped: number } {
	const lines = output.split("\n");
	const skipped = Math.max(0, lines.length - maxLines);
	return { lines: skipped > 0 ? lines.slice(0, maxLines) : lines, skipped };
}

/** First line of an error text, for the collapsed band's error preview. */
export function errorPreviewLine(text: string): string {
	const line = text.split("\n")[0] ?? "";
	return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

// ---------------------------------------------------------------------------
// Search-tool truncation warnings (grep/find/ls) — from tool_result details
// ---------------------------------------------------------------------------

/** Bytes → "30KB" (the tools' maxBytes is always a whole KB multiple). */
function formatSizeLimit(bytes: number): string {
	return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/**
 * Truncation warnings from a tool_result `details` object (grep: match/
 * line limits; find: result limit; ls: entry limit; all: byte limit).
 * Mirrors the TUI's per-tool warning lists.
 */
export function truncationWarnings(details: unknown): string[] {
	if (!details || typeof details !== "object") return [];
	const d = details as Record<string, unknown>;
	const warnings: string[] = [];
	if (typeof d.matchLimitReached === "number") warnings.push(`${d.matchLimitReached} matches limit`);
	if (typeof d.resultLimitReached === "number") warnings.push(`${d.resultLimitReached} result limit`);
	if (typeof d.entryLimitReached === "number") warnings.push(`${d.entryLimitReached} entry limit`);
	if (d.linesTruncated === true) warnings.push("some lines truncated");
	const trunc = d.truncation;
	if (trunc && typeof trunc === "object" && (trunc as Record<string, unknown>).truncated === true) {
		const maxBytes = (trunc as Record<string, unknown>).maxBytes;
		if (typeof maxBytes === "number") warnings.push(`${formatSizeLimit(maxBytes)} limit`);
	}
	return warnings;
}

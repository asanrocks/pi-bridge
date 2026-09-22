// ============================================================================
// apply-patch — display parser for Codex-style `apply_patch` envelopes
// (pi-apply-patch extension, OpenAI Codex grammar). Pure and browser-safe.
//
// This is a *display* parser, not an applier: it never reads disk, never
// seeks, and never fails a patch. The envelope is self-contained (context
// plus −/+ lines), so the web card renders a full diff from the arguments
// alone. Where the host-side tool hard-fails on malformed input, this parser
// degrades: unknown lines are skipped, and `ok: false` (no envelope, no
// sections) tells the caller to fall back to raw text. Arguments may stream
// in progressively — sections already complete render while the tail is
// still arriving, and `complete` reports whether the `*** End Patch`
// terminator was seen.
// ============================================================================

/** `@@ …` seek marker + the chunk's reconstructed old/new text. */
export interface ApplyPatchChunk {
	/** Seek-context lines (`@@ <line>` markers) — file lines the host-side
	 * applier matches to locate the chunk. Displayed as muted locator rows,
	 * not diff lines: they are not part of oldText/newText. */
	contexts: string[];
	/** Context + removed lines, joined — the "old" side of the diff. */
	oldText: string;
	/** Context + added lines, joined — the "new" side of the diff. */
	newText: string;
}

export type ApplyPatchSection =
	| { type: "add"; filePath: string; content: string }
	| { type: "delete"; filePath: string }
	| { type: "update"; filePath: string; movePath: string | null; chunks: ApplyPatchChunk[] };

export interface ApplyPatchParse {
	sections: ApplyPatchSection[];
	/** `*** End Patch` seen — the envelope is complete. */
	complete: boolean;
	/** At least one section parsed from a `*** Begin Patch` envelope. False
	 * for non-envelopes (caller falls back to raw text) and for an envelope
	 * header that has streamed no section yet. */
	ok: boolean;
}

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";

function normalizePatchText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

/** Unwrap a `cat << EOF … EOF` heredoc around the envelope (host-tool parity:
 * models occasionally wrap the patch this way). */
function stripHeredoc(input: string): string {
	const m = /^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/.exec(input);
	return m?.[2] ?? input;
}

/**
 * Parse an apply_patch envelope into display sections. Tolerates partial
 * input: sections are collected until the text runs out, and a trailing
 * update chunk keeps whatever lines have arrived. Lines that do not match
 * the ` `/`-`/`+` body prefixes are skipped rather than rejected — the
 * authoritative failure report is the tool's own result text.
 */
export function parseApplyPatch(input: string): ApplyPatchParse {
	const text = stripHeredoc(normalizePatchText(input));
	if (!text.startsWith(BEGIN_PATCH)) return { sections: [], complete: false, ok: false };
	const lines = text.split("\n");
	const sections: ApplyPatchSection[] = [];
	let complete = false;
	let i = 1;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (line.startsWith(ADD_FILE)) {
			const filePath = line.slice(ADD_FILE.length);
			i++;
			const content: string[] = [];
			while (i < lines.length) {
				const next = lines[i] ?? "";
				if (next.startsWith("*** ")) break;
				content.push(next.startsWith("+") ? next.slice(1) : next);
				i++;
			}
			sections.push({ type: "add", filePath, content: content.join("\n") });
			continue;
		}
		if (line.startsWith(DELETE_FILE)) {
			sections.push({ type: "delete", filePath: line.slice(DELETE_FILE.length) });
			i++;
			continue;
		}
		if (line.startsWith(UPDATE_FILE)) {
			const filePath = line.slice(UPDATE_FILE.length);
			i++;
			let movePath: string | null = null;
			if ((lines[i] ?? "").startsWith(MOVE_TO)) {
				movePath = (lines[i] ?? "").slice(MOVE_TO.length);
				i++;
			}
			const chunks: ApplyPatchChunk[] = [];
			while (i < lines.length) {
				const next = lines[i] ?? "";
				if (next.startsWith("*** ")) break; // next section / End of File / End Patch
				if (next.trim() === "") {
					i++;
					continue;
				}
				// Optional seek markers precede each chunk ("@@" alone is a
				// bare marker; "@@ <line>" carries a context line).
				const contexts: string[] = [];
				while (i < lines.length && (lines[i] === "@@" || (lines[i] ?? "").startsWith("@@ "))) {
					const ctx = lines[i] ?? "";
					if (ctx.startsWith("@@ ")) contexts.push(ctx.slice(3));
					i++;
				}
				const oldLines: string[] = [];
				const newLines: string[] = [];
				let sawLine = false;
				while (i < lines.length) {
					const body = lines[i] ?? "";
					if (body.startsWith("*** ")) break;
					if (body === "@@" || body.startsWith("@@ ")) break; // next chunk
					if (body.startsWith(" ")) {
						oldLines.push(body.slice(1));
						newLines.push(body.slice(1));
						sawLine = true;
					} else if (body.startsWith("-")) {
						oldLines.push(body.slice(1));
						sawLine = true;
					} else if (body.startsWith("+")) {
						newLines.push(body.slice(1));
						sawLine = true;
					}
					i++;
				}
				if (sawLine || contexts.length > 0) {
					chunks.push({ contexts, oldText: oldLines.join("\n"), newText: newLines.join("\n") });
				}
			}
			sections.push({ type: "update", filePath, movePath, chunks });
			continue;
		}
		if (line === END_PATCH) {
			complete = true;
			break;
		}
		i++;
	}
	return { sections, complete, ok: sections.length > 0 };
}

/**
 * File paths touched by the envelope (light regex scan — works on partial
 * envelopes before sections are complete, and cheap enough for per-render
 * summary/header derivation). Move targets are excluded; they pair with
 * their Update section in the card body.
 */
export function extractApplyPatchPaths(input: string): string[] {
	const text = stripHeredoc(normalizePatchText(input));
	return Array.from(text.matchAll(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/gm), (m) => m[1] ?? "");
}

/**
 * The patch-envelope argument of an apply_patch call: pi-ai normalizes
 * grammar-tool calls to `{ input: "…" }`, but a raw string argument is
 * accepted defensively (the host tool tolerates it too). Takes `unknown` —
 * it is a defensive extractor over untrusted argument shapes.
 */
export function applyPatchInput(args: unknown): string | null {
	if (typeof args === "string") return args;
	if (args !== null && typeof args === "object" && !Array.isArray(args)) {
		const input = (args as Record<string, unknown>).input;
		if (typeof input === "string") return input;
	}
	return null;
}

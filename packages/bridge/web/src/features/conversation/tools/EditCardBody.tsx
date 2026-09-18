// EditCardBody — unified diff card, path as inline annotation (no header bar)
// Uses the `diff` package for line-level and word-level diff rendering:
//   • multi-line changes: interleaved +/- lines via diff.diffLines
//   • single-line changes: inline word-level highlighting via diff.diffWords
//   • syntax highlighting via the shared shiki singleton (highlightTokens)
// Arguments are normalized first (normalizeEditArgs — TUI prepareArguments
// parity) so edits-as-JSON-string, single-edit objects, and the legacy
// top-level oldText/newText pair all render the diff the tool executed.

import { diffLines, diffWords } from "diff";
import { memo, useEffect, useMemo, useState } from "react";
import type { HighlightResult } from "../../../render/shiki.ts";
import { highlightTokens } from "../../../render/shiki.ts";
import styles from "../actionSteps.module.css";
import { type ActionDetailsProps, extToLang, normalizeEditArgs } from "./args.ts";

// ---------------------------------------------------------------------------
// Diff computation helpers
// ---------------------------------------------------------------------------

/** Flattened line-level diff info: each element is one output line. */
interface DiffLine {
	kind: "context" | "remove" | "add";
	text: string;
	/** Set for a single-line remove/add pair that gets intra-line word diffing */
	inlineWord?: {
		pairId: number;
		isOld: boolean;
		newText: string;
	};
}

function computeDiffLines(oldText: string, newText: string): DiffLine[] {
	const parts = diffLines(oldText, newText);
	const result: DiffLine[] = [];

	for (const part of parts) {
		const raw = part.value;
		const lines = raw.split("\n");
		if (lines.length > 0 && lines[lines.length - 1] === "") {
			if (lines.length === 1) continue;
			lines.pop();
		}

		if (part.added) {
			for (const l of lines) result.push({ kind: "add", text: l });
		} else if (part.removed) {
			for (const l of lines) result.push({ kind: "remove", text: l });
		} else {
			for (const l of lines) result.push({ kind: "context", text: l });
		}
	}

	return result;
}

/** Collapse consecutive remove+add pairs into inline-word candidates. */
function tagInlineWordPairs(lines: DiffLine[]): DiffLine[] {
	const out: DiffLine[] = [];
	let wordPairId = 0;
	for (let i = 0; i < lines.length; i++) {
		const cur = lines[i];
		const next = i + 1 < lines.length ? lines[i + 1] : null;

		if (cur.kind === "remove" && next?.kind === "add") {
			// Single-line? Then word-diff, else leave as-is.
			if (lines.slice(i, i + 2).every((l) => !l.text.includes("\n"))) {
				// Check that neither spans multiple diff lines
				out.push({
					...cur,
					inlineWord: { pairId: wordPairId, isOld: true, newText: next.text },
				});
				out.push({
					...next,
					inlineWord: { pairId: wordPairId, isOld: false, newText: next.text },
				});
				wordPairId++;
				i++; // skip next
				continue;
			}
		}
		out.push(cur);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Word-level inline diff (for single-line changes)
// ---------------------------------------------------------------------------

interface WordPart {
	text: string;
	changed: boolean;
}

function computeWordInlineDiff(
	oldLine: string,
	newLine: string,
): {
	oldParts: WordPart[];
	newParts: WordPart[];
} {
	const parts = diffWords(oldLine, newLine);
	const oldParts: WordPart[] = [];
	const newParts: WordPart[] = [];

	for (const part of parts) {
		if (part.removed) {
			oldParts.push({ text: part.value, changed: true });
		} else if (part.added) {
			newParts.push({ text: part.value, changed: true });
		} else {
			oldParts.push({ text: part.value, changed: false });
			newParts.push({ text: part.value, changed: false });
		}
	}

	return { oldParts, newParts };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const EditCardBody = memo(function EditCardBody({ args }: ActionDetailsProps) {
	const path = args?.path as string | undefined;
	const edits = normalizeEditArgs(args);

	// Compute the flat diff lines (separate for each edit hunk, joined by separators)
	const diffLinesData = useMemo(() => {
		if (!edits || edits.length === 0) return null;
		const hunks: Array<{ lines: DiffLine[] }> = [];
		for (let idx = 0; idx < edits.length; idx++) {
			const edit = edits[idx];
			const oldText = edit.oldText ?? "";
			const newText = edit.newText ?? "";
			if (oldText === "" && newText === "") continue;
			hunks.push({ lines: tagInlineWordPairs(computeDiffLines(oldText, newText)) });
		}
		return hunks;
	}, [edits]);

	// Collect all line text for syntax highlighting
	const allLineTexts = useMemo(
		() => (diffLinesData ? diffLinesData.flatMap((h) => h.lines.map((l) => l.text)) : []),
		[diffLinesData],
	);

	// The code block to highlight = each line joined by newline
	const codeForHighlight = useMemo(() => allLineTexts.join("\n"), [allLineTexts]);

	// Highlighted tokens from shiki (async)
	const lang = useMemo(() => (path ? extToLang(path) : ""), [path]);
	const [highlightResult, setHighlightResult] = useState<HighlightResult | null>(null);
	useEffect(() => {
		if (!codeForHighlight || !lang) {
			setHighlightResult(null);
			return;
		}
		let cancelled = false;
		highlightTokens(codeForHighlight, lang).then((r) => {
			if (!cancelled) setHighlightResult(r);
		});
		return () => {
			cancelled = true;
		};
	}, [codeForHighlight, lang]);

	if (path === undefined && (!edits || edits.length === 0)) return null;

	return (
		<div className={styles.cardBody}>
			{diffLinesData && (
				<div className={styles.editDiff}>
					{renderDiffContent(diffLinesData, highlightResult, lang === "" || !highlightResult)}
				</div>
			)}
		</div>
	);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderDiffContent(
	hunks: Array<{ lines: DiffLine[] }>,
	highlightResult: HighlightResult | null,
	noHighlight: boolean,
): React.ReactNode {
	const elements: React.ReactNode[] = [];
	let globalLineIdx = 0; // index into highlightResult.lines

	for (let hunkIdx = 0; hunkIdx < hunks.length; hunkIdx++) {
		const { lines } = hunks[hunkIdx];

		if (hunkIdx > 0) {
			elements.push(
				<div key={`sep-${hunkIdx}`} className={styles.editDiffHunkSep}>
					---
				</div>,
			);
		}

		for (let li = 0; li < lines.length; li++) {
			const line = lines[li];

			if (line.inlineWord && line.kind === "remove") {
				// Single-line word diff — render old line with inline highlights
				const nextLine = li + 1 < lines.length ? lines[li + 1] : null;
				if (nextLine?.inlineWord && nextLine.kind === "add") {
					const { oldParts, newParts } = computeWordInlineDiff(line.text, nextLine.text);
					elements.push(
						<div key={`rm-${hunkIdx}-${li}`} className={`${styles.editDiffLine} ${styles.editDiffOld}`}>
							{renderWordParts(oldParts)}
						</div>,
					);
					elements.push(
						<div key={`add-${hunkIdx}-${li}`} className={`${styles.editDiffLine} ${styles.editDiffNew}`}>
							{renderWordParts(newParts)}
						</div>,
					);
					li++; // skip the add line
					globalLineIdx += 2;
					continue;
				}
			}

			// Normal line — use syntax highlighted tokens if available
			const hlLine = highlightResult?.lines[globalLineIdx];
			const lineClass =
				line.kind === "context"
					? styles.editDiffContext
					: line.kind === "remove"
						? styles.editDiffOld
						: styles.editDiffNew;

			elements.push(
				<div
					key={`line-${hunkIdx}-${li}`}
					className={`${styles.editDiffLine} ${lineClass}`}
					style={hlLine?.bg ? ({ "--shiki-dark-bg": hlLine.bg } as React.CSSProperties) : undefined}
				>
					{hlLine && !noHighlight ? renderHighlightedTokens(hlLine.tokens) : line.text}
				</div>,
			);
			globalLineIdx++;
		}
	}

	return elements;
}

function renderWordParts(parts: WordPart[]): React.ReactNode[] {
	return parts.map((p, pi) =>
		p.changed ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: word-diff parts are small, stable, no stable id
			<span key={pi} className={styles.editDiffInlineChanged}>
				{p.text}
			</span>
		) : (
			// biome-ignore lint/suspicious/noArrayIndexKey: word-diff parts are small, stable, no stable id
			<span key={pi}>{p.text}</span>
		),
	);
}

function renderHighlightedTokens(
	tokens: Array<{ content: string; color?: string; htmlStyle?: Record<string, string> }>,
): React.ReactNode[] {
	return tokens.map((t, ti) => {
		const style: Record<string, string> = {};
		if (t.color) style.color = t.color;
		if (t.htmlStyle) Object.assign(style, t.htmlStyle);
		return (
			// biome-ignore lint/suspicious/noArrayIndexKey: static token list from shiki
			<span key={ti} style={Object.keys(style).length > 0 ? style : undefined}>
				{t.content}
			</span>
		);
	});
}

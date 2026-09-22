// DiffSections — the shared unified-diff renderer, used by card bodies (edit,
// apply_patch) and by the browser's review sections. It diffs two texts with
// the `diff` package:
//   • multi-line changes: interleaved +/- lines via diff.diffLines
//   • single-line changes: inline word-level highlighting via diff.diffWords
//   • syntax highlighting via the shared shiki singleton (highlightTokens),
//     per section (each section carries its own language)
// Sections render in order, separated by a `---` divider — unless a section
// carries a title (e.g. a per-file label), which replaces the divider.
// Optional muted `notes` rows (e.g. apply_patch `@@` seek markers) render
// between the title and the diff lines.
//
// `lineNumbers`, `contextLines`, and `wrap` are opt-in for whole-file review
// (the FileBrowser): the browser diffs fetched snapshots rather than
// git's patch, so it needs the elision git would otherwise have done and a
// dual gutter. Card bodies leave them off and render every line as before.
//
// Callers rebuild the sections array each render, so everything inside keys
// on a content signature: the diff computation memoizes on it, and the async
// highlight results carry the signature they belong to (a mismatch — stale
// results from the previous content — falls back to plain text until the
// new results land).

import { diffLines, diffWords } from "diff";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import type { HighlightedToken, HighlightResult } from "../../../render/shiki.ts";
import { highlightTokens } from "../../../render/shiki.ts";
import styles from "../actions.module.css";

/** One titled diff hunk. `oldText`/`newText` are diffed; a null title makes
 * the section a plain continuation hunk (separated by `---`). */
export interface DiffSectionSpec {
	title: string | null;
	/** File opened in the viewer when the title is clicked (requires the
	 * caller's `onOpenView`); null/undefined renders a non-interactive label. */
	viewPath?: string | null;
	/** Muted mono rows above the diff lines (seek markers, `@@ …`). */
	notes?: string[];
	/** Shiki language id; "" disables highlighting. */
	lang: string;
	oldText: string;
	newText: string;
}

/** Flattened line-level diff info: each element is one output line. */
interface DiffLine {
	kind: "context" | "remove" | "add";
	text: string;
	/** 1-based line number on the old side; null for an added line. */
	oldLine: number | null;
	/** 1-based line number on the new side; null for a removed line. */
	newLine: number | null;
	/** Set for a single-line remove/add pair that gets intra-line word diffing */
	inlineWord?: {
		pairId: number;
		isOld: boolean;
		newText: string;
	};
}

/** A rendered row: a diff line, or a collapsed run of unchanged lines. */
type RenderLine = DiffLine | { kind: "gap"; count: number };

function computeDiffLines(oldText: string, newText: string): DiffLine[] {
	const parts = diffLines(oldText, newText);
	const result: DiffLine[] = [];
	let oldNo = 1;
	let newNo = 1;

	for (const part of parts) {
		const raw = part.value;
		const lines = raw.split("\n");
		if (lines.length > 0 && lines[lines.length - 1] === "") {
			if (lines.length === 1) continue;
			lines.pop();
		}

		if (part.added) {
			for (const l of lines) result.push({ kind: "add", text: l, oldLine: null, newLine: newNo++ });
		} else if (part.removed) {
			for (const l of lines) result.push({ kind: "remove", text: l, oldLine: oldNo++, newLine: null });
		} else {
			for (const l of lines) result.push({ kind: "context", text: l, oldLine: oldNo++, newLine: newNo++ });
		}
	}

	return result;
}

/** Collapse unchanged runs to `context` lines at each end (the elision git's
 * patch would have done). A gap carries its hidden count so the highlight
 * index — computed over the full, unelided text — stays aligned. */
function elideContext(lines: DiffLine[], context: number): RenderLine[] {
	const out: RenderLine[] = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i]!.kind !== "context") {
			out.push(lines[i]!);
			i++;
			continue;
		}
		let j = i;
		while (j < lines.length && lines[j]!.kind === "context") j++;
		const run = j - i;
		if (run <= context * 2 + 1) {
			for (let k = i; k < j; k++) out.push(lines[k]!);
		} else {
			for (let k = i; k < i + context; k++) out.push(lines[k]!);
			out.push({ kind: "gap", count: run - context * 2 });
			for (let k = j - context; k < j; k++) out.push(lines[k]!);
		}
		i = j;
	}
	return out;
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

function renderSectionLines(
	lines: RenderLine[],
	highlightResult: HighlightResult | null,
	noHighlight: boolean,
	lineNumbers: boolean,
): ReactNode[] {
	const elements: ReactNode[] = [];
	let lineIdx = 0; // index into highlightResult.lines

	for (let li = 0; li < lines.length; li++) {
		const line = lines[li]!;

		if (line.kind === "gap") {
			elements.push(
				<div key={`gap-${li}`} className={`${styles.editDiffLine} ${styles.editDiffGap}`}>
					{lineNumbers && <span className={styles.editDiffGutter} />}
					{lineNumbers && <span className={styles.editDiffGutter} />}
					<span className={styles.editDiffText}>⋯ {line.count} unchanged lines</span>
				</div>,
			);
			lineIdx += line.count;
			continue;
		}

		if (line.inlineWord && line.kind === "remove") {
			// Single-line word diff — render old line with inline highlights
			const nextLine = li + 1 < lines.length ? lines[li + 1]! : null;
			if (nextLine !== null && nextLine.kind !== "gap" && nextLine.inlineWord && nextLine.kind === "add") {
				const { oldParts, newParts } = computeWordInlineDiff(line.text, nextLine.text);
				elements.push(
					<div key={`rm-${li}`} className={`${styles.editDiffLine} ${styles.editDiffOld}`}>
						{lineNumbers && <span className={styles.editDiffGutter}>{line.oldLine ?? ""}</span>}
						{lineNumbers && <span className={styles.editDiffGutter} />}
						<span className={styles.editDiffText}>{renderWordParts(oldParts)}</span>
					</div>,
				);
				elements.push(
					<div key={`add-${li}`} className={`${styles.editDiffLine} ${styles.editDiffNew}`}>
						{lineNumbers && <span className={styles.editDiffGutter} />}
						{lineNumbers && <span className={styles.editDiffGutter}>{nextLine.newLine ?? ""}</span>}
						<span className={styles.editDiffText}>{renderWordParts(newParts)}</span>
					</div>,
				);
				li++; // skip the add line
				lineIdx += 2;
				continue;
			}
		}

		// Normal line — use syntax highlighted tokens if available
		const hlLine = highlightResult?.lines[lineIdx];
		const lineClass =
			line.kind === "context"
				? styles.editDiffContext
				: line.kind === "remove"
					? styles.editDiffOld
					: styles.editDiffNew;

		elements.push(
			<div key={`line-${li}`} className={`${styles.editDiffLine} ${lineClass}`}>
				{lineNumbers && <span className={styles.editDiffGutter}>{line.oldLine ?? ""}</span>}
				{lineNumbers && <span className={styles.editDiffGutter}>{line.newLine ?? ""}</span>}
				<span className={styles.editDiffText}>
					{hlLine && !noHighlight ? (
						// `.codeTokens` is the shared per-token color scope (app/index.css):
						// it resolves each token's light/dark custom properties through the
						// OS preference without touching this row's own semantic color,
						// which the line-class above supplies (removed/added/context).
						<span className="codeTokens">{renderHighlightedTokens(hlLine.tokens)}</span>
					) : (
						line.text
					)}
				</span>
			</div>,
		);
		lineIdx++;
	}

	return elements;
}

function renderWordParts(parts: WordPart[]): ReactNode[] {
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

function renderHighlightedTokens(tokens: HighlightedToken[]): ReactNode[] {
	return tokens.map((t, ti) => {
		const style: Record<string, string> = {};
		if (t.color) style["--code-c"] = t.color;
		if (t.darkColor) style["--shiki-dark"] = t.darkColor;
		return (
			// biome-ignore lint/suspicious/noArrayIndexKey: static token list from shiki
			<span key={ti} style={Object.keys(style).length > 0 ? style : undefined}>
				{t.content}
			</span>
		);
	});
}

export const DiffSections = memo(function DiffSections({
	sections,
	onOpenView,
	lineNumbers,
	contextLines,
	wrap,
}: {
	sections: DiffSectionSpec[];
	/** Opens a section's `viewPath` in the file viewer (the clickable-title
	 * affordance — presentational: the caller owns the store action). */
	onOpenView?: (path: string) => void;
	/** Render a dual old/new line-number gutter (whole-file review). */
	lineNumbers?: boolean;
	/** Collapse unchanged runs to this many context lines. Unset renders every
	 * line (card bodies, which diff small snippets). */
	contextLines?: number;
	/** Wrap long lines (default) instead of scrolling horizontally. */
	wrap?: boolean;
}) {
	// Content signature — the identity of everything the diff computation and
	// highlight pipeline depend on, independent of the array's identity.
	const signature = useMemo(
		() =>
			sections
				.map(
					(s) =>
						`${s.title ?? ""}\u0000${s.viewPath ?? ""}\u0000${(s.notes ?? []).join("\n")}\u0000${s.lang}\u0000${s.oldText}\u0001${s.newText}`,
				)
				.join("\u0002"),
		[sections],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: recompute only on content change — callers rebuild the sections array each render
	const parsed = useMemo(
		() =>
			sections.map((s) => ({
				title: s.title,
				viewPath: s.viewPath ?? null,
				notes: s.notes ?? [],
				lang: s.lang,
				lines: tagInlineWordPairs(computeDiffLines(s.oldText, s.newText)),
			})),
		[signature],
	);

	const [highlighted, setHighlighted] = useState<{ signature: string; results: Array<HighlightResult | null> } | null>(
		null,
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: parsed is derived from signature (memoized above), so the effect fires only on content change
	useEffect(() => {
		let cancelled = false;
		Promise.all(
			parsed.map((s) =>
				s.lang === "" || s.lines.length === 0
					? Promise.resolve(null)
					: highlightTokens(s.lines.map((l) => l.text).join("\n"), s.lang),
			),
		).then((results) => {
			if (!cancelled) setHighlighted({ signature, results });
		});
		return () => {
			cancelled = true;
		};
	}, [signature]);

	if (parsed.length === 0) return null;
	const active = highlighted?.signature === signature ? highlighted.results : null;

	return (
		<div
			className={`${styles.editDiff}${lineNumbers ? ` ${styles.editDiffNumbered}` : ""}${wrap === false ? ` ${styles.editDiffNoWrap}` : ""}`}
		>
			{parsed.map((section, si) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: section order is the identity; content changes remount rows
				<div key={si}>
					{si > 0 && section.title === null && <div className={styles.editDiffHunkSep}>---</div>}
					{section.title !== null &&
						(onOpenView !== undefined && section.viewPath !== null ? (
							<button
								type="button"
								className={`${styles.editDiffSectionTitle} ${styles.editDiffTitleBtn}`}
								title={`Open file: ${section.viewPath}`}
								onClick={() => onOpenView(section.viewPath ?? "")}
							>
								{section.title}
							</button>
						) : (
							<div className={styles.editDiffSectionTitle}>{section.title}</div>
						))}
					{section.notes.map((note, ni) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: note order is the identity
						<div key={ni} className={styles.editDiffNote}>
							{note}
						</div>
					))}
					{renderSectionLines(
						contextLines === undefined ? section.lines : elideContext(section.lines, contextLines),
						active?.[si] ?? null,
						section.lang === "",
						lineNumbers === true,
					)}
				</div>
			))}
		</div>
	);
});

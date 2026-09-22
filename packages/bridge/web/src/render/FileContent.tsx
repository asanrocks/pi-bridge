// ============================================================================
// FileContent — the shared "read one file" body: one surface, one code size,
// one line-number gutter, one truncation notice, and the wrap/markdown display
// toggles. The browser's file pane and its review sections' whole-file view render
// through it, so a file looks the same wherever it is opened.
//
// `language` is passed in rather than derived: this module lives in render/
// and must not reach into a feature for `extToLang`; `path` only decides
// markdown-versus-code.
// ============================================================================

import { useStore } from "../infra/state/store.tsx";
import { CodeSnippet } from "./CodeSnippet.tsx";
import styles from "./FileContent.module.css";
import { MarkdownIcon, WrapIcon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";

interface FileContentProps {
	path: string;
	content: string;
	/** Shiki language id; "" disables highlighting. */
	language?: string;
	/** The server's 256 KB cap clipped this content. */
	truncated?: boolean;
	/** Render a line-number gutter. */
	lineNumbers?: boolean;
	/** 1-based line to mark active (the viewer's `path:98` scroll anchor). */
	highlightLine?: number;
}

export function FileContent({ path, content, language, truncated, lineNumbers, highlightLine }: FileContentProps) {
	const cardWrap = useStore((s) => s.cardWrap);
	const toggleCardWrap = useStore((s) => s.toggleCardWrap);
	const cardMarkdown = useStore((s) => s.cardMarkdown);
	const toggleCardMarkdown = useStore((s) => s.toggleCardMarkdown);
	const isMarkdown = path.toLowerCase().endsWith(".md");

	return (
		<div className={styles.fileContent}>
			<div className={styles.controls}>
				{isMarkdown ? (
					<button
						type="button"
						className={styles.control}
						data-on={cardMarkdown || undefined}
						aria-pressed={cardMarkdown}
						aria-label="Toggle markdown preview"
						title="Toggle markdown preview"
						onClick={toggleCardMarkdown}
					>
						<MarkdownIcon size={13} />
					</button>
				) : (
					<button
						type="button"
						className={styles.control}
						data-on={cardWrap || undefined}
						aria-pressed={cardWrap}
						aria-label="Toggle line wrap"
						title="Toggle line wrap"
						onClick={toggleCardWrap}
					>
						<WrapIcon size={13} />
					</button>
				)}
			</div>
			{truncated && <div className={styles.truncated}>File truncated — showing the first 256&nbsp;KB</div>}
			{isMarkdown ? (
				cardMarkdown ? (
					<Markdown text={content} mode="static" />
				) : (
					<CodeSnippet
						code={content}
						language="markdown"
						wrap={cardWrap}
						lineNumbers={lineNumbers}
						highlightLine={highlightLine}
					/>
				)
			) : (
				<CodeSnippet
					code={content}
					language={language}
					wrap={cardWrap}
					lineNumbers={lineNumbers}
					highlightLine={highlightLine}
				/>
			)}
		</div>
	);
}

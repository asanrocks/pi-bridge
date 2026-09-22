// ============================================================================
// CodeSnippet — standalone highlighted code block.
//
// Renders code through Shiki directly, bypassing the markdown pipeline.
// No code-fence escape issues, no streamdown context dependency.
//
// The highlighter is a shared singleton (from shiki.ts); languages load on
// demand. Until the highlighter/language is ready the raw text is shown.
// ============================================================================

import { memo, useEffect, useMemo, useState } from "react";
import { type HighlightResult, highlightTokens } from "./shiki.ts";

interface CodeSnippetProps {
	code: string;
	language?: string;
	className?: string;
	/** Wrap long lines instead of horizontal scroll. Default: scroll. */
	wrap?: boolean;
	/** Render a line-number gutter. */
	lineNumbers?: boolean;
	/** 1-based line to mark active (viewer scroll anchor, e.g. `path:98`). */
	highlightLine?: number;
}

export const CodeSnippet = memo(function CodeSnippet({
	code,
	language,
	className,
	wrap,
	lineNumbers,
	highlightLine,
}: CodeSnippetProps) {
	const [result, setResult] = useState<HighlightResult | null>(null);
	const lang = language || "";
	const whiteSpace = wrap ? "pre-wrap" : "pre";

	useEffect(() => {
		let cancelled = false;
		highlightTokens(code, lang).then((r) => {
			if (!cancelled) setResult(r);
		});
		return () => {
			cancelled = true;
		};
	}, [code, lang]);

	const hostStyle = useMemo(() => {
		if (!result) return undefined;
		// No `background`: shiki's theme bg (#fff) would bypass the token
		// system and read colder than the warm page tone. Keep the <pre>
		// transparent so the surrounding card surface (--color-background)
		// shows through, matching Streamdown's markdown code-block path.
		// (ADR 07 §Styling invariants #1 — tokens are authoritative.)
		//
		// Colors go out as custom properties, not inline `color`: the
		// .codeTokens rules in app/index.css resolve the light/dark pair through
		// the OS preference, so a theme change re-paints without re-highlighting.
		return { "--code-fg": result.fg, "--shiki-dark-fg": result.darkFg } as React.CSSProperties;
	}, [result]);

	if (!result) {
		return (
			<pre className={`codeTokens${className ? ` ${className}` : ""}`} style={{ overflow: "auto", whiteSpace }}>
				<code>{code}</code>
			</pre>
		);
	}

	return (
		<pre
			className={`codeTokens${className ? ` ${className}` : ""}`}
			style={{ overflow: "auto", whiteSpace, ...hostStyle }}
		>
			<code>
				{result.lines.map((line, lineIdx) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: static token list, no stable key
						key={lineIdx}
						className="line"
						data-line={lineNumbers ? lineIdx + 1 : undefined}
						data-gutter={lineNumbers ? "true" : undefined}
						data-active={lineNumbers && highlightLine === lineIdx + 1 ? "true" : undefined}
					>
						{/* Gutter numbers are CSS counters (Viewer.module.css), not DOM. */}
						{line.tokens.length === 0 ? (
							<wbr />
						) : (
							line.tokens.map((token, tokIdx) => {
								const style: Record<string, string> = {};
								if (token.color) style["--code-c"] = token.color;
								if (token.darkColor) style["--shiki-dark"] = token.darkColor;
								return (
									// biome-ignore lint/suspicious/noArrayIndexKey: static token list
									<span key={tokIdx} style={style}>
										{token.content}
									</span>
								);
							})
						)}
					</span>
				))}
			</code>
		</pre>
	);
});

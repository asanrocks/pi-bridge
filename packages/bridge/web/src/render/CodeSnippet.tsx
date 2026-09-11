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
}

export const CodeSnippet = memo(function CodeSnippet({ code, language, className, wrap }: CodeSnippetProps) {
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

	const rootStyle = useMemo(() => {
		if (!result) return undefined;
		// No `background`: shiki's theme bg (#fff) would bypass the token
		// system and read colder than the warm page tone. Keep the <pre>
		// transparent so the surrounding card surface (--color-background)
		// shows through, matching Streamdown's markdown code-block path.
		// (ADR 07 §Styling invariants #1 — tokens are authoritative.)
		const s: Record<string, string> = { color: result.fg };
		if (result.rootStyle) {
			for (const part of result.rootStyle.split(";")) {
				const sep = part.indexOf(":");
				if (sep > 0) s[part.slice(0, sep).trim()] = part.slice(sep + 1).trim();
			}
		}
		return s;
	}, [result]);

	if (!result) {
		return (
			<pre className={className} style={{ overflow: "auto", whiteSpace }}>
				<code>{code}</code>
			</pre>
		);
	}

	return (
		<pre className={className} style={{ overflow: "auto", whiteSpace, ...rootStyle }}>
			<code>
				{result.lines.map((line, lineIdx) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: static token list, no stable key
					<span key={lineIdx} className="line" style={{ display: "block" }}>
						{line.tokens.length === 0 ? (
							<wbr />
						) : (
							line.tokens.map((token, tokIdx) => {
								const style: Record<string, string> = {};
								if (token.color) style.color = token.color;
								if (token.htmlStyle) {
									Object.assign(style, token.htmlStyle);
								}
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

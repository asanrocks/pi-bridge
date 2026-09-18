// BashIdentity — the shell card's identity line (the whole command),
// syntax-highlighted through the shared Shiki singleton (bash/powershell
// grammar, github-light token colors). CardSkeleton's CardIdentity stays
// presentational and shiki-free for the node SSR tests; this component
// owns the async token fetch. Until the highlighter + grammar are loaded
// (first shell card only — both are singletons) it renders the raw string,
// exactly CardIdentity's display, so the swap is invisible.

import { memo, useEffect, useState } from "react";
import { type HighlightResult, highlightTokens } from "../../../render/shiki.ts";
import styles from "../actionSteps.module.css";

export const BashIdentity = memo(function BashIdentity({ command, lang }: { command: string; lang: string }) {
	const [result, setResult] = useState<HighlightResult | null>(null);

	useEffect(() => {
		let cancelled = false;
		highlightTokens(command, lang).then((r) => {
			if (!cancelled) setResult(r);
		});
		return () => {
			cancelled = true;
		};
	}, [command, lang]);

	if (!result) return <div className={styles.cardIdentity}>{command}</div>;

	// Same treatment decisions as CodeSnippet: no theme bg (the card surface
	// shows through — ADR 07 §Styling invariants #1), theme fg as the root
	// color, per-token colors with the (currently inert) dark-mode custom
	// property carried along for the day a theme toggle exists.
	return (
		<div className={styles.cardIdentity} style={{ color: result.fg }}>
			{result.lines.map((line, lineIdx) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static token list, no stable key
				<span key={lineIdx} style={{ display: "block" }}>
					{line.tokens.length === 0 ? (
						<wbr />
					) : (
						line.tokens.map((token, tokIdx) => {
							const style: Record<string, string> = {};
							if (token.color) style.color = token.color;
							if (token.htmlStyle) Object.assign(style, token.htmlStyle);
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
		</div>
	);
});

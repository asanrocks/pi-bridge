// FallbackCardBody — generic card for unknown tools. The band header
// carries the tool name; the body is the args grid + result text.

import { memo } from "react";
import { useStore } from "../../../infra/store.tsx";
import { CodeSnippet } from "../../../render/CodeSnippet.tsx";
import { ResultImages } from "../../../render/ResultImages.tsx";
import styles from "../actionSteps.module.css";
import { type ActionDetailsProps, formatArgValue } from "./args.ts";

export const FallbackCardBody = memo(function FallbackCardBody({ args, resultText, resultImages }: ActionDetailsProps) {
	const wrap = useStore((s) => s.cardWrap);
	return (
		<div className={styles.cardBody}>
			{args && Object.keys(args).length > 0 && (
				<div className={styles.toolArgsGrid}>
					{Object.entries(args).map(([key, value]) => (
						<div key={key} className={styles.toolArgRow}>
							<span className={styles.toolArgKey}>{key}:</span>
							<span className={styles.toolArgValue}>{formatArgValue(value)}</span>
						</div>
					))}
				</div>
			)}
			{resultText && (
				<>
					{args && Object.keys(args).length > 0 && <div className={styles.fallbackDivider} />}
					<CodeSnippet code={resultText} wrap={wrap} />
				</>
			)}
			{resultImages.length > 0 && (
				<>
					{(resultText || (args && Object.keys(args).length > 0)) && <div className={styles.fallbackDivider} />}
					<ResultImages images={resultImages} />
				</>
			)}
		</div>
	);
});

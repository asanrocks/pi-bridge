// ReadCardBody — code card. The band header carries the path; the body is
// the file content on the white inset panel. Truncated reads show a
// warning strip with the tool's continuation notice (offset hint) instead
// of the notice leaking into the code. .md files render as prose when the
// markdown toggle is on (store-wide toggle), source otherwise.

import { memo, useMemo } from "react";
import { useStore } from "../../../infra/store.tsx";
import { CodeSnippet } from "../../../render/CodeSnippet.tsx";
import { ResultImages } from "../../../render/ResultImages.tsx";
import { AppMarkdown } from "../../viewer/AppMarkdown.tsx";
import styles from "../actionSteps.module.css";
import { type ActionDetailsProps, extToLang } from "./args.ts";
import { parseReadNotice } from "./resultText.ts";

// Render as soon as `path` or `resultText` is available. `path` streams as
// an argument; `resultText` arrives with the tool result. Don't gate the
// whole body on `path` — it may stream after other args. When the result
// carries images, they replace the text snippet: the text for an image
// read is just the "Read image file [mime]" caption, redundant once the
// image itself renders.
export const ReadCardBody = memo(function ReadCardBody({ args, resultText, resultImages }: ActionDetailsProps) {
	const wrap = useStore((s) => s.cardWrap);
	const markdown = useStore((s) => s.cardMarkdown);
	const parsed = useMemo(() => parseReadNotice(resultText ?? ""), [resultText]);
	const path = args?.path as string | undefined;
	if (path === undefined && !resultText && resultImages.length === 0) return null;
	const lang = path ? extToLang(path) : "";
	const renderProse =
		markdown && path !== undefined && path.endsWith(".md") && parsed.content !== "" && resultText !== null;
	return (
		<div className={styles.cardBody}>
			{resultImages.length > 0 ? (
				<ResultImages images={resultImages} />
			) : renderProse ? (
				<AppMarkdown text={parsed.content} mode="static" />
			) : (
				parsed.content && <CodeSnippet code={parsed.content} language={lang} wrap={wrap} />
			)}
			{parsed.notice && <div className={styles.cardNotice}>{parsed.notice}</div>}
		</div>
	);
});

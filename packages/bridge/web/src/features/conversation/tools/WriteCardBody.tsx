// WriteCardBody — written-content card. The band header carries the
// path; the body is the content on the white inset panel, with the tool's
// confirmation line ("Successfully wrote N bytes to ...") under it on
// success. .md content renders as prose when the markdown toggle is on
// (store-wide toggle), source otherwise.

import { memo } from "react";
import { useStore } from "../../../infra/store.tsx";
import { CodeSnippet } from "../../../render/CodeSnippet.tsx";
import { AppMarkdown } from "../../viewer/AppMarkdown.tsx";
import styles from "../actionSteps.module.css";
import { type ActionDetailsProps, extToLang } from "./args.ts";

// Render as soon as either `path` or `content` is streaming in. The LLM may
// emit the (large) content before the `path` key; gating the whole body on
// `path` hid that streaming content until `path` arrived — often near
// completion. Language detection waits for `path` (CodeSnippet renders
// plain text until then).
export const WriteCardBody = memo(function WriteCardBody({ args, resultText }: ActionDetailsProps) {
	const wrap = useStore((s) => s.cardWrap);
	const markdown = useStore((s) => s.cardMarkdown);
	const path = args?.path as string | undefined;
	const content = args?.content as string | undefined;
	if (path === undefined && (content === undefined || content === null)) return null;
	const lang = path ? extToLang(path) : "";
	const renderProse = markdown && path !== undefined && path.endsWith(".md");
	return (
		<div className={styles.cardBody}>
			{content !== undefined &&
				content !== null &&
				(renderProse ? (
					<AppMarkdown text={content} mode="static" />
				) : (
					<CodeSnippet code={content} language={lang} wrap={wrap} />
				))}
			{resultText && <div className={styles.cardConfirm}>{resultText}</div>}
		</div>
	);
});

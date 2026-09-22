// ============================================================================
// AppMarkdown — the app-wide Markdown with link handling wired in.
//
// render/Markdown stays app-agnostic (Streamdown defaults); this wrapper is
// where the app's link policy lives: file-path hrefs → FileBrowser, URLs →
// external-link confirm. The `components` object is module-level so its
// identity is stable across renders (Streamdown memoizes on it).
// ============================================================================

import { Markdown } from "../../render/markdown.tsx";
import { MarkdownLink } from "./MarkdownLink.tsx";

const components = { a: MarkdownLink };

export function AppMarkdown({ text, mode }: { text: string; mode?: "streaming" | "static" }) {
	return <Markdown text={text} mode={mode} components={components} />;
}

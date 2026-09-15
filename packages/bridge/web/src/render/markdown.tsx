// ============================================================================
// Markdown component — renders markdown via streamdown.
// Streamdown uses unified/remark/rehype with incremental HAST diffing
// instead of nuking the DOM subtree on every chunk (marked +
// dangerouslySetInnerHTML). No flicker during streaming.
//
// Two modes:
//   "streaming"  — for in-progress provisional blocks
//   "static"     — for sealed, committed blocks
// ============================================================================

import { useEffect, useState } from "react";
import type { CodeHighlighterPlugin, Components, ControlsConfig, ThemeInput } from "streamdown";
import { parseMarkdownIntoBlocks, Streamdown } from "streamdown";
import { createShikiPlugin } from "./shiki.ts";

// ---------------------------------------------------------------------------
// Module-level constants — stable references so Streamdown's memo and
// useMemo contextValue don't invalidate on every render.
// ---------------------------------------------------------------------------

const SHIKI_THEME: [ThemeInput, ThemeInput] = ["github-light", "github-dark"];
// code: copy only — the PRD specifies copy buttons; download adds a second
// icon to the actions region and isn't useful for in-conversation snippets.
const CONTROLS: ControlsConfig = { code: { copy: true, download: false }, table: false, mermaid: false };

// Start loading the Shiki highlighter immediately on module import.
let shikiPlugin: CodeHighlighterPlugin | null = null;
let pluginInit: Promise<CodeHighlighterPlugin> | null = null;

function getShikiPlugin(): Promise<CodeHighlighterPlugin> {
	if (shikiPlugin) return Promise.resolve(shikiPlugin);
	if (!pluginInit) {
		pluginInit = new Promise<CodeHighlighterPlugin>((resolve) => {
			const plugin = createShikiPlugin();
			// Trigger the async highlighter creation. The plugin's highlight()
			// method handles async internally (returns null + callback), but
			// we fire it eagerly so it's ready by the time code blocks arrive.
			shikiPlugin = plugin;
			resolve(plugin);
		});
	}
	return pluginInit;
}

// Kick off eager init (module-level side effect).
getShikiPlugin();

// ---------------------------------------------------------------------------
// Markdown — wraps streamdown with our defaults.
// ---------------------------------------------------------------------------

interface MarkdownProps {
	text: string;
	mode?: "streaming" | "static";
	/** Element renderers merged over Streamdown's defaults (tag → component).
	 * Used by the app layer to swap the link renderer (file-viewer links). */
	components?: Components;
}

export function Markdown({ text, mode = "static", components }: MarkdownProps) {
	// Track highlighter readiness so we pass `plugins` only after the async
	// highlighter has loaded. Until then, Streamdown renders plain-text code
	// blocks (no flicker — they upgrade in-place when the plugin arrives).
	const [ready, setReady] = useState(!!shikiPlugin?.getSupportedLanguages);

	useEffect(() => {
		if (ready) return;
		getShikiPlugin().then(() => setReady(true));
	}, [ready]);

	return (
		<Streamdown
			mode={mode}
			shikiTheme={SHIKI_THEME}
			controls={CONTROLS}
			components={components}
			parseIncompleteMarkdown={true}
			parseMarkdownIntoBlocksFn={parseMarkdownIntoBlocks}
			plugins={ready ? { code: shikiPlugin! } : undefined}
		>
			{text}
		</Streamdown>
	);
}

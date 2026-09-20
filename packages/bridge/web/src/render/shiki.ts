// ============================================================================
// Shared shiki setup — singleton highlighter, dual-theme token highlighting.
//
// Two consumers:
//   1. streamdown's CodeHighlighterPlugin (for markdown code blocks)
//   2. CodeSnippet (for tool card bodies, no markdown wrapping)
// ============================================================================

import langCmake from "@shikijs/langs/cmake";
import langDiff from "@shikijs/langs/diff";
import langDocker from "@shikijs/langs/docker";
import langDockerfile from "@shikijs/langs/dockerfile";
// Additional grammars beyond the web bundle — imported individually to avoid
// pulling in the full 609-language bundle.
import langGo from "@shikijs/langs/go";
import langMakefile from "@shikijs/langs/makefile";
import langRust from "@shikijs/langs/rust";
import langToml from "@shikijs/langs/toml";
import { bundledLanguages, createHighlighter, type Highlighter } from "shiki/bundle/web";
import type { CodeHighlighterPlugin, HighlightOptions } from "streamdown";

// Register them in the bundledLanguages object so createHighlighter's
// resolveLang closure can find them by string name.
const extraLangs: Record<string, () => Promise<{ default: readonly unknown[] }>> = {
	go: () => Promise.resolve({ default: langGo }),
	rust: () => Promise.resolve({ default: langRust }),
	rs: () => Promise.resolve({ default: langRust }),
	toml: () => Promise.resolve({ default: langToml }),
	cmake: () => Promise.resolve({ default: langCmake }),
	makefile: () => Promise.resolve({ default: langMakefile }),
	make: () => Promise.resolve({ default: langMakefile }),
	diff: () => Promise.resolve({ default: langDiff }),
	docker: () => Promise.resolve({ default: langDocker }),
	dockerfile: () => Promise.resolve({ default: langDockerfile }),
};
Object.assign(bundledLanguages, extraLangs);

// ---------------------------------------------------------------------------
// Public token shape — a plain object returned by highlightTokens()
//
// Both themes' colors travel to the DOM as custom properties, not as inline
// `color` declarations: `--code-c` / `--code-fg` carry the light values and
// `--shiki-dark` / `--shiki-dark-fg` the dark ones, and the `.codeTokens` rules
// in app/index.css pick through the OS preference's media query. An inline
// `color` would win over it, which is why the earlier single-theme shape could
// not be themed without a re-render. (Streamdown's markdown path does the same thing
// through its own span classes and Tailwind's dark: variant.)
// Backgrounds are deliberately absent: code hosts keep their surface
// transparent so the surrounding card tone shows through.
// ---------------------------------------------------------------------------

export interface HighlightedToken {
	content: string;
	color?: string;
	darkColor?: string;
}

export interface HighlightedLine {
	tokens: HighlightedToken[];
}

export interface HighlightResult {
	fg: string;
	darkFg: string;
	lines: HighlightedLine[];
}

// ---------------------------------------------------------------------------
// Singleton highlighter — loads only the two GitHub themes up front;
// languages load on demand via hl.loadLanguage().
// ---------------------------------------------------------------------------

const LIGHT_THEME = "github-light";
const DARK_THEME = "github-dark";

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighter: Highlighter | null = null;

function ensureHighlighter(): Promise<Highlighter> {
	if (highlighter) return Promise.resolve(highlighter);
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter({
			themes: [LIGHT_THEME, DARK_THEME],
			langs: [], // loaded on demand
		}).then((hl) => {
			highlighter = hl;
			return hl;
		});
	}
	return highlighterPromise;
}

// ---------------------------------------------------------------------------
// Ensure a language is loaded; returns true if ready.
// ---------------------------------------------------------------------------

async function ensureLanguage(language: string): Promise<boolean> {
	const hl = await ensureHighlighter();
	if (!hl.getLoadedLanguages().includes(language as never)) {
		try {
			await hl.loadLanguage(language as never);
		} catch {
			return false;
		}
	}
	return hl.getLoadedLanguages().includes(language as never);
}

// ---------------------------------------------------------------------------
// highlightTokens — synchronous once the highlighter + language are loaded.
// Handles both themes, merging dark colors as CSS custom properties.
// ---------------------------------------------------------------------------

export async function highlightTokens(code: string, language: string): Promise<HighlightResult> {
	const hl = await ensureHighlighter();

	const langOk = await ensureLanguage(language);
	if (!langOk) {
		return {
			fg: "inherit",
			darkFg: "inherit",
			lines: code.split("\n").map((line) => ({ tokens: [{ content: line }] })),
		};
	}

	const lightResult = hl.codeToTokens(code, { lang: language as never, theme: LIGHT_THEME });
	const darkResult = hl.codeToTokens(code, { lang: language as never, theme: DARK_THEME });

	const lines: HighlightedLine[] = [];
	for (let lineIdx = 0; lineIdx < lightResult.tokens.length; lineIdx++) {
		const lightLine = lightResult.tokens[lineIdx];
		const darkLine = darkResult.tokens[lineIdx] ?? lightLine;
		const tokens: HighlightedToken[] = [];

		for (let tokIdx = 0; tokIdx < lightLine.length; tokIdx++) {
			const lt = lightLine[tokIdx];
			const dt = darkLine[tokIdx] ?? lt;
			tokens.push({ content: lt.content, color: lt.color, darkColor: dt.color });
		}
		lines.push({ tokens });
	}

	const lightTheme = hl.getTheme(LIGHT_THEME);
	const darkTheme = hl.getTheme(DARK_THEME);
	const fg = lightTheme?.fg ?? "inherit";

	return {
		fg,
		darkFg: darkTheme?.fg ?? fg,
		lines,
	};
}

// ---------------------------------------------------------------------------
// Streamdown back-end types (structural — streamdown doesn't export these)
// ---------------------------------------------------------------------------

type SdToken = {
	content: string;
	color?: string;
	bgColor?: string;
	offset?: number;
	htmlStyle?: Record<string, string>;
};
type SdResult = { bg?: string; fg?: string; rootStyle?: string | false; tokens: SdToken[][] };

// ---------------------------------------------------------------------------
// Streamdown CodeHighlighterPlugin — wraps the same singleton for
// markdown-parsed code blocks (the normal streamdown path).
// ---------------------------------------------------------------------------

export function createShikiPlugin(): CodeHighlighterPlugin {
	const plugin = {
		name: "shiki",
		type: "code-highlighter" as const,

		getSupportedLanguages() {
			return Object.keys(bundledLanguages);
		},

		getThemes() {
			return [LIGHT_THEME, DARK_THEME];
		},

		supportsLanguage(language: string) {
			return language in bundledLanguages;
		},

		highlight(options: HighlightOptions, callback?: (result: SdResult) => void): SdResult | null {
			const hl = highlighter;
			if (!hl) {
				ensureHighlighter().then(() => {
					const result = doHighlightForStreamdown(highlighter!, options);
					callback?.(result);
				});
				return null;
			}
			return doHighlightForStreamdown(hl, options);
		},
	} as CodeHighlighterPlugin;

	return plugin;
}

// ---------------------------------------------------------------------------
// Streamdown back-end — returns the shape HighlightedCodeBlockBody expects
// (tokens as HighlightToken[][] with color/htmlStyle on each token).
// ---------------------------------------------------------------------------

function doHighlightForStreamdown(hl: Highlighter, { code, language, themes }: HighlightOptions): SdResult {
	const lightKey = typeof themes[0] === "string" ? themes[0] : LIGHT_THEME;
	const darkKey = typeof themes[1] === "string" ? themes[1] : DARK_THEME;

	for (const t of [lightKey, darkKey]) {
		if (!hl.getLoadedThemes().includes(t as never)) {
			try {
				hl.loadTheme(t as never);
			} catch {
				// skip
			}
		}
	}

	if (!hl.getLoadedLanguages().includes(language as never)) {
		try {
			hl.loadLanguage(language as never);
		} catch {
			// fallback
		}
	}
	if (!hl.getLoadedLanguages().includes(language as never)) {
		return { bg: "transparent", fg: "inherit", tokens: code.split("\n").map((l) => [{ content: l }]) };
	}

	const lightResult = hl.codeToTokens(code, { lang: language as never, theme: lightKey });
	const darkResult = hl.codeToTokens(code, { lang: language as never, theme: darkKey });

	const tokens: SdToken[][] = [];
	for (let lineIdx = 0; lineIdx < lightResult.tokens.length; lineIdx++) {
		const lightLine = lightResult.tokens[lineIdx];
		const darkLine = darkResult.tokens[lineIdx] ?? lightLine;
		const mergedLine: SdToken[] = [];

		for (let tokIdx = 0; tokIdx < lightLine.length; tokIdx++) {
			const lt = lightLine[tokIdx];
			const dt = darkLine[tokIdx] ?? lt;
			const merged: SdToken = {
				content: lt.content,
				offset: lt.offset,
				color: lt.color,
			};
			if (dt.color && dt.color !== lt.color) {
				merged.htmlStyle = { "--shiki-dark": dt.color };
			}
			if (dt.bgColor && dt.bgColor !== lt.bgColor) {
				if (!merged.htmlStyle) merged.htmlStyle = {};
				merged.htmlStyle["--shiki-dark-bg"] = dt.bgColor;
			}
			mergedLine.push(merged);
		}
		tokens.push(mergedLine);
	}

	let rootStyle: string | undefined;
	try {
		const ld = hl.getTheme(lightKey);
		const dd = hl.getTheme(darkKey);
		const bg = ld?.bg ?? "transparent";
		const fg = ld?.fg ?? "inherit";
		if (dd?.bg) rootStyle = `--shiki-dark-bg:${dd.bg}`;
		return { tokens, bg, fg, rootStyle };
	} catch {
		return { tokens, bg: "transparent", fg: "inherit" };
	}
}

// ============================================================================
// pathToken — pure caret-token extraction and the two completion triggers.
//
// `usePathCompletion` owns the dropdown; the predicates live here so both
// triggers (`Tab` and the touch auto-open) are unit-testable without a DOM.
// They differ deliberately: auto-open fires from ordinary typing, so it
// rejects the empty token and scheme/URL tokens that the Tab key may accept.
// ============================================================================

/** The whitespace-delimited token ending at the caret and its start offset. */
export interface CaretToken {
	token: string;
	start: number;
}

/** Split at whitespace, quotes, and `=`, the separators used around paths in
 *  prompts (`--flag=./src`, `"src/a"`). */
const TOKEN_BREAKS = new Set([" ", "\t", '"', "'", "="]);

export function tokenAtCaret(text: string, caret: number): CaretToken {
	const end = Math.max(0, Math.min(caret, text.length));
	let start = 0;
	for (let i = end - 1; i >= 0; i--) {
		if (TOKEN_BREAKS.has(text[i])) {
			start = i + 1;
			break;
		}
	}
	return { token: text.slice(start, end), start };
}

/** Tab trigger: any path-like token. The empty token is included so Tab on an
 *  empty line lists the Project cwd. */
export function isPathToken(token: string): boolean {
	return (
		token === "" ||
		token.startsWith("/") ||
		token.startsWith("./") ||
		token.startsWith("../") ||
		token.startsWith("~/") ||
		token.includes("/")
	);
}

/** Touch auto-open trigger: stricter than `isPathToken` because it fires on
 *  ordinary typing rather than a deliberate key. Rejects the empty token and
 *  scheme/URL tokens (`http://`, `C:/`); a bare `a/b` is allowed — a
 *  nonexistent prefix simply yields no entries and the dropdown stays shut. */
export function isAutoOpenToken(token: string): boolean {
	return token !== "" && !token.includes(":") && token.includes("/");
}

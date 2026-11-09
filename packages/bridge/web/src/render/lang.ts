// Language for syntax highlighting, decided from the path alone: the browser has
// no modeline, no `.gitattributes`, and no repository scan, so the path is the
// whole input (see `langMap.generated.ts` for where the table comes from).
//
// Order: a known filename (`Makefile`, `CMakeLists.txt`) beats an extension,
// then the longest known suffix wins (`.d.ts` before `.ts`, `.min.js` before
// `.js`), and an exact-case entry beats a folded one. Unknown paths return "" —
// `CodeSnippet` renders those as plain text, which is always better than a
// wrong grammar.

import { baseName } from "../infra/lib/paths.ts";
import { LANG_BY_EXTENSION, LANG_BY_FILENAME } from "./langMap.generated.ts";

/** Legacy `.C` is C++ while `.c` is C; Linguist's data cannot express a
 * case-only distinction, so the one case-sensitive convention is here. */
const UPPERCASE_C = ".C";

export function highlightLanguageFor(path: string): string {
	const name = baseName(path);
	const byName = LANG_BY_FILENAME[name] ?? LANG_BY_FILENAME[name.toLowerCase()];
	if (byName !== undefined) return byName;
	// A dotfile's leading dot is part of its name, not an extension: its whole
	// filename was the lookup above.
	for (let dot = name.indexOf(".", 1); dot !== -1; dot = name.indexOf(".", dot + 1)) {
		const suffix = name.slice(dot);
		const hit = LANG_BY_EXTENSION[suffix] ?? LANG_BY_EXTENSION[suffix.toLowerCase()];
		if (hit !== undefined) return suffix === UPPERCASE_C ? LANG_BY_EXTENSION[".cpp"] : hit;
	}
	return "";
}

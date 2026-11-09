// lang — the path to highlighter-language decision, and the guard on its table:
// every id the generated map names must be one this client can actually load
// (the Shiki web bundle, plus the extra grammars `shiki.ts` registers). A
// Linguist rename or a Shiki bundle change then fails here instead of silently
// rendering files unhighlighted.

import { bundledLanguages } from "shiki/bundle/web";
import { describe, expect, test } from "vitest";
import { highlightLanguageFor } from "./lang.ts";
import { LANG_BY_EXTENSION, LANG_BY_FILENAME } from "./langMap.generated.ts";
// Registers the extra grammars (makefile, dockerfile, cmake, diff) into
// bundledLanguages, which is the set the highlighter resolves against.
import "./shiki.ts";

describe("langMap — generated data stays in the loadable set", () => {
	test("every mapped id can be loaded by the highlighter", () => {
		const unsupported = [...new Set([...Object.values(LANG_BY_EXTENSION), ...Object.values(LANG_BY_FILENAME)])]
			.filter((id) => !(id in bundledLanguages))
			.sort();
		expect(unsupported).toEqual([]);
	});
});

describe("highlightLanguageFor — the path decides", () => {
	test("the C and C++ family, including the owned `.h`", () => {
		expect(highlightLanguageFor("src/main.c")).toBe("c");
		expect(highlightLanguageFor("src/main.cc")).toBe("cpp");
		expect(highlightLanguageFor("src/main.cpp")).toBe("cpp");
		expect(highlightLanguageFor("src/main.cxx")).toBe("cpp");
		expect(highlightLanguageFor("include/main.hpp")).toBe("cpp");
		expect(highlightLanguageFor("include/main.h")).toBe("cpp");
		expect(highlightLanguageFor("include/main.hxx")).toBe("cpp");
	});

	test("a legacy uppercase `.C` is C++, lowercase `.c` is C", () => {
		expect(highlightLanguageFor("src/legacy.C")).toBe("cpp");
		expect(highlightLanguageFor("src/legacy.c")).toBe("c");
	});

	test("the longest known suffix wins", () => {
		expect(highlightLanguageFor("src/types.d.ts")).toBe("typescript");
		expect(highlightLanguageFor("web/app.min.js")).toBe("javascript");
		expect(highlightLanguageFor("src/module.test.tsx")).toBe("tsx");
	});

	test("a filename beats an extension, and dotfiles are filenames", () => {
		expect(highlightLanguageFor("PROJECT/Makefile")).toBe("makefile");
		expect(highlightLanguageFor("PROJECT/CMakeLists.txt")).toBe("cmake");
		expect(highlightLanguageFor("PROJECT/Dockerfile")).toBe("dockerfile");
		expect(highlightLanguageFor("PROJECT/.gitignore")).toBe("");
	});

	test("case folds for ordinary extensions", () => {
		expect(highlightLanguageFor("src/tool.PY")).toBe("python");
		expect(highlightLanguageFor("cfg/app.YML")).toBe("yaml");
	});

	test("an unknown path degrades to plain text", () => {
		expect(highlightLanguageFor("notes.unknownext")).toBe("");
		expect(highlightLanguageFor("LICENSE")).toBe("");
		expect(highlightLanguageFor("dir/")).toBe("");
	});
});

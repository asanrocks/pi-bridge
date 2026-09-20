// Unit tests for the completion triggers. Both feed usePathCompletion; the
// predicates are pure, so the Tab-vs-touch difference is pinned here rather
// than through a DOM.

import { describe, expect, it } from "vitest";
import { isAutoOpenToken, isPathToken, tokenAtCaret } from "./pathToken.ts";

describe("tokenAtCaret", () => {
	it("returns the token ending at the caret", () => {
		expect(tokenAtCaret("see ./src", 9)).toEqual({ token: "./src", start: 4 });
	});

	it("stops at the caret, not the end of the text", () => {
		expect(tokenAtCaret("see ./src now", 7)).toEqual({ token: "./s", start: 4 });
	});

	it("splits on quotes and =", () => {
		expect(tokenAtCaret('open "./src/a', 13)).toEqual({ token: "./src/a", start: 6 });
		expect(tokenAtCaret("--file=./a", 10)).toEqual({ token: "./a", start: 7 });
	});

	it("returns an empty token at the start of the text", () => {
		expect(tokenAtCaret("./a", 0)).toEqual({ token: "", start: 0 });
	});
});

describe("isPathToken (Tab)", () => {
	it("accepts path-like tokens and the empty token", () => {
		for (const token of ["", "./src", "../a", "~/x", "/abs", "src/a", "a/b"]) {
			expect(isPathToken(token), token).toBe(true);
		}
	});

	it("rejects a bare word", () => {
		expect(isPathToken("src")).toBe(false);
		expect(isPathToken("README")).toBe(false);
	});
});

describe("isAutoOpenToken (touch)", () => {
	it("accepts a path token without a scheme", () => {
		expect(isAutoOpenToken("./s")).toBe(true);
		expect(isAutoOpenToken("src/")).toBe(true);
		expect(isAutoOpenToken("../a/b")).toBe(true);
	});

	it("rejects the empty token, bare words, and URL/scheme tokens", () => {
		expect(isAutoOpenToken("")).toBe(false);
		expect(isAutoOpenToken("src")).toBe(false);
		expect(isAutoOpenToken("http://x/y")).toBe(false);
		expect(isAutoOpenToken("C:/Users")).toBe(false);
	});
});

// Output sanitization — mirrors the TUI's getTextOutput pipeline so ANSI
// escapes, binary control characters, and stray carriage returns never
// reach card content or copy payloads.

import { describe, expect, test } from "vitest";
import { sanitizeOutputText } from "./sanitize.ts";

describe("sanitizeOutputText", () => {
	test("plain text passes through", () => {
		expect(sanitizeOutputText("hello\nworld")).toBe("hello\nworld");
	});

	test("fast path: text without ESC is untouched", () => {
		expect(sanitizeOutputText("no escapes here")).toBe("no escapes here");
	});

	test("CSI color codes are stripped", () => {
		expect(sanitizeOutputText("\u001B[31mred\u001B[0m plain")).toBe("red plain");
	});

	test("OSC sequences (window title) are stripped", () => {
		expect(sanitizeOutputText("\u001B]0;title\u0007echo hi")).toBe("echo hi");
	});

	test("carriage returns are dropped (CRLF -> LF)", () => {
		expect(sanitizeOutputText("a\r\nb\rc")).toBe("a\nbc");
	});

	test("control characters drop except tab and newline", () => {
		expect(sanitizeOutputText("a\u0000b\u0007c\td\ne")).toBe("abc\td\ne");
	});

	test("surrogate pairs (emoji) survive", () => {
		expect(sanitizeOutputText("\u{1F600} ok")).toBe("\u{1F600} ok");
	});

	test("unicode format characters drop", () => {
		expect(sanitizeOutputText("a\uFFF9b")).toBe("ab");
	});

	test("text that sanitizes to empty", () => {
		expect(sanitizeOutputText("\u001B[2K\r")).toBe("");
	});
});

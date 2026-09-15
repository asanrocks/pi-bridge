import { describe, expect, it } from "vitest";
import { classifyHref } from "./links.ts";

describe("classifyHref", () => {
	it("classifies URL schemes as urls", () => {
		expect(classifyHref("https://example.com")).toEqual({ kind: "url", url: "https://example.com" });
		expect(classifyHref("http://a.b/c?d=e")).toEqual({ kind: "url", url: "http://a.b/c?d=e" });
		expect(classifyHref("mailto:a@b.c")).toEqual({ kind: "url", url: "mailto:a@b.c" });
		expect(classifyHref("HTTPS://EXAMPLE.COM")).toEqual({ kind: "url", url: "HTTPS://EXAMPLE.COM" });
	});

	it("classifies relative and absolute paths as files", () => {
		expect(classifyHref("./README.md")).toEqual({ kind: "file", path: "./README.md" });
		expect(classifyHref("docs/guide.md")).toEqual({ kind: "file", path: "docs/guide.md" });
		expect(classifyHref("/home/u/notes.md")).toEqual({ kind: "file", path: "/home/u/notes.md" });
		expect(classifyHref("~/notes.md")).toEqual({ kind: "file", path: "~/notes.md" });
	});

	it("treats Windows drive letters as paths, not schemes", () => {
		expect(classifyHref("C:\\Users\\u\\file.md")).toEqual({ kind: "file", path: "C:\\Users\\u\\file.md" });
		expect(classifyHref("c:/src/file.ts")).toEqual({ kind: "file", path: "c:/src/file.ts" });
	});

	it("unwraps file:// URIs", () => {
		expect(classifyHref("file:///home/u/a.md")).toEqual({ kind: "file", path: "/home/u/a.md" });
		expect(classifyHref("file:///home/u/a%20b.md")).toEqual({ kind: "file", path: "/home/u/a b.md" });
		// Malformed percent-escapes must not throw — the raw path is kept.
		expect(classifyHref("file:///home/u/%zz.md")).toEqual({ kind: "file", path: "/home/u/%zz.md" });
	});

	it("strips markdown fragments from file paths", () => {
		expect(classifyHref("README.md#section")).toEqual({ kind: "file", path: "README.md" });
		expect(classifyHref("docs/a.md#heading")).toEqual({ kind: "file", path: "docs/a.md" });
	});

	it("returns null for empty, fragment-only, and streaming-incomplete hrefs", () => {
		expect(classifyHref("")).toBeNull();
		expect(classifyHref("   ")).toBeNull();
		expect(classifyHref("#section")).toBeNull();
		expect(classifyHref("streamdown:incomplete-link")).toBeNull();
	});
});

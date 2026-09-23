// Unit tests for the visibleModels resolver (ADR 15): a canonical
// `provider/modelId` pattern matched with minimatch against the full
// `provider/modelId` reference — `/` anchors, `**` crosses — with an optional
// thinking-level suffix. A non-canonical pattern (bare id) matches nothing.

import { describe, expect, it } from "vitest";
import { isModelVisible, resolveVisibleModelKeys } from "../../src/host/model-visibility.ts";

const CATALOG = [
	{ provider: "faux", id: "faux-1" },
	{ provider: "faux", id: "faux-2" },
	{ provider: "anthropic", id: "claude-sonnet-4-5" },
	{ provider: "deepseek", id: "deepseek-chat" },
	{ provider: "openrouter", id: "deepseek/deepseek-chat" },
	{ provider: "openrouter", id: "anthropic/claude-opus-5" },
	{ provider: "xiaomi", id: "mimo-v2.6-flash" },
	{ provider: "opencode-go", id: "mimo-v2.6-flash" },
	{ provider: "openrouter", id: "xiaomi/mimo-v2.6-flash" },
];

describe("model-visibility", () => {
	it("matches an exact provider/model reference", () => {
		expect(resolveVisibleModelKeys(["faux/faux-1"], CATALOG)).toEqual(["faux/faux-1"]);
	});

	it("anchors the provider through the slash", () => {
		// `deepseek/*` selects the models DeepSeek serves; the `*` cannot cross
		// the `/`, so it never reaches an OpenRouter-routed model.
		expect(resolveVisibleModelKeys(["deepseek/*"], CATALOG)).toEqual(["deepseek/deepseek-chat"]);
		// The routed one is addressable explicitly, id glob included.
		expect(resolveVisibleModelKeys(["openrouter/deepseek/*"], CATALOG)).toEqual([
			"openrouter/deepseek/deepseek-chat",
		]);
		// A single `*` does not cross a `/`; `**` does.
		expect(resolveVisibleModelKeys(["openrouter/*"], CATALOG)).toEqual([]);
		expect(resolveVisibleModelKeys(["openrouter/**"], CATALOG)).toEqual([
			"openrouter/deepseek/deepseek-chat",
			"openrouter/anthropic/claude-opus-5",
			"openrouter/xiaomi/mimo-v2.6-flash",
		]);
	});

	it("globs the provider segment and crosses routing with **", () => {
		// `*/mimo-v2.6*` matches any provider serving that id, but not the routed
		// `openrouter` row whose id is `xiaomi/mimo-v2.6-flash`.
		expect(resolveVisibleModelKeys(["*/mimo-v2.6*"], CATALOG)).toEqual([
			"xiaomi/mimo-v2.6-flash",
			"opencode-go/mimo-v2.6-flash",
		]);
		// `**` consumes the routing prefix, so a bare model-name glob reaches it.
		expect(resolveVisibleModelKeys(["**/claude-*-5*"], CATALOG)).toEqual([
			"anthropic/claude-sonnet-4-5",
			"openrouter/anthropic/claude-opus-5",
		]);
		expect(resolveVisibleModelKeys(["openrouter/anthropic/claude-*"], CATALOG)).toEqual([
			"openrouter/anthropic/claude-opus-5",
		]);
	});

	it("rejects a bare model id (not canonical)", () => {
		expect(resolveVisibleModelKeys(["faux-1"], CATALOG)).toEqual([]);
	});

	it("matches an id glob within the provider", () => {
		expect(resolveVisibleModelKeys(["anthropic/claude-*"], CATALOG)).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(resolveVisibleModelKeys(["faux/*"], CATALOG)).toEqual(["faux/faux-1", "faux/faux-2"]);
	});

	it("is case-insensitive", () => {
		expect(resolveVisibleModelKeys(["ANTHROPIC/Claude-*"], CATALOG)).toEqual(["anthropic/claude-sonnet-4-5"]);
	});

	it("strips a thinking-level suffix", () => {
		expect(isModelVisible(CATALOG[0], ["faux/faux-1:high"])).toBe(true);
		// An unknown suffix is part of the pattern, not a level: it matches nothing.
		expect(isModelVisible(CATALOG[0], ["faux/faux-1:bogus"])).toBe(false);
	});

	it("treats an empty scope as no filter and a malformed pattern as no match", () => {
		expect(resolveVisibleModelKeys([], CATALOG)).toEqual([]);
		expect(resolveVisibleModelKeys(["[unterminated"], CATALOG)).toEqual([]);
		expect(resolveVisibleModelKeys(["faux/"], CATALOG)).toEqual([]);
		expect(resolveVisibleModelKeys(["/faux-1"], CATALOG)).toEqual([]);
	});

	it("keeps catalogue order and de-duplicates across patterns", () => {
		expect(resolveVisibleModelKeys(["faux/faux-2", "faux/*"], CATALOG)).toEqual(["faux/faux-1", "faux/faux-2"]);
	});
});

import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../../../src/core/index.ts";
import { sortByLastActivity } from "./sortByLastActivity.ts";

function row(stem: string, lastActivityAt?: string): SessionInfo {
	return {
		projectId: "p",
		sessionId: stem,
		stem,
		active: true,
		isStreaming: false,
		timestamp: "2026-01-01T00:00:00Z",
		lastActivityAt,
	};
}

describe("sortByLastActivity", () => {
	it("orders newest activity first", () => {
		const out = sortByLastActivity([
			row("a", "2026-01-01T00:00:01Z"),
			row("b", "2026-01-01T00:00:03Z"),
			row("c", "2026-01-01T00:00:02Z"),
		]);
		expect(out.map((r) => r.stem)).toEqual(["b", "c", "a"]);
	});

	it("sorts rows without a parseable activity last, stably", () => {
		const out = sortByLastActivity([row("none"), row("invalid", "not-a-date"), row("a", "2026-01-01T00:00:01Z")]);
		expect(out.map((r) => r.stem)).toEqual(["a", "none", "invalid"]);
	});

	it("does not mutate the input", () => {
		const input = [row("a", "2026-01-01T00:00:01Z"), row("b", "2026-01-01T00:00:02Z")];
		sortByLastActivity(input);
		expect(input.map((r) => r.stem)).toEqual(["a", "b"]);
	});
});

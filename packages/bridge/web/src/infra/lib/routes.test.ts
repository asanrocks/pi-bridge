// routes unit tests — the URL ⇄ address projection (ADR 11). Pure functions
// only; writeRoute touches window and is covered by the app's behavior.

import { describe, expect, it } from "vitest";
import { launcherPath, parseRoute, projectPath, sessionPath } from "./routes.ts";

describe("parseRoute", () => {
	it("parses /, project, and session routes", () => {
		expect(parseRoute("/")).toEqual({ kind: "launcher" });
		expect(parseRoute("/myproj")).toEqual({ kind: "project", projectId: "myproj" });
		expect(parseRoute("/myproj/stem")).toEqual({ kind: "session", projectId: "myproj", stem: "stem" });
		// The stem is the whole remainder — nested stems keep their slashes.
		expect(parseRoute("/myproj/2026-01-01/a-b_c")).toEqual({
			kind: "session",
			projectId: "myproj",
			stem: "2026-01-01/a-b_c",
		});
	});

	it("percent-decodes each segment once", () => {
		expect(parseRoute("/my%20proj")).toEqual({ kind: "project", projectId: "my proj" });
		// A stem containing a literal %2F round-trips as %252F: one decode.
		expect(parseRoute("/myproj/a%252Fb")).toEqual({ kind: "session", projectId: "myproj", stem: "a%2Fb" });
	});

	it("falls back to the launcher on malformed encoding and empty paths", () => {
		expect(parseRoute("/%")).toEqual({ kind: "launcher" });
		expect(parseRoute("///")).toEqual({ kind: "launcher" });
	});

	it("round-trips through the path builders", () => {
		expect(parseRoute(projectPath("my proj"))).toEqual({ kind: "project", projectId: "my proj" });
		expect(parseRoute(sessionPath("myproj", "a/b c"))).toEqual({
			kind: "session",
			projectId: "myproj",
			stem: "a/b c",
		});
		expect(launcherPath()).toBe("/");
	});
});

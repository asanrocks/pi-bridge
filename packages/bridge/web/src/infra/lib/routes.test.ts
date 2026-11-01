// routes unit tests — the URL ⇄ address projection (ADR 11). Pure functions
// only; writeRoute touches window and is covered by the app's behavior.

import { describe, expect, it } from "vitest";
import { aliasPath, launcherPath, parseRoute, projectPath, sessionPath } from "./routes.ts";

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

	it("parses the alias namespace (ADR 13)", () => {
		expect(parseRoute("/@latest")).toEqual({ kind: "alias", alias: "latest", projectId: null });
		// %40 decodes to @ — one decode, like any segment.
		expect(parseRoute("/%40latest")).toEqual({ kind: "alias", alias: "latest", projectId: null });
		// Aliases are a whole segment; a @ segment can never be a Project id.
		expect(parseRoute("/@latest/stem")).toEqual({ kind: "launcher" });
		// Alias names follow the Project-id charset (minus the sigil).
		expect(parseRoute("/@BAD")).toEqual({ kind: "launcher" });
		expect(parseRoute("/@")).toEqual({ kind: "launcher" });
		expect(parseRoute(aliasPath("latest"))).toEqual({ kind: "alias", alias: "latest", projectId: null });
		expect(aliasPath("latest")).toBe("/@latest");
	});

	it("scopes an alias by its position (ADR 13)", () => {
		// A Project's last segment names that Project's latest, not a stem.
		expect(parseRoute("/spiral/@latest")).toEqual({ kind: "alias", alias: "latest", projectId: "spiral" });
		expect(parseRoute("/spiral/%40latest")).toEqual({ kind: "alias", alias: "latest", projectId: "spiral" });
		expect(aliasPath("latest", "spiral")).toBe("/spiral/@latest");
		expect(parseRoute(aliasPath("latest", "my proj"))).toEqual({
			kind: "alias",
			alias: "latest",
			projectId: "my proj",
		});
		// An alias is a terminal segment: nothing follows it.
		expect(parseRoute("/spiral/@latest/stem")).toEqual({
			kind: "session",
			projectId: "spiral",
			stem: "@latest/stem",
		});
		// Only the scoped position is reserved; deeper @ segments stay stems.
		expect(parseRoute("/spiral/a/@b")).toEqual({ kind: "session", projectId: "spiral", stem: "a/@b" });
		expect(parseRoute("/spiral/@BAD")).toEqual({ kind: "launcher" });
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

// formatGroupSummary — git segment ordering and formatting (ADR 10 v2).
// Lives under web/ (not test/suite/) because it imports the web feature
// module directly; type-checked by check:bridge-web.

import { describe, expect, it } from "vitest";
import { formatGroupSummary, type StepSummaryItem } from "./formatGroupSummary.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "fedcba9876543210fedcba9876543210fedcba98";

const step = (toolName: string, basename: string | null = null): StepSummaryItem => ({ toolName, basename });

describe("formatGroupSummary — git segment", () => {
	it("places git before every tool category", () => {
		const items = [step("edit", "foo.ts"), step("bash"), step("read", "a.ts")];
		const label = formatGroupSummary(items, [{ commit: SHA, branch: "main" }]);
		expect(label).toBe("git: 01234567 · edit: foo.ts · run 1 tool · read 1 file");
	});

	it("git-only group still renders a label", () => {
		expect(formatGroupSummary([], [{ commit: SHA, branch: null }])).toBe("git: 01234567");
	});

	it("dedupes repeated identities and truncates at two hashes", () => {
		const marks = [
			{ commit: SHA, branch: "main" },
			{ commit: SHA, branch: "main" }, // dedup
			{ commit: SHA_B, branch: "main" },
			{ commit: "a".repeat(40), branch: "dev" },
		];
		expect(formatGroupSummary([], marks)).toBe("git: 01234567, fedcba98, +1");
	});

	it("unborn HEAD shows the branch; fully unknown shows ?", () => {
		expect(formatGroupSummary([], [{ commit: null, branch: "main" }])).toBe("git: main");
		expect(formatGroupSummary([], [{ commit: null, branch: null }])).toBe("git: ?");
	});

	it("no marks keeps the legacy label", () => {
		expect(formatGroupSummary([step("edit", "foo.ts")])).toBe("edit: foo.ts");
	});
});

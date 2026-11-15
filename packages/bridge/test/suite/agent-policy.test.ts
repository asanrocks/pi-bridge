// ============================================================================
// agent-policy — the role brief Codex gives each Session in a tree, as text.
// A full fork carries the inherited-history boundary Codex appends; a fresh
// child does not, because there is no inherited branch to disclaim.
// ============================================================================

import { describe, expect, it } from "vitest";
import { rootAgentPolicy, subAgentPolicy } from "../../src/host/agent-policy.ts";

describe("subAgentPolicy", () => {
	it("names the envelope, the tree, and where the final answer goes", () => {
		const brief = subAgentPolicy(4);
		expect(brief).toContain("NEW_TASK` envelope");
		expect(brief).toContain("canonical task name");
		expect(brief).toContain("delivered to your parent agent automatically");
		expect(brief).toContain("Up to 4 agents can be active at once");
	});

	it("adds the inherited-history boundary only for a full fork", () => {
		expect(subAgentPolicy(4)).not.toContain("inherited parent context");
		const forked = subAgentPolicy(4, true);
		expect(forked).toContain("The preceding conversation is inherited parent context");
		expect(forked).toContain("belong to your ancestors");
		expect(forked).toContain("Inherited tool calls are historical records");
	});
});

describe("rootAgentPolicy", () => {
	it("carries the explicit-request-only delegation rule and the wait guidance", () => {
		const brief = rootAgentPolicy(4);
		expect(brief).toContain("You are `/root`");
		expect(brief).toContain("Do not spawn sub-agents unless");
		expect(brief).toContain("prefer longer waits (minutes)");
	});
});

// AgentToolCardBody — SSR tests for the agent-control card bodies. The
// regression this guards is the fallback card the six tools used to get: a
// labelled argument grid plus the tool's raw JSON result. The body must state
// the call in readable fields and fold the child's answers, never print the
// envelope object.
//
// SSR runs no effects; Markdown is mocked to its text so the assertions are
// about what the body chose to render, not about streamdown.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { AgentReplyVM, ToolActionVM } from "../../../../../src/viewmodel/index.ts";
import type { ActionDetailsProps, AgentSpawnView } from "./args.ts";

vi.mock("../../../render/markdown.tsx", () => ({
	Markdown: ({ text }: { text: string }) => createElement("div", null, text),
}));

const { AgentToolCardBody } = await import("./AgentToolCardBody.tsx");

function render(
	toolName: string,
	args: ActionDetailsProps["args"],
	resultText: string | null = null,
	agentReplies?: readonly AgentReplyVM[],
	agentSpawn?: AgentSpawnView,
): string {
	const action = { toolName, ...(agentReplies === undefined ? {} : { agentReplies }) } as ToolActionVM;
	return renderToStaticMarkup(
		createElement(AgentToolCardBody, {
			action,
			args,
			resultText,
			resultImages: [],
			...(agentSpawn === undefined ? {} : { agentSpawn }),
		}),
	);
}

const child = (activity: boolean): AgentSpawnView => ({
	child: {
		projectId: "p1",
		sessionId: "s1",
		stem: "root/scout",
		location: "archive",
		timestamp: "2026-11-14T00:00:00.000Z",
		...(activity ? { activity: { kind: "responding" as const } } : {}),
	},
	open: () => {},
});

describe("AgentToolCardBody", () => {
	test("spawn states the task and the spawned path, and folds the answer as a row", () => {
		const html = render(
			"spawn_agent",
			{ task_name: "scout", message: "look at the parser", fork_turns: "none", model: "gpt-6-luna" },
			JSON.stringify({ task_name: "/root/scout" }),
			[{ entryId: "m1", sender: "/root/scout", text: "found the bug" }],
		);
		expect(html).toContain("look at the parser");
		expect(html).toContain("/root/scout");
		expect(html).toContain("/root/scout · Final answer");
		// The answer is a folded row, like a tool card: closed until asked for.
		expect(html).not.toContain("found the bug");
		expect(html).toContain("Expand agent message");
		expect(html).toContain("fork: none");
		expect(html).toContain("model: gpt-6-luna");
		// The tool's JSON result must not leak into the card.
		expect(html).not.toContain("task_name&quot;");
		expect(html).not.toContain('"task_name"');
	});

	test("send_message renders the recipient and the message, not the envelope", () => {
		const html = render("send_message", { target: "/root/scout", message: "status?" }, "");
		expect(html).toContain("/root/scout");
		expect(html).toContain("status?");
		expect(html).not.toContain("submission_id");
	});

	test("wait_agent shows the outcome sentence, not the JSON result", () => {
		const html = render(
			"wait_agent",
			{ timeout_ms: 30000 },
			JSON.stringify({ message: "Wait completed.", timed_out: false }),
		);
		expect(html).toContain("Wait completed.");
		expect(html).not.toContain("timed_out");
		expect(html).not.toContain("{");
	});

	test("interrupt_agent names the observed status", () => {
		const html = render("interrupt_agent", { target: "/root/scout" }, JSON.stringify({ previous_status: "running" }));
		expect(html).toContain("running");
		expect(html).not.toContain("previous_status");
	});

	test("a result this body cannot parse is shown verbatim, not dropped", () => {
		const html = render("wait_agent", {}, "not json at all");
		expect(html).toContain("not json at all");
	});

	test("spawn shows the child's live status and the way to open it", () => {
		const html = render(
			"spawn_agent",
			{ task_name: "scout", message: "look at the parser" },
			JSON.stringify({ task_name: "/root/scout" }),
			undefined,
			child(true),
		);
		expect(html).toContain("running");
		expect(html).toContain("Open agent");
	});

	test("a failed child reply is labelled as a failure, not as an answer", () => {
		const html = render(
			"spawn_agent",
			{ task_name: "scout", message: "look at the parser" },
			JSON.stringify({ task_name: "/root/scout" }),
			[{ entryId: "m1", sender: "/root/scout", text: "no such file", outcome: "errored" }],
			child(false),
		);
		expect(html).toContain("Errored");
		expect(html).toContain("errored");
		expect(html).not.toContain("Final answer");
		expect(html).not.toContain("no such file");
	});

	test("list_agents renders status rows", () => {
		const html = render(
			"list_agents",
			{},
			JSON.stringify({
				agents: [
					{ agent_name: "/root", agent_status: { completed: "done" } },
					{ agent_name: "/root/scout", agent_status: "running" },
				],
			}),
		);
		expect(html).toContain("/root/scout");
		expect(html).toContain("completed");
		expect(html).toContain("running");
		expect(html).not.toContain("agent_status");
	});
});

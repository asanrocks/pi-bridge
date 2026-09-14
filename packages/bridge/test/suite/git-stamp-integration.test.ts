// ADR 10 integration tests: git identity stamps written by the bridge-bundled
// extension, driven through the full Manager + faux-provider stack in a real
// temporary git repository. Failure paths that need a fake process (missing
// binary, timeout, abort) are covered by git-stamp-extension.test.ts.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { Entry } from "../../src/core/index.ts";
import { GIT_STAMP_CUSTOM_TYPE, parseGitStampEntry } from "../../src/core/index.ts";
import type { BridgeHarness } from "./harness.ts";
import { createBridgeHarness } from "./harness.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StampInfo {
	id: string;
	parentId: string | null;
	anchor: string;
	commit: string | null;
	branch: string | null;
}

/** Valid git stamps in the document, ordered by file position (ord). */
function stamps(h: BridgeHarness): StampInfo[] {
	return Object.values(h.manager.document.entries)
		.filter((e) => e.kind === "custom" && e.customType === GIT_STAMP_CUSTOM_TYPE)
		.sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0))
		.map((e) => {
			const s = parseGitStampEntry(e);
			if (!s) throw new Error("stamp in document failed to parse");
			return { id: e.id, parentId: e.parentId, anchor: s.anchor, commit: s.commit, branch: s.branch };
		});
}

function userMessageEntry(h: BridgeHarness, text: string): Entry {
	const found = Object.values(h.manager.document.entries).find(
		(e) => e.kind === "message" && e.role === "user" && e.content.some((c) => c.type === "text" && c.text === text),
	);
	if (!found) throw new Error(`user message not found: ${text}`);
	return found;
}

/** Custom tool that commits in the harness repo — wired to h.git per test. */
let toolGit: (...args: string[]) => Promise<string> = async () => "";
const commitTool: ToolDefinition = {
	name: "git-commit",
	label: "Git Commit",
	description: "Create an empty commit in the test repository.",
	parameters: Type.Object({}),
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		await toolGit("commit", "--allow-empty", "-q", "-m", `agent commit in ${ctx.cwd}`);
		return { content: [{ type: "text", text: "committed" }], details: {} };
	},
};

async function commit(h: BridgeHarness, message: string): Promise<string> {
	await h.git("commit", "--allow-empty", "-q", "-m", message);
	return h.git("rev-parse", "HEAD");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("git identity stamps (integration)", () => {
	const harnesses: BridgeHarness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("first prompt writes one baseline stamp, parented before the user message", async () => {
		const h = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("ok")],
			gitStamps: true,
			initGitRepo: true,
		});
		harnesses.push(h);
		const head = await h.git("rev-parse", "HEAD");

		await h.manager.prompt("stamp me");

		const s = stamps(h);
		expect(s).toHaveLength(1);
		expect(s[0]).toMatchObject({ anchor: "prompt", commit: head, branch: "main" });
		// The stamp is appended during the awaited message_start handler, so
		// the user message parents onto it.
		expect(userMessageEntry(h, "stamp me").parentId).toBe(s[0]!.id);
	});

	it("stamp append patches precede the user message append", async () => {
		const h = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("ok")],
			gitStamps: true,
			initGitRepo: true,
		});
		harnesses.push(h);

		await h.manager.prompt("patch order");

		const user = userMessageEntry(h, "patch order");
		const stamp = stamps(h)[0]!;
		// Index of the first patch whose ops mention the entry id. The wire may
		// compact single-append patches, so match on serialized content.
		const patchIndexOf = (id: string) =>
			h.patches.findIndex((p) =>
				p.ops.some((op) => (op.op === "append" || op.op === "add") && JSON.stringify(op).includes(`"${id}"`)),
			);
		expect(patchIndexOf(user.id)).toBeGreaterThanOrEqual(0);
		expect(patchIndexOf(stamp.id)).toBeGreaterThanOrEqual(0);
		expect(patchIndexOf(stamp.id)).toBeLessThan(patchIndexOf(user.id));
	});

	it("unchanged identity writes no further stamps across prompts and turn ends", async () => {
		const h = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")],
			gitStamps: true,
			initGitRepo: true,
		});
		harnesses.push(h);

		await h.manager.prompt("first");
		await h.manager.prompt("second");
		await h.manager.prompt("third");

		expect(stamps(h)).toHaveLength(1);
	});

	it("a commit between turns produces a prompt-anchored transition", async () => {
		const h = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("one"), fauxAssistantMessage("two")],
			gitStamps: true,
			initGitRepo: true,
		});
		harnesses.push(h);

		await h.manager.prompt("before commit");
		const head2 = await commit(h, "between turns");
		await h.manager.prompt("after commit");

		const s = stamps(h);
		expect(s).toHaveLength(2);
		expect(s[1]).toMatchObject({ anchor: "prompt", commit: head2, branch: "main" });
	});

	it("an agent tool that commits produces a turn_end transition", async () => {
		const h = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [
				fauxAssistantMessage(fauxToolCall("git-commit", {}), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("committed"),
			],
			customTools: [commitTool],
			gitStamps: true,
			initGitRepo: true,
		});
		harnesses.push(h);
		toolGit = h.git;
		const head1 = await h.git("rev-parse", "HEAD");

		await h.manager.prompt("commit for me");

		const s = stamps(h);
		expect(s).toHaveLength(2);
		expect(s[0]).toMatchObject({ anchor: "prompt", commit: head1 });
		expect(s[1]).toMatchObject({ anchor: "turn_end", commit: await h.git("rev-parse", "HEAD") });
	});

	it("two separate committing turns produce two transitions", async () => {
		const h = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")],
			gitStamps: true,
			initGitRepo: true,
		});
		harnesses.push(h);

		await h.manager.prompt("t1");
		await commit(h, "c1");
		await h.manager.prompt("t2");
		await commit(h, "c2");
		await h.manager.prompt("t3");

		const s = stamps(h);
		expect(s).toHaveLength(3);
		expect(s.map((x) => x.anchor)).toEqual(["prompt", "prompt", "prompt"]);
	});

	it("forking from an earlier entry uses that path's baseline, not the abandoned one", async () => {
		const h = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")],
			gitStamps: true,
			initGitRepo: true,
		});
		harnesses.push(h);

		await h.manager.prompt("root turn");
		const head2 = await commit(h, "advance main");
		await h.manager.prompt("second turn");
		// The fork path's last stamp is the first prompt's (head1), so the
		// unchanged head2 is still a transition relative to that path.
		await h.manager.navigate(userMessageEntry(h, "root turn").id);
		await h.manager.prompt("forked turn");

		const s = stamps(h);
		expect(s).toHaveLength(3);
		expect(s[2]).toMatchObject({ anchor: "prompt", commit: head2 });
		// The forked stamp's parent chain must not include the abandoned branch.
		expect(s[2]!.parentId).toBe(userMessageEntry(h, "root turn").id);
		expect(userMessageEntry(h, "forked turn").parentId).toBe(s[2]!.id);
	});

	it("a non-git working directory stays silent", async () => {
		const h = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("one"), fauxAssistantMessage("two")],
			gitStamps: true,
		});
		harnesses.push(h);

		await h.manager.prompt("no repo here");
		await h.manager.prompt("still no repo");

		expect(stamps(h)).toHaveLength(0);
		expect(userMessageEntry(h, "no repo here").kind).toBe("message");
	});

	it("a repository created mid-session establishes a baseline on the next prompt", async () => {
		const h = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("one"), fauxAssistantMessage("two")],
			gitStamps: true,
		});
		harnesses.push(h);

		await h.manager.prompt("before git init");
		expect(stamps(h)).toHaveLength(0);

		await h.git("init", "-q", "-b", "main");
		await h.git("config", "user.email", "bridge@test");
		await h.git("config", "user.name", "Bridge Test");
		await h.git("commit", "--allow-empty", "-q", "-m", "initial");
		const head = await h.git("rev-parse", "HEAD");

		await h.manager.prompt("after git init");
		const s = stamps(h);
		expect(s).toHaveLength(1);
		expect(s[0]).toMatchObject({ anchor: "prompt", commit: head, branch: "main" });
	});

	it("a detached HEAD is recorded with a null branch", async () => {
		const h = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("one"), fauxAssistantMessage("two")],
			gitStamps: true,
			initGitRepo: true,
		});
		harnesses.push(h);

		await h.manager.prompt("attached");
		const head = await h.git("rev-parse", "HEAD");
		await h.git("checkout", "-q", "--detach");
		await h.manager.prompt("detached");

		const s = stamps(h);
		expect(s).toHaveLength(2);
		expect(s[1]).toMatchObject({ anchor: "prompt", commit: head, branch: null });
	});
});

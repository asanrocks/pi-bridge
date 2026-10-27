import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * The identity contract a mirroring consumer relies on: an entry's persisted id
 * is public before the entry can be observed, persistence consumes that id, and
 * the entry list can be read incrementally with the leaf it selects.
 */
describe("stable entry identity", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps one id across message lifecycle, persistence, and reopen", async () => {
		const fileManager = SessionManager.create(process.cwd());
		const sessionFile = fileManager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");
		const harness = await createHarness({ sessionManager: fileManager });
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		harness.setResponses([fauxAssistantMessage("hello")]);
		await harness.session.prompt("hi");

		const persistedRoles = new Set(["user", "assistant", "toolResult", "system"]);
		const starts = harness.eventsOfType("message_start").filter((event) => persistedRoles.has(event.message.role));
		const ends = harness.eventsOfType("message_end").filter((event) => persistedRoles.has(event.message.role));

		for (const start of starts) expect(start.entryId, `${start.message.role} start`).toBeTruthy();
		for (const end of ends) expect(end.entryId, `${end.message.role} end`).toBeTruthy();

		// The id a message started under is the id it persisted under.
		expect(ends.map((event) => event.entryId)).toEqual(starts.map((event) => event.entryId));
		expect(new Set(ends.map((event) => event.entryId)).size).toBe(ends.length);

		// Every announced id names a persisted entry.
		const entries = harness.sessionManager.getEntries();
		const persisted = new Set(entries.map((entry) => entry.id));
		for (const id of ends.map((event) => event.entryId)) expect(persisted.has(id as string)).toBe(true);

		// A reopen reads the same ids back.
		const reopened = SessionManager.open(sessionFile);
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
	});

	it("identifies parallel tool results independently of their tool-call ids", async () => {
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "echo",
						label: "echo",
						description: "Echo text.",
						parameters: Type.Object({ text: Type.String() }),
						execute: async (_id, { text }) => ({
							content: [{ type: "text", text: `echo: ${text}` }],
							details: {},
						}),
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { text: "a" }, { id: "call-a" }),
					fauxToolCall("echo", { text: "b" }, { id: "call-b" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run both");

		// The result entry is reserved at tool start, so partial output is
		// addressable before the result message exists.
		const toolStarts = harness.eventsOfType("tool_execution_start");
		const ids = toolStarts.map((event) => event.entryId);
		expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
		expect(new Set(ids).size).toBe(2);
		expect(ids).not.toContain("call-a");
		expect(ids).not.toContain("call-b");

		const resultStarts = harness.eventsOfType("message_start").filter((event) => event.message.role === "toolResult");
		expect(resultStarts.map((event) => event.entryId).sort()).toEqual([...ids].sort());
	});

	it("appends under a reserved id and never hands that id out twice", () => {
		const manager = SessionManager.inMemory();
		const reserved = manager.reserveEntryId();
		const message = { role: "user", content: "hello", timestamp: 0 } as never;
		expect(manager.appendMessage(message, reserved)).toBe(reserved);
		expect(manager.getEntry(reserved)?.type).toBe("message");

		const released = manager.reserveEntryId();
		manager.releaseEntryId(released);
		expect(manager.getEntry(released)).toBeUndefined();
		expect(() => manager.releaseEntryId(reserved)).toThrow(/already persisted/);

		// A fresh append never reuses a live reservation.
		const pending = manager.reserveEntryId();
		expect(manager.appendMessage(message)).not.toBe(pending);
	});
});

describe("incremental entry reads", () => {
	it("returns the appended suffix, its next position, and the selected leaf", () => {
		const manager = SessionManager.inMemory();
		const first = manager.appendMessage({ role: "user", content: "one", timestamp: 0 } as never);

		const initial = manager.readEntries(0);
		expect(initial.entries.map((entry) => entry.id)).toEqual([first]);
		expect(initial.next).toBe(1);
		expect(initial.leafId).toBe(first);

		// Reading from the returned position yields only what was appended since.
		const second = manager.appendMessage({ role: "assistant", content: [], timestamp: 0 } as never);
		const delta = manager.readEntries(initial.next);
		expect(delta.entries.map((entry) => entry.id)).toEqual([second]);
		expect(delta.next).toBe(2);
		expect(delta.leafId).toBe(second);

		expect(manager.readEntries(delta.next)).toMatchObject({ entries: [], next: 2 });
	});

	it("reports a leaf change that appends nothing", () => {
		const manager = SessionManager.inMemory();
		const first = manager.appendMessage({ role: "user", content: "one", timestamp: 0 } as never);
		manager.appendMessage({ role: "assistant", content: [], timestamp: 0 } as never);
		const position = manager.readEntries(0).next;

		manager.branch(first);
		const after = manager.readEntries(position);
		expect(after.entries).toEqual([]);
		expect(after.leafId).toBe(first);
	});

	it("changes its version when the entry list is replaced wholesale", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "one", timestamp: 0 } as never);
		const before = manager.readEntries(0);
		manager.newSession();
		const after = manager.readEntries(0);
		expect(after.version).not.toBe(before.version);
		expect(after.entries).toEqual([]);
	});
});

import { describe, expect, it } from "vitest";
import { Dictation } from "../../src/dictation/control.ts";
import { DictationEdit } from "../../src/edit/dictation.ts";
import { StringEditHost } from "../../src/edit/string-host.ts";

describe("StringEditHost", () => {
	it("writes the pre-edit into the store and leaves the caret after it", () => {
		const states: { text: string; caret: number }[] = [];
		const host = new StringEditHost({ text: "前缀：", caret: 3 }, { onChange: (s) => states.push(s) });
		const edit = new DictationEdit(host);

		edit.begin(host.caret);
		edit.update("你好");

		expect(host.read()).toEqual({ text: "前缀：你好", caret: 5 });
		expect(states.at(-1)).toEqual({ text: "前缀：你好", caret: 5 });
	});

	it("commits in place and leaves the caret after the utterance", () => {
		const host = new StringEditHost({ text: "前缀：", caret: 3 });
		const edit = new DictationEdit(host);

		edit.begin(host.caret);
		edit.update("你好，我是豆");
		edit.commit("你好，我是豆包输入法");

		expect(host.text).toBe("前缀：你好，我是豆包输入法");
		expect(host.caret).toBe(3 + "你好，我是豆包输入法".length);
	});

	it("moves the caret back to where the removed text started on cancel", () => {
		const host = new StringEditHost({ text: "前缀：", caret: 3 });
		const edit = new DictationEdit(host);

		edit.begin(host.caret);
		edit.update("你好");
		edit.cancel();

		expect(host.text).toBe("前缀：");
		expect(host.caret).toBe(3);
	});

	it("drops the dictation when the user typed behind its back", () => {
		const host = new StringEditHost({ text: "前缀：", caret: 3 });
		const edit = new DictationEdit(host);

		edit.begin(host.caret);
		edit.update("你好");
		// The user edits the store while the dictation is running.
		host.setText("前缀：X", 4);

		expect(edit.update("你好。")).toBe("dropped");
		expect(edit.isActive).toBe(false);
		// The user's text is authoritative: nothing was spliced back.
		expect(host.text).toBe("前缀：X");
	});

	it("reverts the last utterance through the batch it returns", () => {
		const host = new StringEditHost({ text: "", caret: 0 });
		const edit = new DictationEdit(host);

		edit.begin(0);
		edit.update("第一句。");
		edit.commit("第一句。");
		edit.begin(host.caret);
		edit.update("第二句。");
		edit.commit("第二句。");
		expect(host.text).toBe("第一句。第二句。");

		const revert = edit.revertLast();
		expect(revert).not.toBeNull();
		if (revert !== null) host.apply(revert);
		expect(host.text).toBe("第一句。");
	});

	it("needs no caret option: the orchestrator reads it from read()", () => {
		// The whole point of shipping this host: `Dictation` accepts it as-is, so a
		// store-backed consumer passes text and a setter, not a strategy.
		const host = new StringEditHost({ text: "前缀：", caret: 3 });
		const dictation = new Dictation({ session: { wire: "json", auth: { token: "stub" } }, host });
		expect(dictation.phase).toEqual({ kind: "idle" });
	});
});

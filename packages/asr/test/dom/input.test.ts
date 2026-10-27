/// <reference lib="dom" />

import { beforeEach, describe, expect, it } from "vitest";
import type { TextTarget } from "../../src/dom/attach.ts";
import { attachInput } from "../../src/dom/input.ts";
import { DictationEdit } from "../../src/edit/dictation.ts";
import { FakeTextField } from "../helpers/fake-element.ts";

interface Logged {
	type: string;
	inputType?: string;
	isComposing?: boolean;
	data?: string;
}

function record(field: FakeTextField): { events: Logged[]; stop: () => void } {
	const events: Logged[] = [];
	const listener = (event: Event): void => {
		if (event.type === "input") {
			const input = event as InputEvent;
			events.push({
				type: "input",
				inputType: input.inputType,
				isComposing: input.isComposing,
				data: input.data ?? "",
			});
			return;
		}
		events.push({ type: event.type, data: (event as CompositionEvent).data });
	};
	for (const type of ["compositionstart", "compositionupdate", "compositionend", "input"]) {
		field.addEventListener(type, listener);
	}
	return {
		events,
		stop: () => {
			for (const type of ["compositionstart", "compositionupdate", "compositionend", "input"]) {
				field.removeEventListener(type, listener);
			}
		},
	};
}

describe("attachInput", () => {
	let field: FakeTextField;

	beforeEach(() => {
		field = new FakeTextField("前缀：");
		field.setSelectionRange(3, 3);
	});

	it("reports text and caret so the caller can begin there", () => {
		const target = attachInput(field.element);
		expect(target.read()).toEqual({ text: "前缀：", caret: 3 });
		target.detach();
	});

	it("writes the pre-edit at the caret and announces it as composition", () => {
		const target = attachInput(field.element);
		const edit = new DictationEdit(target);
		const log = record(field);

		edit.begin(target.read().caret);
		edit.update("你好");

		expect(field.value).toBe("前缀：你好");
		expect(log.events).toEqual([
			{ type: "compositionstart", data: "" },
			{ type: "input", inputType: "insertCompositionText", isComposing: true, data: "你好" },
			{ type: "compositionupdate", data: "你好" },
		]);
		log.stop();
		target.detach();
	});

	it("rewrites only the changed middle when the server revises", () => {
		const target = attachInput(field.element);
		const edit = new DictationEdit(target);
		edit.begin(target.read().caret);
		edit.update("你好，我是豆");
		edit.update("你好，我是豆包输入法");
		edit.update("你好，我是豆包，输入");

		expect(field.value).toBe("前缀：你好，我是豆包，输入");
		target.detach();
	});

	it("leaves the caret after the dictation, not in front of it", () => {
		const target = attachInput(field.element);
		const edit = new DictationEdit(target);
		edit.begin(target.read().caret);
		edit.update("你好");
		expect(field.selectionStart).toBe(5);
		target.detach();
	});

	it("closes the composition at commit without re-inserting the text", () => {
		const target = attachInput(field.element);
		const edit = new DictationEdit(target);
		const log = record(field);

		edit.begin(target.read().caret);
		edit.update("你好。");
		log.events.length = 0;
		edit.commit("你好。");

		expect(field.value).toBe("前缀：你好。");
		expect(log.events).toEqual([
			{ type: "compositionend", data: "你好。" },
			{ type: "input", inputType: "insertText", isComposing: false, data: "你好。" },
		]);
		log.stop();
		target.detach();
	});

	it("keeps compositionend before the native input when the browser has a command", () => {
		// Without `execCommand` the commit is our own `input` event; with it, the
		// event comes from the command itself and must still arrive after
		// `compositionend`. Both branches are covered here, so "unsupported" is an
		// outcome the tests choose rather than one they happen to get.
		field.enableNativeUndo();
		const target = attachInput(field.element);
		const edit = new DictationEdit(target);
		const log = record(field);

		edit.begin(target.read().caret);
		edit.update("你好。");
		log.events.length = 0;
		edit.commit("你好。");

		expect(field.value).toBe("前缀：你好。");
		expect(log.events.map((event) => event.type)).toEqual(["compositionend", "input"]);
		expect(log.events.filter((event) => event.type === "input")).toHaveLength(1);

		log.stop();
		target.detach();
	});

	it("makes one native undo remove the whole utterance, not restore the pre-edit", () => {
		// A faithful stand-in for the browser: a command records the range it
		// replaced, and undo puts that text back. Replacing the pre-edit with itself
		// therefore undoes to the same text — the dead Ctrl+Z this test exists for.
		field.enableNativeUndo();
		const target = attachInput(field.element);
		const edit = new DictationEdit(target);

		edit.begin(target.read().caret);
		edit.update("你好。");
		edit.commit("你好。");

		expect(field.value).toBe("前缀：你好。");
		// One command for the whole utterance; the pre-edits went in around it.
		expect(field.commands).toHaveLength(1);
		const step = field.commands[0];
		expect(step?.removed).toBe("");

		if (step !== undefined) {
			field.setRangeText(step.removed, step.start, step.start + "你好。".length, "end");
		}
		expect(field.value).toBe("前缀：");
		target.detach();
	});

	it("removes the pre-edit on cancel and reports the deletion", () => {
		const target = attachInput(field.element);
		const edit = new DictationEdit(target);
		const log = record(field);

		edit.begin(target.read().caret);
		edit.update("你好");
		log.events.length = 0;
		edit.cancel();

		expect(field.value).toBe("前缀：");
		expect(log.events).toEqual([
			{ type: "input", inputType: "deleteCompositionText", isComposing: false, data: "" },
			{ type: "compositionend", data: "" },
		]);
		log.stop();
		target.detach();
	});

	it("an empty terminal message behaves like cancel and leaves no residue", () => {
		const target = attachInput(field.element);
		const edit = new DictationEdit(target);
		edit.begin(target.read().caret);
		edit.update("你好");
		edit.commit("");
		expect(field.value).toBe("前缀：");
		expect(edit.isActive).toBe(false);
		target.detach();
	});

	it("reports a page edit made behind our back", () => {
		let external = 0;
		const target = attachInput(field.element, {
			onExternalEdit: () => {
				external += 1;
			},
		});
		const edit = new DictationEdit(target);
		edit.begin(target.read().caret);
		edit.update("你好");

		// The user types into the field while the dictation is running.
		field.setRangeText("X", 0, 0, "end");
		field.dispatchEvent(new Event("input", { bubbles: true }));
		expect(external).toBe(1);
		target.detach();
	});

	it("does not report its own events as external", () => {
		let external = 0;
		const target = attachInput(field.element, {
			onExternalEdit: () => {
				external += 1;
			},
		});
		const edit = new DictationEdit(target);
		edit.begin(target.read().caret);
		edit.update("你好");
		edit.update("你好。");
		edit.commit("你好。");
		expect(external).toBe(0);
		target.detach();
	});

	it("stops listening after detach", () => {
		let external = 0;
		const target = attachInput(field.element, {
			onExternalEdit: () => {
				external += 1;
			},
		});
		target.detach();
		field.dispatchEvent(new Event("input", { bubbles: true }));
		expect(external).toBe(0);
	});

	it("keeps two dictations independent and undoable through revertLast", () => {
		const target: TextTarget = attachInput(field.element);
		const edit = new DictationEdit(target);

		edit.begin(target.read().caret);
		edit.update("第一句。");
		edit.commit("第一句。");

		edit.begin(target.read().caret);
		edit.update("第二句。");
		edit.commit("第二句。");
		expect(field.value).toBe("前缀：第一句。第二句。");

		const revert = edit.revertLast();
		expect(revert).not.toBeNull();
		if (revert !== null) target.apply(revert);
		expect(field.value).toBe("前缀：第一句。");
		target.detach();
	});
});

describe("attachInput on a locked field", () => {
	// A host locks the field while an utterance runs so nothing is typed into the
	// span the dictation owns. The commit still has to join the undo stack, which
	// a browser only allows on a writable field.

	function lockedField(value = "前缀："): FakeTextField {
		const locked = new FakeTextField(value);
		locked.setSelectionRange(value.length, value.length);
		locked.enableNativeUndo();
		locked.readOnly = true;
		return locked;
	}

	it("commits through the native command and restores the lock", () => {
		const locked = lockedField();
		// Observe the state the command actually sees.
		let lockedDuringCommand: boolean | undefined;
		const command = locked.ownerDocument.execCommand;
		locked.ownerDocument.execCommand = (name, showUI, value) => {
			lockedDuringCommand = locked.readOnly;
			return command?.(name, showUI, value) ?? false;
		};

		const target = attachInput(locked.element);
		const edit = new DictationEdit(target);
		edit.begin(target.read().caret);
		edit.update("你好。");
		edit.commit("你好。");

		expect(locked.value).toBe("前缀：你好。");
		expect(lockedDuringCommand).toBe(false);
		expect(locked.readOnly).toBe(true);
		expect(locked.commands).toHaveLength(1);

		// One undo restores only what the command replaced, so the surrounding
		// text stays and the utterance goes; redo puts the utterance back.
		const step = locked.commands[0];
		expect(step?.start).toBe(3);
		expect(step?.removed).toBe("");
		if (step !== undefined) {
			locked.setRangeText(step.removed, step.start, step.start + "你好。".length, "end");
		}
		expect(locked.value).toBe("前缀：");
		if (step !== undefined) {
			locked.setRangeText(step.inserted, step.start, step.start + step.removed.length, "end");
		}
		expect(locked.value).toBe("前缀：你好。");
		target.detach();
	});

	it("restores the lock when the command is refused", () => {
		const locked = lockedField();
		locked.ownerDocument.execCommand = () => false;

		const target = attachInput(locked.element);
		const edit = new DictationEdit(target);
		edit.begin(target.read().caret);
		edit.update("你好。");
		edit.commit("你好。");

		// Nothing is lost when the browser cannot record the step, and a refusal
		// does not leave the field writable.
		expect(locked.value).toBe("前缀：你好。");
		expect(locked.readOnly).toBe(true);
		target.detach();
	});

	it("restores the lock when the command throws", () => {
		const locked = lockedField();
		locked.ownerDocument.execCommand = () => {
			throw new Error("detached field");
		};

		const target = attachInput(locked.element);
		const edit = new DictationEdit(target);
		edit.begin(target.read().caret);
		edit.update("你好。");

		expect(() => edit.commit("你好。")).toThrow(/detached field/);
		expect(locked.readOnly).toBe(true);
		target.detach();
	});
});

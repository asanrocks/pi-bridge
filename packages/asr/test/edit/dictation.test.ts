import { describe, expect, it } from "vitest";
import type { EditBatch, EditHost, EditOp } from "../../src/edit/dictation.ts";
import { applyBatch, DictationEdit, diffReplace } from "../../src/edit/dictation.ts";
import { AsrError } from "../../src/errors.ts";

/** A host that behaves like a text field: ops are applied to a plain string. */
class DocumentHost implements EditHost {
	text: string;
	batches: EditBatch[] = [];

	constructor(initial = "") {
		this.text = initial;
	}

	apply(batch: EditBatch): void {
		this.batches.push(batch);
		for (const op of batch.ops) {
			this.text = `${this.text.slice(0, op.start)}${op.text}${this.text.slice(op.end)}`;
		}
	}

	get ops(): EditOp[] {
		return this.batches.flatMap((batch) => batch.ops);
	}

	get kinds(): string[] {
		return this.batches.map((batch) => `${batch.kind}:${String(batch.group)}`);
	}
}

/** The same host, plus the `read` seam that lets the model notice external edits. */
class MirroredHost extends DocumentHost {
	read(): { text: string } {
		return { text: this.text };
	}
}

describe("diffReplace", () => {
	it("returns null for identical text", () => {
		expect(diffReplace("你好", "你好", 0)).toBeNull();
	});

	it("appends only the new tail when the text grew", () => {
		expect(diffReplace("你好", "你好世界", 0)).toEqual({ start: 2, end: 2, text: "世界" });
	});

	it("replaces a re-punctuated middle instead of retyping the sentence", () => {
		expect(diffReplace("你好。我是豆包", "你好，我是豆包", 0)).toEqual({
			start: 2,
			end: 3,
			text: "，",
		});
	});

	it("shrinks by deleting the removed tail", () => {
		expect(diffReplace("你好世界", "你好", 0)).toEqual({ start: 2, end: 4, text: "" });
	});

	it("offsets are absolute, so an insertion mid-document keeps its neighbours", () => {
		expect(diffReplace("世界", "世界啊", 2)).toEqual({ start: 4, end: 4, text: "啊" });
	});

	it("never splits a surrogate pair", () => {
		const smile = "😀";
		const op = diffReplace(`${smile}${smile}`, smile, 0);
		expect(op).toEqual({ start: smile.length, end: smile.length * 2, text: "" });

		const grow = diffReplace(smile, `${smile}${smile}`, 0);
		expect(grow).toEqual({ start: smile.length, end: smile.length, text: smile });
	});
});

describe("DictationEdit", () => {
	it("writes the first partial at the captured offset", () => {
		const host = new DocumentHost("前面");
		const edit = new DictationEdit(host);
		edit.begin(2);
		edit.update("你好");

		expect(host.text).toBe("前面你好");
		expect(edit.preview).toBe("你好");
		expect(host.kinds).toEqual(["preedit:1"]);
	});

	it("replaces the pre-edit wholesale when the server rewrites it", () => {
		const host = new DocumentHost("");
		const edit = new DictationEdit(host);
		edit.begin(0);

		edit.update("你好，我是豆");
		edit.update("你好，我是豆包输入法");
		edit.update("你好，我是豆包，输入");

		expect(host.text).toBe("你好，我是豆包，输入");
		// Only the changed middle is touched; the stable prefix is never rewritten.
		expect(host.ops.at(-1)).toEqual({ start: 7, end: 10, text: "，输入" });
	});

	it("commits once, at the terminal message, as a single undo group", () => {
		const host = new DocumentHost("");
		const edit = new DictationEdit(host);
		edit.begin(0);
		edit.update("你好");
		edit.update("你好，我是豆包输入法。");
		edit.commit("你好，我是豆包输入法。");

		expect(host.text).toBe("你好，我是豆包输入法。");
		expect(host.kinds).toEqual(["preedit:1", "preedit:1", "commit:1"]);
		expect(host.batches.at(-1)?.ops).toEqual([]);
		expect(host.batches.at(-1)?.span).toEqual({ start: 0, end: 11 });
		expect(edit.isActive).toBe(false);
		expect(edit.preview).toBe("");
	});

	it("a finished utterance no longer lets a later pre-edit move under it", () => {
		const host = new DocumentHost("");
		const edit = new DictationEdit(host);
		edit.begin(0);
		edit.update("第一句。");
		edit.commit("第一句。");

		edit.begin(host.text.length);
		edit.update("第二句。");
		expect(host.text).toBe("第一句。第二句。");
		edit.commit("第二句。");

		expect(host.batches.map((batch) => batch.group)).toEqual([1, 1, 2, 2]);
		expect(host.text).toBe("第一句。第二句。");
	});

	it("turns an empty terminal message into a cancellation, not an empty commit", () => {
		const host = new DocumentHost("原有");
		const edit = new DictationEdit(host);
		edit.begin(2);
		edit.update("你好");
		edit.commit("");

		expect(host.text).toBe("原有");
		expect(host.kinds).toEqual(["preedit:1", "cancel:1"]);
		expect(edit.isActive).toBe(false);
	});

	it("cancel removes the pre-edit and leaves the document as it was", () => {
		const host = new DocumentHost("前后");
		const edit = new DictationEdit(host);
		edit.begin(1);
		edit.update("中间");
		edit.cancel();

		expect(host.text).toBe("前后");
		expect(edit.isActive).toBe(false);
	});

	it("revertLast hands back a batch that undoes exactly the last utterance", () => {
		const host = new DocumentHost("");
		const edit = new DictationEdit(host);
		edit.begin(0);
		edit.update("你好。");
		edit.commit("你好。");
		edit.begin(host.text.length);
		edit.update("再见。");
		edit.commit("再见。");
		expect(host.text).toBe("你好。再见。");

		const revert = edit.revertLast();
		expect(revert?.ops).toEqual([{ start: 3, end: 6, text: "" }]);
		if (revert !== null) host.apply(revert);
		expect(host.text).toBe("你好。");

		// The next dictation starts where the removed one did, not at the old end.
		edit.begin(3);
		edit.update("晚上好。");
		edit.commit("晚上好。");
		expect(host.text).toBe("你好。晚上好。");
	});

	it("revertLast returns null once the history is exhausted", () => {
		const host = new DocumentHost("");
		const edit = new DictationEdit(host);
		expect(edit.revertLast()).toBeNull();

		edit.begin(0);
		edit.update("一次。");
		edit.commit("一次。");
		expect(edit.revertLast()).not.toBeNull();
		expect(edit.revertLast()).toBeNull();
	});

	it("rejects misuse instead of writing to an unexpected place", () => {
		const edit = new DictationEdit(new DocumentHost(""));
		expect(() => {
			edit.update("x");
		}).toThrow(AsrError);
		expect(() => {
			edit.commit("x");
		}).toThrow(/no active dictation/);
		expect(() => {
			edit.begin(-1);
		}).toThrow(/invalid offset/);
		edit.begin(0);
		expect(() => {
			edit.begin(0);
		}).toThrow(/already|active/);
	});

	it("stops accepting results once the utterance ended, without throwing", () => {
		const host = new DocumentHost("");
		const edit = new DictationEdit(host);
		edit.begin(0);
		expect(edit.update("你好")).toBe("applied");
		expect(edit.commit("你好。")).toBe("applied");
		// The server keeps sending until the socket closes; a late result is a race.
		expect(edit.update("你好，世界")).toBe("dropped");
		expect(host.text).toBe("你好。");
	});

	it("drops the pre-edit instead of overwriting a document that changed underneath", () => {
		const host = new MirroredHost("前缀：");
		const edit = new DictationEdit(host);
		edit.begin(3);
		edit.update("你好");
		host.text = "前缀：X"; // the user typed inside the span

		expect(edit.update("你好，世界")).toBe("dropped");
		expect(host.text).toBe("前缀：X");
		expect(edit.isActive).toBe(false);
		// The composition is closed, but nothing is removed: the text is the user's.
		expect(host.batches.at(-1)).toMatchObject({ kind: "cancel", ops: [] });
		expect(edit.update("你好，世界")).toBe("dropped");
	});

	it("refuses to commit into a document that changed underneath", () => {
		const host = new MirroredHost("前缀：");
		const edit = new DictationEdit(host);
		edit.begin(3);
		edit.update("你好");
		host.text = "前缀："; // the user cleared the field

		expect(edit.commit("你好。")).toBe("dropped");
		expect(host.text).toBe("前缀：");
		expect(host.batches.at(-1)).toMatchObject({ kind: "cancel", ops: [] });
	});

	it("removes only its own span when the document grew around it", () => {
		const host = new MirroredHost("前缀：");
		const edit = new DictationEdit(host);
		edit.begin(3);
		edit.update("你好");
		host.text = "前缀：你好世界"; // appended after us: our span still matches

		edit.cancel();
		expect(host.text).toBe("前缀：世界");
	});

	it("cancels without deleting when our offsets slid", () => {
		const host = new MirroredHost("前缀：");
		const edit = new DictationEdit(host);
		edit.begin(3);
		edit.update("你好");
		host.text = "前缀：X你好"; // typed before us, so the same offsets now hold other text

		edit.cancel();
		expect(host.text).toBe("前缀：X你好");
		expect(host.batches.at(-1)).toMatchObject({ kind: "cancel", ops: [] });
	});

	it("reverts nothing when the committed span is gone", () => {
		const host = new MirroredHost("前缀：");
		const edit = new DictationEdit(host);
		edit.begin(3);
		edit.update("你好");
		edit.commit("你好。");
		host.text = "前缀："; // someone else deleted it

		expect(edit.revertLast()).toBeNull();
	});

	it("survives a realistic interim stream: shrink, rewrite, then a shorter final", () => {
		const host = new DocumentHost("前缀：");
		const edit = new DictationEdit(host);
		edit.begin(host.text.length);

		for (const partial of [
			"你",
			"你好",
			"你好，我是",
			"你好，我是豆包输入法",
			"你好，我是豆包输入法。",
			// The server can shorten, and can rewrite mid-string.
			"你好，我是豆包",
			"你好，我是豆包输",
		]) {
			edit.update(partial);
			expect(host.text).toBe(`前缀：${partial}`);
		}

		// The terminal text may differ from the last interim in both length and wording.
		edit.commit("你好，豆包输入法。");
		expect(host.text).toBe("前缀：你好，豆包输入法。");
		expect(host.batches.filter((batch) => batch.kind === "commit")).toHaveLength(1);
	});
});

describe("applyBatch", () => {
	it("splices a batch into a plain string, leaving the rest alone", () => {
		const batch: EditBatch = {
			group: 1,
			kind: "preedit",
			span: { start: 3, end: 5 },
			ops: [{ start: 3, end: 5, text: "豆包" }],
		};
		expect(applyBatch("前缀：世界", batch)).toBe("前缀：豆包");
	});

	it("applies a multi-op batch back to front", () => {
		const batch: EditBatch = {
			group: 1,
			kind: "preedit",
			span: { start: 0, end: 2 },
			ops: [
				{ start: 0, end: 1, text: "A" },
				{ start: 1, end: 2, text: "B" },
			],
		};
		expect(applyBatch("xy", batch)).toBe("AB");
	});

	it("is a no-op for a commit, which carries the pre-edit as durable state", () => {
		const batch: EditBatch = {
			group: 1,
			kind: "commit",
			span: { start: 0, end: 2 },
			ops: [],
		};
		expect(applyBatch("你好", batch)).toBe("你好");
	});

	it("agrees with a host that applies every batch itself", () => {
		const host = new DocumentHost("前缀：");
		const edit = new DictationEdit(host);
		edit.begin(host.text.length);
		edit.update("你好");
		edit.update("你好，世界");
		edit.update("你好"); // the server may shrink

		const folded = host.batches.reduce((text, batch) => applyBatch(text, batch), "前缀：");
		expect(folded).toBe(host.text);
	});

	it("rejects an op that does not fit the document instead of splicing garbage", () => {
		const batch: EditBatch = {
			group: 1,
			kind: "preedit",
			span: { start: 10, end: 12 },
			ops: [{ start: 10, end: 12, text: "豆包" }],
		};
		expect(() => applyBatch("短", batch)).toThrow(/does not fit/);
		expect(() => applyBatch("短", batch)).toThrow(AsrError);
	});
});

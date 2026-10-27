// Polishing a draft is a whole-text rewrite, so what the toolbar's undo needs is
// the changed region plus what it replaced. These are the properties that make
// that record safe to keep across the user's later typing.

import { describe, expect, it } from "vitest";
import { changedSpan, installedSpan, isStillApplied, type TextEdit } from "./textPolish.ts";

/** Apply the edit to `text` the way the composer's TextTarget does. */
function install(text: string, edit: TextEdit): string {
	return text.slice(0, edit.span.start) + edit.inserted + text.slice(edit.span.end);
}

/** Undo what `install` produced. */
function restore(text: string, edit: TextEdit): string {
	const installed = installedSpan(edit);
	return text.slice(0, installed.start) + edit.replaced + text.slice(installed.end);
}

describe("changedSpan", () => {
	it("reports nothing when the text is unchanged", () => {
		expect(changedSpan("已经很清楚。", "已经很清楚。")).toBeNull();
	});

	it("keeps the untouched middle out of the span", () => {
		const before = "那个，我们明天下午三点开会吧……";
		const after = "那个，我们明天下午三点开会。";
		const edit = changedSpan(before, after);
		expect(edit).not.toBeNull();
		if (edit === null) return;
		// Only the tail differs; the shared "那个，我们明天下午三点开会" is left as it is,
		// so the undo record does not cover it and later edits there do not disturb
		// the record.
		expect(edit.replaced).toBe("吧……");
		expect(edit.inserted).toBe("。");
		expect(edit.span).toEqual({ start: 13, end: 16 });
	});

	it("covers a rewrite with no common prefix or suffix", () => {
		const edit = changedSpan("一二三", "abc");
		expect(edit).toEqual({ span: { start: 0, end: 3 }, inserted: "abc", replaced: "一二三" });
	});

	it("handles an insertion at the end and at the start", () => {
		expect(changedSpan("草稿", "草稿。")).toEqual({
			span: { start: 2, end: 2 },
			inserted: "。",
			replaced: "",
		});
		expect(changedSpan("草稿", "（补一句）草稿")).toEqual({
			span: { start: 0, end: 0 },
			inserted: "（补一句）",
			replaced: "",
		});
	});

	it("does not let the prefix and suffix scans overlap", () => {
		// "aaa" → "aa": one deletion, not a zero-width edit in the middle.
		const edit = changedSpan("aaa", "aa");
		expect(edit).toEqual({ span: { start: 2, end: 3 }, inserted: "", replaced: "a" });
		expect(install("aaa", edit as TextEdit)).toBe("aa");
	});

	it("never changes text outside the span", () => {
		for (const [before, after] of [
			["一二三四五", "一X四Y五"],
			["短", "长得多的一句话"],
			["longer sentence here", "short"],
			["", "new"],
			["gone", ""],
		] as const) {
			const edit = changedSpan(before, after);
			if (edit === null) throw new Error("expected an edit");
			expect(before.slice(0, edit.span.start)).toBe(after.slice(0, edit.span.start));
			expect(install(before, edit)).toBe(after);
			expect(restore(after, edit)).toBe(before);
		}
	});
});

describe("undo record", () => {
	const before = "我们明天下午三点开会吧";
	const after = "通知：明天15:00开会。";
	const edit = changedSpan(before, after);

	it("restores the replaced text", () => {
		if (edit === null) throw new Error("expected an edit");
		const field = install(before, edit);
		expect(isStillApplied(field, edit)).toBe(true);
		expect(restore(field, edit)).toBe(before);
	});

	it("survives typing after the changed region", () => {
		if (edit === null) throw new Error("expected an edit");
		const field = `${install(before, edit)}\n地点：三楼会议室`;
		expect(isStillApplied(field, edit)).toBe(true);
		expect(restore(field, edit)).toBe(`${before}\n地点：三楼会议室`);
	});

	it("refuses to write once the user edited inside the region", () => {
		if (edit === null) throw new Error("expected an edit");
		const field = install(before, edit).replace("通知", "备注");
		expect(isStillApplied(field, edit)).toBe(false);
	});

	it("refuses a field that no longer holds the edit at all", () => {
		if (edit === null) throw new Error("expected an edit");
		expect(isStillApplied("", edit)).toBe(false);
		expect(isStillApplied(before, edit)).toBe(false);
	});
});

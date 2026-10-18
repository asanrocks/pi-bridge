// RecoveryBar — the broken-tail recovery actions (ADR 16), presentational.
// Tested at the markup level (renderToStaticMarkup, no store): the action
// family per recovery kind is the UI contract — Retry (+ Edit) for the
// silently-recontinuable family, Send "Continue." for terminated tool work —
// plus the per-mode Retry tooltip and the synthetic error-line text.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { RecoveryActions, recoveryNotice, retryTitle } from "./RecoveryBar.tsx";

function render(node: ReturnType<typeof createElement>): string {
	return renderToStaticMarkup(node);
}

describe("RecoveryActions — the error row's action family", () => {
	test("a silently-recontinuable tail offers Retry and Edit", () => {
		const html = render(
			createElement(RecoveryActions, {
				kind: "failedTurn",
				stopReason: "error",
				hasToolWork: false,
				onRecover: () => {},
				onEdit: () => {},
			}),
		);
		expect(html).toContain("Retry");
		expect(html).toContain("Edit");
		expect(html).not.toContain("Continue");
	});

	test("Edit is omitted when the path has no user message to edit", () => {
		const html = render(
			createElement(RecoveryActions, {
				kind: "unfinishedTurn",
				stopReason: "toolUse",
				hasToolWork: true,
				onRecover: () => {},
			}),
		);
		expect(html).toContain("Retry");
		expect(html).not.toContain("Edit");
	});

	test('terminated tool work offers Send "Continue." — the label is the mechanism', () => {
		const html = render(
			createElement(RecoveryActions, {
				kind: "interruptedTools",
				stopReason: "toolUse",
				hasToolWork: true,
				onRecover: () => {},
			}),
		);
		expect(html).toContain("Send &quot;Continue.&quot;");
		expect(html).not.toContain("Retry");
		expect(html).not.toContain("Edit");
	});
});

describe("retryTitle — why Retry is safe, per failure mode", () => {
	test("an unfinished run continues from its completed results", () => {
		expect(retryTitle("unfinishedTurn", "toolUse", true)).toContain("nothing new is added");
	});

	test("an error turn is branched away", () => {
		expect(retryTitle("failedTurn", "error", false)).toContain("failed attempt stays in history");
		expect(retryTitle("failedTurn", "error", true)).toContain("failed attempt stays in history");
	});

	test("a stop over completed tools keeps its results", () => {
		const title = retryTitle("failedTurn", "aborted", true);
		expect(title).toContain("completed tool results");
		expect(title).toContain("no tools re-run");
	});

	test("a text-only stop produced nothing", () => {
		expect(retryTitle("failedTurn", "aborted", false)).toContain("produced nothing");
	});
});

describe("recoveryNotice — the synthetic error line for silent interruptions", () => {
	test("dangling tool calls are named, with their data loss", () => {
		expect(recoveryNotice("interruptedTools")).toContain("Interrupted while running tools");
		expect(recoveryNotice("interruptedTools")).toContain("no recorded result");
	});

	test("an unfinished reply is named", () => {
		expect(recoveryNotice("unfinishedTurn")).toContain("Interrupted before the reply finished");
	});
});

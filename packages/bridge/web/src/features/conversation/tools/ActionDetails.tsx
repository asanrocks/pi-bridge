// ActionDetails — the expanded details renderer for a tool action step.
// Each tool renders as a card: the skeleton zones above (status line,
// identity, error strip — ToolActionStepView) and a body showing the
// meaningful content — diff, code, output, matches. Subscribes to the
// live arguments/result slices (lazy-pulled).

import { type ComponentType, memo, useCallback } from "react";
import type { ImageContent } from "../../../../../src/core/types.ts";
import { stepWants, type ToolActionStepVM } from "../../../../../src/viewmodel/index.ts";
import { useStore } from "../../../infra/store.tsx";
import { wantPull } from "../../../infra/wants.ts";
import styles from "../conversation.module.css";
import type { ActionDetailsProps, ToolArgs } from "./args.ts";
import { BashCardBody } from "./BashCardBody.tsx";
import { EditCardBody } from "./EditCardBody.tsx";
import { FallbackCardBody } from "./FallbackCardBody.tsx";
import { ReadCardBody } from "./ReadCardBody.tsx";
import { SearchResultBody } from "./SearchResultBody.tsx";
import { sanitizeOutputText } from "./sanitize.ts";
import { WriteCardBody } from "./WriteCardBody.tsx";

/**
 * Tool-name → details renderer registry. Adding a tool means dropping a file
 * in tools/ and adding one line here — no dispatcher branching. Every entry
 * shares the uniform ActionDetailsProps, so each body owns its own argument
 * extraction; FallbackCardBody handles anything unregistered.
 */
const TOOL_DETAILS: Record<string, ComponentType<ActionDetailsProps>> = {
	edit: EditCardBody,
	read: ReadCardBody,
	write: WriteCardBody,
	bash: BashCardBody,
	powershell: BashCardBody,
	grep: SearchResultBody,
	find: SearchResultBody,
	ls: SearchResultBody,
};

export const ActionDetails = memo(function ActionDetails({ step }: { step: ToolActionStepVM }) {
	useStore((s) => s.pullTick);
	wantPull(stepWants(step, true));

	const arguments_ = useStore(
		useCallback(
			(s) => {
				const entry = s.document.entries[step.entryId];
				if (!entry || entry.kind !== "message") return step.arguments;
				const block = entry.content[step.blockIndex];
				return block?.type === "toolCall" ? (block.arguments ?? null) : step.arguments;
			},
			[step.entryId, step.blockIndex, step.arguments],
		),
	);
	const resultContent = useStore(
		useCallback(
			(s) => {
				if (!step.result) return null;
				const entry = s.document.entries[step.result.entryId];
				return entry?.kind === "tool_result" ? (entry.content ?? null) : null;
			},
			[step.result],
		),
	);
	const fullResultText = resultContent
		? sanitizeOutputText(resultContent.map((c) => (c.type === "text" && c.text) || "").join("\n"))
		: null;

	const args: ToolArgs | null = arguments_ && typeof arguments_ === "object" ? (arguments_ as ToolArgs) : null;
	// Error text renders in the skeleton's error strip; bodies render result
	// content only on success. Bash is the exception: its error results are
	// command output plus a status line appended by the tool, which belongs
	// in the output area — the strip would duplicate it.
	const bodyOwnsResult = !(step.result?.isError ?? false) || step.toolName === "bash";
	const resultText = bodyOwnsResult ? fullResultText : null;
	const resultImages = bodyOwnsResult
		? (resultContent ?? []).filter((c): c is ImageContent => c.type === "image")
		: [];

	const Body = TOOL_DETAILS[step.toolName] ?? FallbackCardBody;
	return (
		<div className={styles.detailsBody}>
			<Body step={step} args={args} resultText={resultText} resultImages={resultImages} />
		</div>
	);
});

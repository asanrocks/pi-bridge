// ActionDetails — the expanded details renderer for a tool action.
// Each tool renders as a card: the skeleton zones above (status line,
// header, error strip — ToolActionView) and a body showing the
// meaningful content — diff, code, output, matches. Subscribes to the
// live arguments/result slices (lazy-pulled).

import { type ComponentType, memo, useCallback } from "react";
import type { ImageContent } from "../../../../../src/core/types.ts";
import { actionPulls, type ToolActionVM } from "../../../../../src/viewmodel/index.ts";
import { enqueuePulls } from "../../../infra/net/pullQueue.ts";
import { useStore } from "../../../infra/state/store.tsx";
import styles from "../actions.module.css";
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

export const ActionDetails = memo(function ActionDetails({ action }: { action: ToolActionVM }) {
	useStore((s) => s.pullTick);
	enqueuePulls(actionPulls(action, true));

	const arguments_ = useStore(
		useCallback(
			(s) => {
				const entry = s.document.entries[action.entryId];
				if (!entry || entry.kind !== "message") return action.arguments;
				const block = entry.content[action.blockIndex];
				return block?.type === "toolCall" ? (block.arguments ?? null) : action.arguments;
			},
			[action.entryId, action.blockIndex, action.arguments],
		),
	);
	const resultContent = useStore(
		useCallback(
			(s) => {
				if (!action.result) return null;
				const entry = s.document.entries[action.result.entryId];
				return entry?.kind === "tool_result" ? (entry.content ?? null) : null;
			},
			[action.result],
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
	const bodyOwnsResult = !(action.result?.isError ?? false) || action.toolName === "bash";
	const resultText = bodyOwnsResult ? fullResultText : null;
	const resultImages = bodyOwnsResult
		? (resultContent ?? []).filter((c): c is ImageContent => c.type === "image")
		: [];

	const Body = TOOL_DETAILS[action.toolName] ?? FallbackCardBody;
	return (
		<div className={styles.detailsBody}>
			<Body action={action} args={args} resultText={resultText} resultImages={resultImages} />
		</div>
	);
});

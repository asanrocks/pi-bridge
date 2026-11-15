// ActionDetails — the expanded details renderer for a tool action.
// Each tool renders as a card: the skeleton zones above (status line,
// header, error strip — ToolActionView) and a body showing the
// meaningful content — diff, code, output, matches. Subscribes to the
// live arguments/result slices (lazy-pulled).

import { type ComponentType, memo, useCallback, useMemo } from "react";
import { isAgentTool } from "../../../../../src/core/agent-contract.ts";
import type { ImageContent, JsonValue } from "../../../../../src/core/types.ts";
import { actionPulls, type ToolActionVM } from "../../../../../src/viewmodel/index.ts";
import { enqueuePulls } from "../../../infra/net/pullQueue.ts";
import { useRpc } from "../../../infra/net/useRpc.ts";
import { useStore } from "../../../infra/state/store.tsx";
import styles from "../actions.module.css";
import { AgentToolCardBody } from "./AgentToolCardBody.tsx";
import { ApplyPatchCardBody } from "./ApplyPatchCardBody.tsx";
import type { ActionDetailsProps, AgentSpawnView, ToolArgs } from "./args.ts";
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
 *
 * The collaboration surface is one body for six calls, so it is keyed by the
 * shared contract rather than listed here: a seventh agent tool would otherwise
 * silently render as a generic card.
 */
const TOOL_DETAILS: Record<string, ComponentType<ActionDetailsProps>> = {
	edit: EditCardBody,
	apply_patch: ApplyPatchCardBody,
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
		? sanitizeOutputText(
				resultContent
					.map((c) => (c.type === "text" ? c.text : c.type === "image" ? "" : `[unsupported ${c.type} content]`))
					.join("\n"),
			)
		: null;

	const args: ToolArgs | null = arguments_ && typeof arguments_ === "object" ? (arguments_ as ToolArgs) : null;
	// The spawn result's UI-only address. Reading the details here keeps the card
	// free of store hooks; the row lookup and the navigation gesture are this
	// layer's. The selector returns the entry's own object (the store holds it) —
	// a fresh object would fail `useSyncExternalStore`'s snapshot check.
	const resultDetails = useStore(
		useCallback(
			(s) => {
				if (!action.result) return null;
				const entry = s.document.entries[action.result.entryId];
				return entry?.kind === "tool_result" ? entry.details : null;
			},
			[action.result],
		),
	);
	const childAddress = useMemo(() => spawnAddress(action.toolName, resultDetails), [action.toolName, resultDetails]);
	const childSessionId = childAddress?.sessionId ?? null;
	const childRow = useStore(
		useCallback(
			(s) => (childSessionId === null ? null : (s.queue.find((row) => row.sessionId === childSessionId) ?? null)),
			[childSessionId],
		),
	);
	const projectId = useStore(useCallback((s) => s.currentProjectId, []));
	const openSession = useRpc().openSession;
	const agentSpawn = useMemo<AgentSpawnView | undefined>(() => {
		if (childAddress === null || projectId === null) return undefined;
		return {
			child: childRow,
			open: () => void openSession(projectId, childAddress.stem, childAddress.sessionId),
		};
	}, [childAddress, childRow, openSession, projectId]);
	// Error text renders in the skeleton's error strip; bodies render result
	// content only on success. Bash is the exception: its error results are
	// command output plus a status line appended by the tool, which belongs
	// in the output area — the strip would duplicate it.
	const bodyOwnsResult = !(action.result?.isError ?? false) || action.toolName === "bash";
	const resultText = bodyOwnsResult ? fullResultText : null;
	const resultImages = bodyOwnsResult
		? (resultContent ?? []).filter((c): c is ImageContent => c.type === "image")
		: [];

	const Body = TOOL_DETAILS[action.toolName] ?? (isAgentTool(action.toolName) ? AgentToolCardBody : FallbackCardBody);
	return (
		<div className={styles.detailsBody}>
			<Body
				action={action}
				args={args}
				resultText={resultText}
				resultImages={resultImages}
				agentSpawn={agentSpawn}
			/>
		</div>
	);
});

/** The spawn result's hidden address — `session_id` and `stem`, written by the
 * host beside the model-facing `task_name`. Older results have none. */
function spawnAddress(toolName: string, details: JsonValue | null): { sessionId: string; stem: string } | null {
	if (toolName !== "spawn_agent" || details === null || typeof details !== "object" || Array.isArray(details)) {
		return null;
	}
	const record = details as Record<string, JsonValue>;
	const sessionId = record.session_id;
	const stem = record.stem;
	return typeof sessionId === "string" && typeof stem === "string" ? { sessionId, stem } : null;
}

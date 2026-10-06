// ThinkActionView — one thinking block rendered on the think tint
// (hue = think). The header row is the tool-action header itself —
// triangle + one-line plain-text summary (.actionCollapsed), full-width and
// fully clickable in both states, so collapsing never depends on a small
// corner badge. Expanding keeps the header and adds the full Markdown
// prose below it (the first line therefore appears twice — header summary
// plus document — accepted for a stable, large collapse target).
// Streaming: when collapsed, the store selector subscribes to the first line
// only, so tail appends don't re-render the action (the original
// optimization); expanded, it subscribes to the full text.
// Redacted / empty: a static muted one-liner, no collapse.
// Thinking text is lazy: null until pulled or streamed via subscription.

import { memo, useCallback } from "react";
import { actionPulls, type ThinkActionVM } from "../../../../src/viewmodel/index.ts";
import { enqueuePulls } from "../../infra/net/pullQueue.ts";
import { useStore } from "../../infra/state/store.tsx";
import { AppMarkdown } from "../viewer/AppMarkdown.tsx";
import styles from "./actions.module.css";

export const ThinkActionView = memo(function ThinkActionView({
	action,
	onToggleAction,
}: {
	action: ThinkActionVM;
	onToggleAction: (key: string) => void;
}) {
	const actionKey = `${action.entryId}:b${action.blockIndex}`;
	const isExpanded = useStore(useCallback((s) => s.expandedActions.has(actionKey), [actionKey]));

	// ADR 09: need a thinking pull for this action whenever it is visible
	// (provisional + committed, collapsed + expanded — collapsed line and the
	// expanded prose both need the text).
	useStore((s) => s.pullTick);
	if (!action.redacted) enqueuePulls(actionPulls(action, false));

	// Streaming optimization: when collapsed, subscribe to the first line only
	// (stable as the tail streams — no re-render on tail appends); when
	// expanded, subscribe to the full text. The leading flag is a stable
	// has-content bit so the empty case renders the static "think" label.
	const textSlice = useStore(
		useCallback(
			(s) => {
				const entry = s.document.entries[action.entryId];
				let t: string | null | undefined;
				if (!entry || entry.kind !== "message") {
					t = action.thinking;
				} else {
					const block = entry.content[action.blockIndex];
					t = block?.type === "thinking" ? block.thinking : action.thinking;
				}
				const text = t ?? "";
				const shown = isExpanded ? text : text.split("\n")[0];
				return `${text.length > 0 ? "1" : "0"}:${shown}`;
			},
			[isExpanded, action.entryId, action.blockIndex, action.thinking],
		),
	);
	const hasContent = textSlice[0] === "1";
	const shown = textSlice.slice(2);
	// Header summary: the first line. Collapsed, `shown` IS the first line;
	// expanded, it is the full text and the first line is re-extracted so the
	// header row can stay visible (and clickable) above the prose.
	const firstLine = isExpanded ? shown.split("\n")[0] : shown;

	const handleToggle = useCallback(() => onToggleAction(actionKey), [onToggleAction, actionKey]);
	const mode = action.isProvisional ? "streaming" : "static";

	if (action.redacted) {
		return (
			<div className={styles.action} data-kind="think">
				<div className={styles.thinkStatic}>(redacted)</div>
			</div>
		);
	}

	if (!hasContent) {
		return (
			<div className={styles.action} data-kind="think">
				<div className={styles.thinkStatic}>think</div>
			</div>
		);
	}

	// Header row (triangle + first-line summary) in both states — same anatomy
	// as a tool action, so the whole row is the collapse target; the full
	// Markdown prose renders below it when expanded.
	return (
		<div className={styles.action} data-kind="think">
			<div className={styles.actionHead}>
				<button
					type="button"
					className={styles.actionCollapsed}
					onClick={handleToggle}
					aria-expanded={isExpanded}
					aria-label={`${isExpanded ? "Collapse" : "Expand"} thinking`}
				>
					<span className={styles.collapseTri}>{isExpanded ? "\u25BE" : "\u25B8"}</span>
					<span className={styles.actionSummary}>{firstLine}</span>
				</button>
			</div>
			{isExpanded && (
				<div className={styles.thinkBody}>
					<AppMarkdown text={shown} mode={mode} />
				</div>
			)}
		</div>
	);
});

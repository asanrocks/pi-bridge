// ThinkActionView — one thinking block rendered on the think tint
// (hue = think). Collapsed, it is a full-width collapsed row identical to a tool
// action header — triangle + one-line plain-text summary (.actionCollapsed) — so it
// is uniform with tool actions and fully clickable. Expanding replaces it
// with the full Markdown prose flowing inline (a document, not a details
// card-with-heading); the triangle rides the first line, so the first
// line is never repeated in a header.
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

	// Collapsed: the tool action header itself (.actionCollapsed) — full-width button,
	// triangle + one-line plain-text summary, so the whole row is the click
	// target. Expanded: the triangle rides the first line of the full
	// Markdown prose (no separate preview, so no first-line repeat).
	return isExpanded ? (
		<div className={styles.action} data-kind="think">
			<div className={styles.thinkRow}>
				<button
					type="button"
					className={styles.thinkCollapsed}
					onClick={handleToggle}
					aria-expanded={true}
					aria-label="Collapse thinking"
				>
					<span className={styles.collapseTri}>{"\u25BE"}</span>
				</button>
				<div className={styles.thinkBody}>
					<AppMarkdown text={shown} mode={mode} />
				</div>
			</div>
		</div>
	) : (
		<div className={styles.action} data-kind="think">
			<button
				type="button"
				className={styles.actionCollapsed}
				onClick={handleToggle}
				aria-expanded={false}
				aria-label="Expand thinking"
			>
				<span className={styles.collapseTri}>{"\u25B8"}</span>
				<span className={styles.actionSummary}>{shown}</span>
			</button>
		</div>
	);
});

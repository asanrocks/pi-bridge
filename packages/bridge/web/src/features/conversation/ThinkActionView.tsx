// ThinkActionView — one thinking block rendered on the think tint
// (hue = think). The header row is the tool-action header itself —
// triangle + the thinking's first line rendered as Markdown and clamped to
// one line (.thinkPreview) — full-width and fully clickable in both states, so
// collapsing never depends on a small corner badge. Expanding keeps the header
// and adds the full Markdown prose below it (the first line therefore appears
// twice — header preview plus document — accepted for a stable, large collapse
// target).
//
// Re-render discipline — why the props are scalars, not the ThinkActionVM: a
// streaming block's VM reference changes on every delta, so passing it would
// defeat the memo this row depends on. Text comes from the store selector
// alone, sliced to the first line while collapsed: once line 1 is complete the
// selected slice is stable, so neither deltas on later lines nor unrelated pull
// completions re-render the row. The deferred value coalesces the deltas that
// do land (TextBlockView's rule for streaming Markdown).
// Redacted / empty: a static muted one-liner, no collapse.
// Thinking text is lazy: null until pulled or streamed via subscription.

import { memo, useCallback, useDeferredValue } from "react";
import { actionPulls, type ThinkActionVM } from "../../../../src/viewmodel/index.ts";
import { enqueuePulls } from "../../infra/net/pullQueue.ts";
import { useStore } from "../../infra/state/store.tsx";
import { AppMarkdown } from "../viewer/AppMarkdown.tsx";
import styles from "./actions.module.css";

export const ThinkActionView = memo(function ThinkActionView({
	entryId,
	blockIndex,
	isProvisional,
	redacted,
	onToggleAction,
}: {
	entryId: string;
	blockIndex: number;
	isProvisional: boolean;
	redacted: boolean;
	onToggleAction: (key: string) => void;
}) {
	const actionKey = `${entryId}:b${blockIndex}`;
	const isExpanded = useStore(useCallback((s) => s.expandedActions.has(actionKey), [actionKey]));

	// ADR 09: the collapsed line and the expanded prose both need the text, so
	// the slice is selected whether or not the row is open. The leading state
	// digit reports the lazy field itself — 0 = null (pull pending), 1 = set but
	// empty, 2 = set — which is what the label and the pull need below derive
	// from; planPull drops the request once the field is populated.
	const slice = useStore(
		useCallback(
			(s) => {
				const entry = s.document.entries[entryId];
				const block = entry?.kind === "message" ? entry.content[blockIndex] : undefined;
				const text = block?.type === "thinking" ? block.thinking : null;
				const state = text === null ? "0" : text.length > 0 ? "2" : "1";
				const shown = isExpanded ? (text ?? "") : (text ?? "").split("\n")[0];
				return `${state}:${shown}`;
			},
			[entryId, blockIndex, isExpanded],
		),
	);
	const state = slice[0];
	const shown = useDeferredValue(slice.slice(2));
	// Header preview: the first line in both states. Collapsed, `shown` IS the
	// first line; expanded, it is the full text and the first line is
	// re-extracted so the header preview can stay visible above the prose.
	const firstLine = isExpanded ? shown.split("\n")[0] : shown;

	// pullTick is subscribed only while the text is still missing: a settled row
	// must not re-render when unrelated pulls complete, while a pending pull
	// needs the tick to retry after a failure. enqueuePulls is idempotent
	// (planPull filters populated and in-flight fields).
	const needsPull = !redacted && state === "0";
	useStore(useCallback((s) => (needsPull ? s.pullTick : 0), [needsPull]));
	if (needsPull) {
		const action: ThinkActionVM = {
			blockType: "thinking",
			entryId,
			blockIndex,
			thinking: null,
			isProvisional,
			redacted,
		};
		enqueuePulls(actionPulls(action, false));
	}

	const handleToggle = useCallback(() => onToggleAction(actionKey), [onToggleAction, actionKey]);
	const mode = isProvisional ? "streaming" : "static";

	if (redacted) {
		return (
			<div className={styles.action} data-kind="think">
				<div className={styles.thinkStatic}>(redacted)</div>
			</div>
		);
	}

	if (state !== "2") {
		return (
			<div className={styles.action} data-kind="think">
				<div className={styles.thinkStatic}>think</div>
			</div>
		);
	}

	// The header row (triangle + first-line Markdown preview) renders in both
	// states — same anatomy as a tool action, so the whole row is the collapse
	// target; the unclamped full prose renders below it when expanded.
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
					<AppMarkdown text={firstLine} mode={mode} className={styles.thinkPreview} />
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

// ThinkActionStepView — one thinking block rendered on the think tint
// (hue = think). Folded, it is a full-width fold row identical to a tool
// step header — triangle + one-line plain-text summary (.stepFold) — so it
// is uniform with tool steps and fully clickable. Expanding replaces it
// with the full Markdown prose flowing inline (a document, not a details
// card-with-heading); the triangle rides the first line, so the first
// line is never repeated in a header.
// Streaming: when folded, the store selector subscribes to the first line
// only, so tail appends don't re-render the step (the original
// optimization); expanded, it subscribes to the full text.
// Redacted / empty: a static muted one-liner, no fold.
// Thinking text is lazy: null until pulled or streamed via subscription.

import { memo, useCallback } from "react";
import { stepWants, type ThinkActionStepVM } from "../../../../src/viewmodel/index.ts";
import { useStore } from "../../infra/store.tsx";
import { wantPull } from "../../infra/wants.ts";
import { Markdown } from "../../render/markdown.tsx";
import styles from "./conversation.module.css";

export const ThinkActionStepView = memo(function ThinkActionStepView({
	step,
	onToggleStep,
}: {
	step: ThinkActionStepVM;
	onToggleStep: (key: string) => void;
}) {
	const actionKey = `${step.entryId}:b${step.blockIndex}`;
	const isExpanded = useStore(useCallback((s) => s.expandedSteps.has(actionKey), [actionKey]));

	// ADR 09: want thinking for this step whenever it is visible
	// (provisional + committed, folded + expanded — the folded line and the
	// expanded prose both need the text).
	useStore((s) => s.pullTick);
	if (!step.redacted) wantPull(stepWants(step, false));

	// Streaming optimization: when folded, subscribe to the first line only
	// (stable as the tail streams — no re-render on tail appends); when
	// expanded, subscribe to the full text. The leading flag is a stable
	// has-content bit so the empty case renders the static "think" label.
	const textSlice = useStore(
		useCallback(
			(s) => {
				const entry = s.document.entries[step.entryId];
				let t: string | null | undefined;
				if (!entry || entry.kind !== "message") {
					t = step.thinking;
				} else {
					const block = entry.content[step.blockIndex];
					t = block?.type === "thinking" ? block.thinking : step.thinking;
				}
				const text = t ?? "";
				const shown = isExpanded ? text : text.split("\n")[0];
				return `${text.length > 0 ? "1" : "0"}:${shown}`;
			},
			[isExpanded, step.entryId, step.blockIndex, step.thinking],
		),
	);
	const hasContent = textSlice[0] === "1";
	const shown = textSlice.slice(2);

	const handleToggle = useCallback(() => onToggleStep(actionKey), [onToggleStep, actionKey]);
	const mode = step.isProvisional ? "streaming" : "static";

	if (step.redacted) {
		return (
			<div className={styles.actionStep} data-kind="think">
				<div className={styles.thinkStatic}>(redacted)</div>
			</div>
		);
	}

	if (!hasContent) {
		return (
			<div className={styles.actionStep} data-kind="think">
				<div className={styles.thinkStatic}>think</div>
			</div>
		);
	}

	// Folded: the tool step header itself (.stepFold) — full-width button,
	// triangle + one-line plain-text summary, so the whole row is the click
	// target. Expanded: the triangle rides the first line of the full
	// Markdown prose (no separate preview, so no first-line repeat).
	return isExpanded ? (
		<div className={styles.actionStep} data-kind="think">
			<div className={styles.thinkRow}>
				<button
					type="button"
					className={styles.thinkFold}
					onClick={handleToggle}
					aria-expanded={true}
					aria-label="Collapse thinking"
				>
					<span className={styles.foldTri}>{"\u25BE"}</span>
				</button>
				<div className={styles.thinkBody}>
					<Markdown text={shown} mode={mode} />
				</div>
			</div>
		</div>
	) : (
		<div className={styles.actionStep} data-kind="think">
			<button
				type="button"
				className={styles.stepFold}
				onClick={handleToggle}
				aria-expanded={false}
				aria-label="Expand thinking"
			>
				<span className={styles.foldTri}>{"\u25B8"}</span>
				<span className={styles.stepSummary}>{shown}</span>
			</button>
		</div>
	);
});

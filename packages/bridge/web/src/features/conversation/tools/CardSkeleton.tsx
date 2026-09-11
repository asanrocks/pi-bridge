// CardSkeleton — the shared zones rendered above every tool card's content
// panel: a status line (light + duration + call annotations), the
// full-form identity line (full path / full command), and the error strip.
// Presentational only — ToolActionStepView owns the store subscriptions
// (live args, result text, timing) and passes plain data, so these render
// under SSR tests without a store.

import { memo, useCallback, useRef, useState } from "react";
import type { ToolActionStepVM } from "../../../../../src/viewmodel/index.ts";
import { CheckIcon, CopyIcon } from "../../../render/icons.tsx";
import { copyToClipboard } from "../clipboard.ts";
import styles from "../conversation.module.css";

export interface ToolTiming {
	startedAt: number;
	endedAt: number | null;
}

/**
 * Status line — light + duration + timeout annotation + status chips
 * (exit code, timeout, abort). Sits on the band tint above the identity
 * line: it is metadata about the call, not content. The light renders once
 * execution has started (status is derivable on reload); the duration
 * renders only for live-witnessed runs (exec-start isn't on the wire). The
 * timeout is a call argument, so it survives reload — it docks here as a
 * muted annotation, not inside the command.
 */
export const CardStatusLine = memo(function CardStatusLine({
	status,
	timing,
	timeout,
	chips,
}: {
	status: ToolActionStepVM["status"];
	timing: ToolTiming | null;
	timeout: number | null;
	chips?: ReadonlyArray<{ text: string; tone: "error" | "warning" }>;
}) {
	if (status === "pending") return null;
	let text: string | null = null;
	if (timing) {
		const end = timing.endedAt ?? Date.now();
		const elapsed = `${((end - timing.startedAt) / 1000).toFixed(1)}s`;
		const label = status === "running" ? "Elapsed" : "Took";
		text = `${label} ${elapsed}`;
	}
	return (
		<div className={styles.cardMeta}>
			<span className={styles.cardStatusLight} data-status={status} />
			{text && <span className={styles.cardStatusText}>{text}</span>}
			{timeout !== null && <span className={styles.cardStatusText}>{`timeout ${timeout}s`}</span>}
			{chips?.map((chip) => (
				<span key={chip.text} className={styles.cardStatusChip} data-tone={chip.tone}>
					{chip.text}
				</span>
			))}
		</div>
	);
});

/**
 * Identity line — the full-form identifier. The collapsed band abbreviates
 * (basename, single line); this restores the full path / whole command in a
 * lighter treatment on the band tint.
 */
export const CardIdentity = memo(function CardIdentity({ text }: { text: string | null }) {
	if (!text) return null;
	return <div className={styles.cardIdentity}>{text}</div>;
});

/**
 * Error strip — the tool's error text, skeleton-owned so every card renders
 * failures uniformly (the per-tool bodies never re-derive error display).
 * Sits between identity and content.
 */
export const CardError = memo(function CardError({ text }: { text: string | null }) {
	if (!text) return null;
	return <div className={styles.cardError}>{text}</div>;
});

/**
 * Truncation notice — warning strip for truncated output; the full-output
 * path (a daemon-side temp file) copies on click. Shared by the bash tool
 * card and the user-bash card.
 */
export const TruncationNotice = memo(function TruncationNotice({
	notice,
	fullPath,
}: {
	notice: string;
	fullPath: string | null;
}) {
	const [copied, setCopied] = useState(false);
	const handleCopy = useCallback(async () => {
		if (fullPath && (await copyToClipboard(fullPath))) {
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		}
	}, [fullPath]);
	return (
		<div className={styles.cardNotice}>
			<span>{`truncated — ${notice}`}</span>
			{fullPath && (
				<button type="button" className={styles.noticePath} onClick={handleCopy} title={fullPath}>
					{copied ? "copied" : "full output"}
				</button>
			)}
		</div>
	);
});

/**
 * Card controls — the hover-revealed cluster docked right in the card's
 * top bar: copy (primary payload), line-wrap toggle, markdown toggle, and
 * the details cap toggle (the old step-header cap chip, swallowed here).
 * Presentational: every input is a prop, so SSR tests cover it without a
 * store. On hover-incapable pointers (touch) the cluster stays visible —
 * hover-only controls would be unreachable there (CSS media query).
 */
export const CardControls = memo(function CardControls({
	copyText,
	showWrap,
	wrap,
	showMarkdown,
	markdown,
	capped,
	onToggleWrap,
	onToggleMarkdown,
	onToggleCap,
}: {
	copyText: string | null;
	showWrap: boolean;
	wrap: boolean;
	showMarkdown: boolean;
	markdown: boolean;
	capped: "none" | "capped" | "uncapped";
	onToggleWrap: () => void;
	onToggleMarkdown: () => void;
	onToggleCap: () => void;
}) {
	const [copied, setCopied] = useState(false);
	const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const handleCopy = useCallback(async () => {
		if (copyText === null || copyText === undefined) return;
		if (await copyToClipboard(copyText)) {
			setCopied(true);
			clearTimeout(resetTimer.current);
			resetTimer.current = setTimeout(() => setCopied(false), 1200);
		}
	}, [copyText]);

	if (copyText === null && !showWrap && !showMarkdown && capped === "none") return null;
	return (
		<div className={styles.cardControls}>
			{copyText !== null && (
				<button type="button" className={styles.cardCtrlBtn} onClick={handleCopy} aria-label="Copy content">
					{copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
				</button>
			)}
			{showWrap && (
				<button
					type="button"
					className={styles.cardCtrlBtn}
					data-on={wrap || undefined}
					aria-pressed={wrap}
					aria-label="Toggle line wrap"
					onClick={onToggleWrap}
				>
					wrap
				</button>
			)}
			{showMarkdown && (
				<button
					type="button"
					className={styles.cardCtrlBtn}
					data-on={markdown || undefined}
					aria-pressed={markdown}
					aria-label="Toggle markdown rendering"
					onClick={onToggleMarkdown}
				>
					md
				</button>
			)}
			{capped !== "none" && (
				<button type="button" className={styles.cardCtrlBtn} onClick={onToggleCap}>
					{capped === "uncapped" ? "\u25B4 collapse" : "\u25BE show all"}
				</button>
			)}
		</div>
	);
});

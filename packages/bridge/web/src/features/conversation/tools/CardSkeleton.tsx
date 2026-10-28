// CardSkeleton — the shared zones rendered above every tool card's content
// panel: a status line (light + duration + call annotations), the
// full-form header line (full path / full command), and the error strip.
// Presentational only — ToolActionView owns the store subscriptions
// (live args, result text, timing) and passes plain data, so these render
// under SSR tests without a store.

import { memo, useCallback, useRef, useState } from "react";
import type { ToolActionVM } from "../../../../../src/viewmodel/index.ts";
import { copyToClipboard } from "../../../infra/lib/clipboard.ts";
import {
	CheckIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	CopyIcon,
	EyeIcon,
	MarkdownIcon,
	WrapIcon,
} from "../../../render/icons.tsx";
import styles from "../actions.module.css";

/**
 * Status line — light + duration + timeout annotation + status chips
 * (exit code, timeout, abort). Sits on the row tint above the header
 * line: it is metadata about the call, not content. The light renders once
 * execution has started. A settled call shows pi's recorded execution time
 * (`ToolResultMessage.durationMs`, live and on reload alike); a running call
 * shows the host-anchored live elapsed (`status.inFlightTools`), or just the
 * light when no anchor is known. The timeout is a call argument, so it
 * survives reload — it docks here as a muted annotation, not inside the
 * command.
 */
export const CardStatusLine = memo(function CardStatusLine({
	status,
	durationMs,
	elapsedMs,
	timeout,
	chips,
}: {
	status: ToolActionVM["status"];
	durationMs: number | null;
	elapsedMs: number | null;
	timeout: number | null;
	chips?: ReadonlyArray<{ text: string; tone: "error" | "warning" }>;
}) {
	if (status === "pending") return null;
	// pi's measured duration wins once the result exists (it can precede the
	// seal, so status may still read "running"); otherwise the live anchor.
	let text: string | null = null;
	if (durationMs !== null) text = `Took ${(durationMs / 1000).toFixed(1)}s`;
	else if (elapsedMs !== null) text = `Elapsed ${(elapsedMs / 1000).toFixed(1)}s`;
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
 * Header line — the full-form identifier. The collapsed tinted row abbreviates
 * (basename, single line); this restores the full path / whole command in a
 * lighter treatment on the row tint.
 */
export const CardHeader = memo(function CardHeader({ text }: { text: string | null }) {
	if (!text) return null;
	return <div className={styles.cardHeader}>{text}</div>;
});

/**
 * Error strip — the tool's error text, skeleton-owned so every card renders
 * failures uniformly (the per-tool bodies never re-derive error display).
 * Sits between header and content.
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
					{copied ? "Copied" : "Full output"}
				</button>
			)}
		</div>
	);
});

/**
 * Card controls — the hover-revealed cluster docked right in the card's
 * top bar: copy (primary payload), line-wrap toggle, markdown toggle, and
 * the details cap toggle (the old action-header cap chip, swallowed here).
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
	viewPath,
	onOpenView,
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
	/** File path referenced by the call (string `path` arg) — shows the
	 * open-in-viewer eye when set. The viewer re-reads from disk, so it shows
	 * the file as it exists now, not what the call produced. */
	viewPath?: string | null;
	onOpenView?: () => void;
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

	if (copyText === null && !showWrap && !showMarkdown && capped === "none" && !viewPath) return null;
	return (
		<div className={styles.cardControls}>
			{viewPath != null && (
				<button
					type="button"
					className={styles.cardCtrlBtn}
					onClick={() => onOpenView?.()}
					aria-label="Open in viewer"
					title={`Open in viewer: ${viewPath}`}
				>
					<EyeIcon size={14} />
				</button>
			)}
			{copyText !== null && (
				<button
					type="button"
					className={styles.cardCtrlBtn}
					onClick={handleCopy}
					aria-label="Copy content"
					title={copied ? "Copied" : "Copy content"}
				>
					{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
				</button>
			)}
			{showWrap && (
				<button
					type="button"
					className={styles.cardCtrlBtn}
					data-on={wrap || undefined}
					aria-pressed={wrap}
					aria-label="Toggle line wrap"
					title="Toggle line wrap"
					onClick={onToggleWrap}
				>
					<WrapIcon size={14} />
				</button>
			)}
			{showMarkdown && (
				<button
					type="button"
					className={styles.cardCtrlBtn}
					data-on={markdown || undefined}
					aria-pressed={markdown}
					aria-label="Toggle markdown rendering"
					title="Toggle markdown rendering"
					onClick={onToggleMarkdown}
				>
					<MarkdownIcon size={14} />
				</button>
			)}
			{capped !== "none" && (
				<button
					type="button"
					className={styles.cardCtrlBtn}
					aria-label={capped === "uncapped" ? "Collapse to cap" : "Show all"}
					title={capped === "uncapped" ? "Collapse to cap" : "Show all"}
					onClick={onToggleCap}
				>
					{capped === "uncapped" ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
				</button>
			)}
		</div>
	);
});

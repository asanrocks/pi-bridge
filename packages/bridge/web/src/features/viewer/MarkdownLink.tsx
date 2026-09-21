// ============================================================================
// MarkdownLink — Streamdown `a` override for the app.
//
// File-path hrefs (LLM markdown links like `./README.md`, `/abs/path.md`,
// `file:///…`) open the in-app FileViewer via the readFile verb instead of
// navigating to a 404 on the daemon origin. URL hrefs keep the external-link
// confirm step (links come from model output — a click-through guard against
// prompt-injected navigation), restyled to the app's portal tokens instead
// of Streamdown's default modal chrome.
// ============================================================================

import { memo, useEffect, useState } from "react";
import type { ExtraProps } from "streamdown";
import { useStore } from "../../infra/state/store.tsx";
import { classifyHref } from "./links.ts";
import styles from "./Viewer.module.css";

/** Mirrors Streamdown's link classes (`wrap-anywhere font-medium text-primary
 * underline`) so overridden links render identically to default ones. The
 * literals stay alive via the @source scan of streamdown/dist in index.css. */
const LINK_CLASSES = "wrap-anywhere font-medium text-primary underline";

export const MarkdownLink = memo(function MarkdownLink({
	href,
	children,
	node: _node,
	...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
	const openFileViewer = useStore((s) => s.openFileViewer);
	const [confirmUrl, setConfirmUrl] = useState<string | null>(null);
	const target = classifyHref(href ?? "");

	if (!target || !href) {
		// Incomplete link (still streaming) or unresolvable href — same
		// styling, no interaction. Matches Streamdown's no-op behavior.
		return (
			<span className={LINK_CLASSES} data-streamdown="link" data-incomplete="true" {...rest}>
				{children}
			</span>
		);
	}

	if (target.kind === "file") {
		return (
			<button
				type="button"
				className={LINK_CLASSES}
				data-streamdown="link"
				title={`Open file: ${target.path}`}
				onClick={() => openFileViewer(target.path, target.line)}
			>
				{children}
			</button>
		);
	}

	return (
		<>
			<button
				type="button"
				className={LINK_CLASSES}
				data-streamdown="link"
				title={`Open external link: ${target.url}`}
				onClick={() => setConfirmUrl(target.url)}
			>
				{children}
			</button>
			{confirmUrl !== null && (
				<UrlConfirmDialog
					url={confirmUrl}
					onClose={() => setConfirmUrl(null)}
					onConfirm={() => {
						setConfirmUrl(null);
						window.open(target.url, "_blank", "noreferrer");
					}}
				/>
			)}
		</>
	);
});

// ---------------------------------------------------------------------------
// UrlConfirmDialog — external-link confirmation (app-styled replacement for
// Streamdown's default link-safety modal).
// ---------------------------------------------------------------------------

function UrlConfirmDialog({ url, onClose, onConfirm }: { url: string; onClose: () => void; onConfirm: () => void }) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<>
			<button
				type="button"
				aria-label="Close link confirmation"
				className={styles.dialogOverlay}
				onClick={onClose}
			/>
			<div role="dialog" className={styles.dialogPanel}>
				<div className={styles.dialogTitle}>Open external link?</div>
				<div className={styles.dialogUrl}>{url}</div>
				<div className={styles.dialogActions}>
					<button type="button" className={styles.dialogCancel} onClick={onClose}>
						Cancel
					</button>
					<button type="button" className={styles.dialogConfirm} onClick={onConfirm}>
						Open link
					</button>
				</div>
			</div>
		</>
	);
}

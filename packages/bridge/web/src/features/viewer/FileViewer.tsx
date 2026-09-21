// ============================================================================
// FileViewer — in-app file viewer for markdown file links and tool cards.
//
// Mounted once in App; shows when `fileViewer` is set. Every open issues
// a fresh readFile RPC — content is never cached, so the viewer always shows
// the file as it exists on disk right now (the link may point at a file the
// agent has since rewritten). Relative paths resolve against the attached
// instance's cwd on the daemon side; the reply's absolute path is echoed in
// the header so the resolution is visible. An optional `line` (from a
// `path:98` link suffix or `#L98` fragment) scrolls to and flashes that line
// after load — code files render a line-number gutter; markdown skips it.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import type { ReadFileReply } from "../../../../src/core/index.ts";
import { getGlobalClient } from "../../infra/net/client.ts";
import { useStore } from "../../infra/state/store.tsx";
import { CodeSnippet } from "../../render/CodeSnippet.tsx";
import { MarkdownIcon, WrapIcon } from "../../render/icons.tsx";
import { Markdown } from "../../render/markdown.tsx";
import { extToLang } from "../conversation/tools/args.ts";
import styles from "./Viewer.module.css";

type ViewerState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "open"; content: string; truncated: boolean; absPath: string };

export function FileViewer() {
	const fileViewer = useStore((s) => s.fileViewer);
	const closeFileViewer = useStore((s) => s.closeFileViewer);
	// Display preferences are the store-wide card toggles: the viewer is the
	// same "read code/md content" surface, so one preference drives both.
	const cardWrap = useStore((s) => s.cardWrap);
	const toggleCardWrap = useStore((s) => s.toggleCardWrap);
	const cardMarkdown = useStore((s) => s.cardMarkdown);
	const toggleCardMarkdown = useStore((s) => s.toggleCardMarkdown);
	const [state, setState] = useState<ViewerState>({ status: "loading" });
	const bodyRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (fileViewer === null) return;
		setState({ status: "loading" });
		let cancelled = false;
		const client = getGlobalClient();
		if (!client) {
			setState({ status: "error", message: "Not connected" });
			return;
		}
		client
			.readFile(fileViewer.path)
			.then((reply) => {
				if (cancelled) return;
				if (reply.ok) {
					const data = reply as unknown as ReadFileReply;
					setState({
						status: "open",
						content: data.content,
						truncated: data.truncated,
						absPath: data.path,
					});
				} else {
					const message = typeof reply.error === "string" ? reply.error : "read failed";
					setState({ status: "error", message });
				}
			})
			.catch((err) => {
				if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : "read failed" });
			});
		return () => {
			cancelled = true;
		};
	}, [fileViewer]);

	// Scroll the requested line into view and flash it. The line elements
	// exist only once shiki's highlighted result has rendered (the pre-load
	// fallback is plain text), so retry across frames for a bounded window.
	useEffect(() => {
		if (fileViewer?.line === undefined || state.status !== "open") return;
		const line = fileViewer.line;
		let raf = 0;
		const deadline = Date.now() + 2000;
		const seek = () => {
			const el = bodyRef.current?.querySelector(`[data-line="${line}"]`);
			if (el) {
				el.scrollIntoView({ block: "center" });
				return;
			}
			if (Date.now() < deadline) raf = requestAnimationFrame(seek);
		};
		raf = requestAnimationFrame(seek);
		return () => cancelAnimationFrame(raf);
	}, [fileViewer, state.status]);

	useEffect(() => {
		if (fileViewer === null) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") closeFileViewer();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [fileViewer, closeFileViewer]);

	if (fileViewer === null) return null;

	const { path, line } = fileViewer;
	const isMarkdown = path.toLowerCase().endsWith(".md");
	// The resolved absolute path once loaded; the raw link href while loading.
	const headerPath = state.status === "open" ? state.absPath : path;

	return (
		<>
			<button
				type="button"
				aria-label="Close file viewer"
				className={styles.viewerOverlay}
				onClick={closeFileViewer}
			/>
			<div role="dialog" className={styles.viewerPanel}>
				<div className={styles.viewerHeader}>
					<span className={styles.viewerPath}>{headerPath}</span>
					{isMarkdown ? (
						<button
							type="button"
							className={styles.viewerToggle}
							data-on={cardMarkdown || undefined}
							aria-pressed={cardMarkdown}
							aria-label="Toggle markdown preview"
							title="Toggle markdown preview"
							onClick={toggleCardMarkdown}
						>
							<MarkdownIcon size={13} />
						</button>
					) : (
						<button
							type="button"
							className={styles.viewerToggle}
							data-on={cardWrap || undefined}
							aria-pressed={cardWrap}
							aria-label="Toggle line wrap"
							title="Toggle line wrap"
							onClick={toggleCardWrap}
						>
							<WrapIcon size={13} />
						</button>
					)}
					<button type="button" className={styles.viewerClose} onClick={closeFileViewer} aria-label="Close">
						✕
					</button>
				</div>
				<div className={styles.viewerBody} ref={bodyRef}>
					{state.status === "loading" && <div className={styles.viewerMessage}>Loading…</div>}
					{state.status === "error" && (
						<div className={styles.viewerError}>
							Could not read <span className={styles.viewerPath}>{path}</span>
							<br />
							{state.message}
						</div>
					)}
					{state.status === "open" && (
						<>
							{state.truncated && (
								<div className={styles.viewerTruncated}>File truncated — showing the first 256&nbsp;KB</div>
							)}
							{isMarkdown ? (
								cardMarkdown ? (
									<Markdown text={state.content} mode="static" />
								) : (
									<CodeSnippet
										code={state.content}
										language="markdown"
										wrap={cardWrap}
										lineNumbers
										highlightLine={line}
									/>
								)
							) : (
								<CodeSnippet
									code={state.content}
									language={extToLang(state.absPath)}
									wrap={cardWrap}
									lineNumbers
									highlightLine={line}
								/>
							)}
						</>
					)}
				</div>
			</div>
		</>
	);
}

// ============================================================================
// FileViewer — in-app file viewer for markdown file links.
//
// Mounted once in App; shows when `fileViewerPath` is set. Every open issues
// a fresh readFile RPC — content is never cached, so the viewer always shows
// the file as it exists on disk right now (the link may point at a file the
// agent has since rewritten). Relative paths resolve against the attached
// instance's cwd on the daemon side; the reply's absolute path is echoed in
// the header so the resolution is visible.
// ============================================================================

import { useEffect, useState } from "react";
import type { ReadFileReply } from "../../../../src/core/index.ts";
import { getGlobalClient } from "../../infra/net/client.ts";
import { useStore } from "../../infra/state/store.tsx";
import { CodeSnippet } from "../../render/CodeSnippet.tsx";
import { Markdown } from "../../render/markdown.tsx";
import { extToLang } from "../conversation/tools/args.ts";
import styles from "./Viewer.module.css";

type ViewerState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "open"; content: string; truncated: boolean; absPath: string };

export function FileViewer() {
	const path = useStore((s) => s.fileViewerPath);
	const closeFileViewer = useStore((s) => s.closeFileViewer);
	const [state, setState] = useState<ViewerState>({ status: "loading" });

	useEffect(() => {
		if (path === null) return;
		setState({ status: "loading" });
		let cancelled = false;
		const client = getGlobalClient();
		if (!client) {
			setState({ status: "error", message: "Not connected" });
			return;
		}
		client
			.readFile(path)
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
	}, [path]);

	useEffect(() => {
		if (path === null) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") closeFileViewer();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [path, closeFileViewer]);

	if (path === null) return null;

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
					<button type="button" className={styles.viewerClose} onClick={closeFileViewer} aria-label="Close">
						✕
					</button>
				</div>
				<div className={styles.viewerBody}>
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
								<Markdown text={state.content} mode="static" />
							) : (
								<CodeSnippet code={state.content} language={extToLang(state.absPath)} wrap />
							)}
						</>
					)}
				</div>
			</div>
		</>
	);
}

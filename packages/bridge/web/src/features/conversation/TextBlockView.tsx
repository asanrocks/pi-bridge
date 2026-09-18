// TextBlockView — renders streaming markdown via streamdown.
// State lives in the Zustand store; the selector always returns the freshest
// text (wire-eager, streams via append). Streamdown handles incremental DOM
// updates so each chunk doesn't nuke the subtree.
//
// Copy is attached here — per message, not per turn: a merged turn holds
// several messages, so the turn header cannot copy "the message". The
// button uses the same .toolbarBtn chip spec as the user-message Copy,
// floating at the segment's top-right, revealed on hover/focus (always
// visible on touch) and copying this block's markdown source.

import { memo, useCallback, useDeferredValue, useState } from "react";
import { useStore } from "../../infra/state/store.tsx";
import { CheckIcon, CopyIcon } from "../../render/icons.tsx";
import { AppMarkdown } from "../viewer/AppMarkdown.tsx";
import { copyToClipboard } from "./clipboard.ts";
import styles from "./turns.module.css";

export const TextBlockView = memo(function TextBlockView({
	entryId,
	blockIndex,
	isProvisional,
	showCursor,
}: {
	entryId: string;
	blockIndex: number;
	isProvisional: boolean;
	showCursor?: boolean;
}) {
	const text = useStore(
		useCallback(
			(s) => {
				const entry = s.document.entries[entryId];
				if (!entry || entry.kind !== "message") return "";
				const block = entry.content[blockIndex];
				return block?.type === "text" ? block.text : "";
			},
			[entryId, blockIndex],
		),
	);

	const deferredText = useDeferredValue(text);
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(async () => {
		if (await copyToClipboard(text)) {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		}
	}, [text]);

	return (
		<div className={`${styles.textSegment} ${styles.markdownContent}`}>
			<MarkdownBlock text={deferredText} isProvisional={isProvisional} />
			{showCursor && isProvisional && <span className={styles.streamingCursor}>|</span>}
			{text.length > 0 && (
				<button
					type="button"
					className={`${styles.toolbarBtn} ${styles.msgCopyBtn}`}
					onClick={handleCopy}
					aria-label={copied ? "Copied" : "Copy message"}
					title="Copy message"
				>
					{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
				</button>
			)}
		</div>
	);
});

// Markdown in its own memo slot: the copy button's `copied` toggle re-renders
// TextBlockView, but the Streamdown subtree should not re-render for the
// same text.
const MarkdownBlock = memo(function MarkdownBlock({ text, isProvisional }: { text: string; isProvisional: boolean }) {
	return <AppMarkdown text={text} mode={isProvisional ? "streaming" : "static"} />;
});

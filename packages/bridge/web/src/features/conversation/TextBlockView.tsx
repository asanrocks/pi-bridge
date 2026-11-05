// TextBlockView — renders streaming markdown via streamdown.
// State lives in the Zustand store; the selector always returns the freshest
// text (wire-eager, streams via append). Streamdown handles incremental DOM
// updates so each chunk doesn't nuke the subtree.
//
// Copy is attached here — per message, not per turn: a merged turn holds
// several messages, so the turn header cannot copy "the message". The
// button is the app's floating chip (`.floating` in render/buttons.module.css
// — the same recipe as the code-block copy chip and the jump button), placed
// at the segment's top-right, revealed on hover/focus. The reveal also gates
// hit-testing (pointer-events), so the invisible chip never answers a click
// that meant to place a caret.
//
// The chip precedes the Markdown in DOM order: on a coarse pointer it leaves
// the overlay and floats at the segment's top-right, and a float can only sit
// beside text that follows it in the flow (see turns.module.css). The absolute
// placement on hover-capable inputs makes that order invisible.
// Copies this block's markdown source.

import { memo, useCallback, useDeferredValue, useState } from "react";
import { COPIED_FEEDBACK_MS, copyToClipboard } from "../../infra/lib/clipboard.ts";
import { useStore } from "../../infra/state/store.tsx";
import { CheckIcon, CopyIcon } from "../../render/icons.tsx";
import { AppMarkdown } from "../viewer/AppMarkdown.tsx";
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
			setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
		}
	}, [text]);

	return (
		<div className={`${styles.textSegment} ${styles.markdownContent}`}>
			{text.length > 0 && (
				<button
					type="button"
					className={styles.msgCopyBtn}
					onClick={handleCopy}
					aria-label={copied ? "Copied" : "Copy message"}
					title={copied ? "Copied" : "Copy message"}
				>
					{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
				</button>
			)}
			<MarkdownBlock text={deferredText} isProvisional={isProvisional} />
			{showCursor && isProvisional && <span className={styles.streamingCursor}>|</span>}
		</div>
	);
});

// Markdown in its own memo slot: the copy button's `copied` toggle re-renders
// TextBlockView, but the Streamdown subtree should not re-render for the
// same text.
const MarkdownBlock = memo(function MarkdownBlock({ text, isProvisional }: { text: string; isProvisional: boolean }) {
	return <AppMarkdown text={text} mode={isProvisional ? "streaming" : "static"} />;
});

// ============================================================================
// usePathCompletion — file-path tab-completion for a compose surface. Owns
// the token extraction, dropdown navigation, and acceptance editing; the
// completion source is injected (`complete`), so the session dock passes the
// attached-session `listFiles` RPC and the Project home a no-op (the
// `listFiles` re-address to the Project is deferred — ADR 12).
//
// `handleKeyDown` returns true when the event was consumed (dropdown open,
// or the Tab trigger fired); the card calls it before its own key handling.
// ============================================================================

import { type ReactNode, useCallback, useRef, useState } from "react";
import { PathCompletion } from "./PathCompletion.tsx";

export interface PathCompletionEntry {
	path: string;
	isDirectory: boolean;
}

export function usePathCompletion(options: {
	value: string;
	onChange: (text: string) => void;
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	complete: (prefix: string) => Promise<PathCompletionEntry[]>;
}): {
	handleKeyDown: (e: React.KeyboardEvent) => boolean;
	node: ReactNode;
	close: () => void;
} {
	const { value, onChange, textareaRef, complete } = options;
	const [open, setOpen] = useState(false);
	const [completions, setCompletions] = useState<PathCompletionEntry[]>([]);
	const [index, setIndex] = useState(0);
	const [tokenStart, setTokenStart] = useState(0);
	// Guards a stale async fetch: only the latest request may open the dropdown.
	const fetchSeqRef = useRef(0);

	const close = useCallback(() => {
		setOpen(false);
		setCompletions([]);
		setIndex(0);
	}, []);

	// Extract the path-like token before the cursor
	const getPathPrefix = useCallback((): { prefix: string; start: number } | null => {
		const el = textareaRef.current;
		if (!el) return null;
		const cursor = el.selectionStart;
		const before = value.slice(0, cursor);

		let start = -1;
		for (let i = before.length - 1; i >= 0; i--) {
			const ch = before[i];
			if (ch === " " || ch === "\t" || ch === '"' || ch === "'" || ch === "=") {
				start = i + 1;
				break;
			}
		}
		if (start === -1) start = 0;

		const token = before.slice(start);
		if (
			token === "" ||
			token.startsWith("/") ||
			token.startsWith("./") ||
			token.startsWith("../") ||
			token.startsWith("~/") ||
			token.includes("/")
		) {
			return { prefix: token, start };
		}
		return null;
	}, [value, textareaRef]);

	const fetchCompletions = useCallback(
		async (prefix: string, start: number) => {
			const seq = ++fetchSeqRef.current;
			const entries = await complete(prefix);
			if (seq !== fetchSeqRef.current) return; // superseded
			if (entries.length === 0) {
				close();
				return;
			}
			setCompletions(entries);
			setIndex(0);
			setTokenStart(start);
			setOpen(true);
		},
		[complete, close],
	);

	// Accept a completion — replace the token from start to cursor
	const accept = useCallback(
		(idx: number) => {
			const el = textareaRef.current;
			if (!el || idx < 0 || idx >= completions.length) return;
			const item = completions[idx];
			const cursor = el.selectionStart;
			const before = value.slice(0, tokenStart);
			const after = value.slice(cursor);
			const displayedPath = item.isDirectory ? `${item.path}/` : item.path;
			const suffix = item.isDirectory ? "" : " ";
			const newInput = before + displayedPath + suffix + after;
			onChange(newInput);

			const newCursor = before.length + displayedPath.length + suffix.length;
			requestAnimationFrame(() => {
				if (textareaRef.current) {
					textareaRef.current.selectionStart = newCursor;
					textareaRef.current.selectionEnd = newCursor;
				}
			});

			if (item.isDirectory) {
				void fetchCompletions(displayedPath, before.length);
			} else {
				close();
			}
		},
		[value, completions, tokenStart, onChange, textareaRef, fetchCompletions, close],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent): boolean => {
			if (open) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					setIndex((i) => Math.min(i + 1, completions.length - 1));
					return true;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					setIndex((i) => Math.max(i - 1, 0));
					return true;
				}
				if (e.key === "Enter") {
					e.preventDefault();
					accept(index);
					return true;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					close();
					return true;
				}
				if (e.key === "Tab") {
					e.preventDefault();
					if (completions.length === 1) {
						accept(0);
					} else if (e.shiftKey) {
						setIndex((i) => (i - 1 + completions.length) % completions.length);
					} else {
						setIndex((i) => (i + 1) % completions.length);
					}
					return true;
				}

				if (!e.ctrlKey && !e.metaKey && !e.altKey) {
					close();
				}
				return false;
			}

			// Tab (not shift) with a path-like token before the cursor triggers
			// completion. Available in both compose and edit drafts — editing a
			// message often involves editing paths too.
			if (e.key === "Tab" && !e.shiftKey) {
				const pathInfo = getPathPrefix();
				if (pathInfo) {
					e.preventDefault();
					void fetchCompletions(pathInfo.prefix, pathInfo.start);
					return true;
				}
			}
			return false;
		},
		[open, completions, index, accept, close, getPathPrefix, fetchCompletions],
	);

	return {
		handleKeyDown,
		node:
			open && completions.length > 0 ? (
				<PathCompletion completions={completions} selectedIndex={index} onSelect={accept} onDismiss={close} />
			) : null,
		close,
	};
}

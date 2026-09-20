// ============================================================================
// usePathCompletion — file-path completion for a compose surface. Owns the
// token extraction, dropdown navigation, and acceptance editing; the
// completion source is injected (`complete`) — useComposeCapabilities supplies
// the Project-scoped `listFiles` RPC (ADR 12).
//
// Two triggers feed one state machine:
//   - `handleKeyDown` (Tab) — explicit, works on any pointer.
//   - a debounced auto-open on touch (`pointer: coarse`), where no Tab key
//     exists. Its predicate is stricter (pure `pathToken.ts`), because it
//     fires from ordinary typing rather than a deliberate key.
//
// `handleKeyDown` returns true when the event was consumed (dropdown open,
// or the Tab trigger fired); the card calls it before its own key handling.
// ============================================================================

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useMediaQuery } from "../../infra/lib/useMediaQuery.ts";
import { PathCompletion } from "./PathCompletion.tsx";
import { type CaretToken, isAutoOpenToken, isPathToken, tokenAtCaret } from "./pathToken.ts";

/** Debounce before the touch auto-open fires: long enough to clear a typing
 *  burst, short enough to feel immediate on a pause. */
const AUTO_OPEN_DEBOUNCE_MS = 300;

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

	const readToken = useCallback((): CaretToken | null => {
		const el = textareaRef.current;
		if (!el) return null;
		return tokenAtCaret(value, el.selectionStart);
	}, [value, textareaRef]);

	// Tab trigger. Includes the empty token (Tab on an empty line lists the cwd).
	const getPathPrefix = useCallback((): CaretToken | null => {
		const t = readToken();
		return t && isPathToken(t.token) ? t : null;
	}, [readToken]);

	// Touch auto-open trigger: stricter (see pathToken.ts).
	const getAutoPrefix = useCallback((): CaretToken | null => {
		const t = readToken();
		return t && isAutoOpenToken(t.token) ? t : null;
	}, [readToken]);

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

	// Touch: no Tab key, so open on a typing pause once the caret token is
	// path-like. The fetch runs even while the list is open: soft keyboards
	// that do not emit per-key keydowns never hit the close-on-character branch
	// in `handleKeyDown`, and refetching keeps the list in step with the prefix.
	const coarsePointer = useMediaQuery("(pointer: coarse)");
	useEffect(() => {
		if (!coarsePointer || value === "") return;
		const timer = setTimeout(() => {
			const el = textareaRef.current;
			if (!el || document.activeElement !== el) return;
			const info = getAutoPrefix();
			if (info) void fetchCompletions(info.token, info.start);
		}, AUTO_OPEN_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [value, coarsePointer, getAutoPrefix, fetchCompletions, textareaRef]);

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
					void fetchCompletions(pathInfo.token, pathInfo.start);
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

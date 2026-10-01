// LabelSlot — the user message's label affordance, one interaction for add,
// edit, and remove (TopBar-rename pattern, no popover): the rendered
// `#label` chip is the edit trigger; an unlabeled message shows a
// hover-revealed ghost chip as the add trigger; either swaps in place for
// an inline input — Enter commits, Escape/blur cancels, empty + Enter
// clears. Commit failures (verb rejected) keep the input open with its
// text; the store never changed, so nothing is lost.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "../../infra/net/useRpc.ts";
import { getStore } from "../../infra/state/store.tsx";
import { selectRenderDiverged } from "../../infra/state/ui.ts";
import styles from "./turns.module.css";

export const LabelSlot = memo(function LabelSlot({ entryId, label }: { entryId: string; label?: string }) {
	const setLabelRpc = useRpc().setLabel;
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);

	// Focus on mount of the editing state (autoFocus is banned by lint; the
	// TopBar rename input uses the same ref pattern).
	useEffect(() => {
		if (editing) inputRef.current?.focus();
	}, [editing]);

	const start = useCallback(() => {
		setValue(label ?? "");
		setEditing(true);
	}, [label]);

	const commit = useCallback(async () => {
		const trimmed = value.trim();
		if (trimmed === (label ?? "")) {
			setEditing(false); // unchanged — nothing to send
			return;
		}
		// The same guards as the other mutation paths: the peek lock (never
		// label a branch the reader is not looking at) and the in-flight lock
		// (the append lands at the session leaf). The daemon enforces both
		// anyway; checking here keeps the failure local instead of an error
		// toast after the fact.
		const s = getStore().getState();
		if (selectRenderDiverged(s)) {
			s.pushToast("label:peek", "Viewing another branch — back to live to edit");
			return;
		}
		if (s.document.status.isStreaming || s.document.status.isCompacting) {
			s.pushToast("label:busy", "Wait for the turn to finish");
			return;
		}
		const reply = await setLabelRpc(entryId, trimmed);
		if (reply?.ok) setEditing(false);
	}, [entryId, label, value, setLabelRpc]);

	if (editing) {
		return (
			<input
				ref={inputRef}
				className={styles.labelInput}
				value={value}
				spellCheck={false}
				placeholder="label"
				aria-label="Message label"
				onChange={(e) => setValue(e.target.value)}
				onBlur={() => setEditing(false)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						void commit();
					}
					if (e.key === "Escape") setEditing(false);
				}}
			/>
		);
	}
	if (label !== undefined) {
		return (
			<button type="button" className={styles.msgLabel} title={`${label} — click to edit`} onClick={start}>
				#{label}
			</button>
		);
	}
	return (
		<button type="button" className={styles.msgLabelGhost} title="Add label" onClick={start}>
			# label
		</button>
	);
});

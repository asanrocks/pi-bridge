// LabelSlot — the user turn's label chip and its editor (ADR 21).
//
// The chip stays the direct edit trigger, because a label is a value the reader
// recognizes turns by; the *add* affordance is gone from the header (a dashed
// ghost chip with no label was permanent header width spent on nothing), so
// creating one is a menu command instead.
//
// The editor is a bounded panel with Save and Cancel rather than an inline field
// swapped into the header. An inline input changed the header's width while it
// was open — the row the reader was aiming at moved under the pointer — and on a
// narrow column an unbounded field could not show the value it was editing.
// Enter commits, Escape and Cancel dismiss, and the peek/busy gates are the same
// ones every other mutation path applies, checked here so the failure stays
// local instead of arriving as a toast after the fact.

import { memo, type Ref, useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "../../infra/net/useRpc.ts";
import { getStore } from "../../infra/state/store.tsx";
import { selectRenderDiverged } from "../../infra/state/ui.ts";
import { Popover } from "../../render/Popover.tsx";
import styles from "./turns.module.css";

/** The rendered label. A value chip, not a verb: `msgLabel` is a declared
 *  control role (a label with its own geometry), which is why it takes no
 *  boundary. */
export const LabelChip = memo(function LabelChip({
	label,
	buttonRef,
	onOpen,
}: {
	label: string;
	buttonRef?: Ref<HTMLButtonElement>;
	onOpen: () => void;
}) {
	return (
		<button
			ref={buttonRef}
			type="button"
			className={styles.msgLabel}
			title={`${label} — click to edit`}
			onClick={onOpen}
		>
			#{label}
		</button>
	);
});

export const LabelEditor = memo(function LabelEditor({
	entryId,
	label,
	anchor,
	onClose,
}: {
	entryId: string;
	/** The current label, or undefined when creating one. */
	label: string | undefined;
	anchor: HTMLElement | null;
	onClose: () => void;
}) {
	const setLabelRpc = useRpc().setLabel;
	const [value, setValue] = useState(label ?? "");
	const inputRef = useRef<HTMLInputElement | null>(null);

	// Focus on mount (autoFocus is banned by lint; the TopBar rename input uses
	// the same ref pattern).
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const commit = useCallback(async () => {
		const trimmed = value.trim();
		if (trimmed === (label ?? "")) {
			onClose(); // unchanged — nothing to send
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
		if (reply?.ok) onClose();
	}, [entryId, label, value, setLabelRpc, onClose]);

	return (
		<Popover anchor={anchor} onClose={onClose} role="dialog" label="Message label" className={styles.labelPanel}>
			<div className={styles.labelBody}>
				<input
					ref={inputRef}
					className={styles.labelField}
					value={value}
					spellCheck={false}
					placeholder="label"
					aria-label="Message label"
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							void commit();
						}
					}}
				/>
				<div className={styles.labelActions}>
					<button type="button" className={styles.labelSave} onClick={() => void commit()}>
						Save
					</button>
					<button type="button" className={styles.labelCancel} onClick={onClose}>
						Cancel
					</button>
				</div>
			</div>
		</Popover>
	);
});

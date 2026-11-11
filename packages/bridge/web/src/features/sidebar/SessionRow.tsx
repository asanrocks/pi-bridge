// ============================================================================
// SessionRow — one sidebar leaf: location mark + name + time (recency, or the
// run clock while an execution is in flight) plus a status line: what a running
// execution is doing, or what an Inbox row last said — and the row menu.
//
// Two facts are kept apart, because conflating them was the confusion: the
// *location* (Inbox, Later, Archive — durable, the user's own classification)
// and *running* (a runtime attribute; see `session.activity`). A row can be
// Inbox and running, or Later and running, and moving it never pretends the
// execution ended.
//
// The menu is therefore shaped by the row's location rather than drawn as one
// uniform destination picker: it offers the directions open from here, in the
// words the user already has for them. Inbox ↔ Later is Park / Unpark
// (execution continues, so the label never mentions it), Archive is the resting
// place, and Unarchive returns to Later because reviving stale work is a
// decision, not a promotion — a submitted message is what returns a Session to
// Inbox. Trash sits below the divider: it takes the Session's address with it,
// so unlike every move above it, nothing can be reached afterwards.
//
// The stop a move performs is part of the label and only while an agent is
// running: "Stop and archive" describes what will happen to this row, where an
// idle Archive is a plain move and a detail line claiming otherwise would
// describe an action that is not performed. The same entries wear the menu's
// danger tone, so the stop reads before the press and not only after it.
//
// The list itself is the shared `AnchoredMenu` — one anatomy for every
// anchored action list, with the keyboard roam and focus return a hand-built
// list would have to reimplement. The menu's glyph is the overflow dots, never
// the hamburger: that one is the Sidebar's own disclosure, and this row's menu
// is not that menu.
// ============================================================================

import { memo, useRef, useState } from "react";
import type { SessionInfo, SessionLocation } from "../../../../src/core/index.ts";
import { formatWhenFull } from "../../infra/lib/time.ts";
import { useLabelClock } from "../../infra/lib/useNow.ts";
import { AnchoredMenu, type MenuItem } from "../../render/AnchoredMenu.tsx";
import { MoreIcon } from "../../render/icons.tsx";
import { ToolChip } from "../../render/ToolChip.tsx";
import { type ActivityLine, activityLine, activityLineTitle } from "./activityLine.ts";
import styles from "./Sidebar.module.css";
import { sessionTime } from "./sessionTime.ts";

/** One menu entry: what it says, and the location it moves the Session to. */
interface Move {
	key: string;
	label: string;
	/** The label while an agent is running and this move ends it. Absent on the
	 * moves that only reclassify, whose wording stays the same either way. */
	stopLabel?: string;
	location: SessionLocation;
}

const ARCHIVE: Move = {
	key: "archive",
	label: "Archive",
	stopLabel: "Stop and archive",
	location: "archive",
};

/** What the row's location offers, in menu order: the reversible reclassification
 * first, the resting place second. The location itself is never an entry: a
 * menu of moves cannot say "do nothing". */
const MOVES: Record<SessionLocation, readonly Move[]> = {
	inbox: [{ key: "park", label: "Park", location: "later" }, ARCHIVE],
	later: [{ key: "unpark", label: "Unpark", location: "inbox" }, ARCHIVE],
	archive: [{ key: "unarchive", label: "Unarchive", location: "later" }],
};

/** A row's mark, derived from the two independent facts. */
export function markOf(session: SessionInfo): "running" | "inbox" | "later" | "archive" {
	if (session.activity !== undefined) return "running";
	return session.location;
}

/** The row menu: the moves the Session's location leaves open, then Trash below
 * the divider. Labels say what happens now — "Stop and …" only on a running
 * row — so no entry needs a detail line to explain its cost, and the entries
 * that end something carry the danger tone. */
export function sessionMenuItems(
	session: Pick<SessionInfo, "location" | "activity">,
	onMove?: (location: SessionLocation) => void,
	onTrash?: () => void,
): MenuItem[] {
	const running = session.activity !== undefined;
	const items: MenuItem[] = [];
	if (onMove) {
		for (const move of MOVES[session.location]) {
			const stopLabel = running ? move.stopLabel : undefined;
			items.push({
				key: move.key,
				label: stopLabel ?? move.label,
				danger: stopLabel !== undefined,
				onSelect: () => onMove(move.location),
			});
		}
	}
	if (onTrash) {
		items.push({
			key: "trash",
			label: running ? "Stop and trash" : "Trash",
			separator: true,
			// Red even when idle: the press stops the agent unconditionally and takes
			// the Session's address with it, whatever the label has room to say.
			danger: true,
			onSelect: onTrash,
		});
	}
	return items;
}

export const SessionRow = memo(function SessionRow({
	session,
	selected,
	onOpen,
	onMove,
	onTrash,
	onMenuOpenChange,
}: {
	session: SessionInfo;
	/** Attached session ("you are here"): the one row wearing the accent
	 * tint. Matched on (projectId, stem) — rows always carry stems, so no
	 * sessionId fallback is needed. */
	selected?: boolean;
	onOpen: (session: SessionInfo) => void;
	/** The row menu's moves: what the row's location offers, including the stop
	 * an Archive of a running Session performs (the daemon owns that, not the
	 * row). No confirmation — a move is a classification. */
	onMove?: (session: SessionInfo, location: SessionLocation) => void;
	/** Present when the row offers Trash: ends the runtime, then moves the
	 * durable file out of discovery. Unconfirmed — the file survives. */
	onTrash?: (session: SessionInfo) => void;
	/** The menu's open state, for a host that is itself an anchored panel: the
	 * outer one must stand down from Escape while the inner menu owns it (see
	 * `Popover`'s `dismissOnEscape`). */
	onMenuOpenChange?: (open: boolean) => void;
}) {
	const label = (session.name || session.firstMessageText || session.stem) ?? "";
	const now = useLabelClock(session.activity !== undefined);
	const menuBtnRef = useRef<HTMLButtonElement>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const setMenu = (open: boolean) => {
		setMenuOpen(open);
		onMenuOpenChange?.(open);
	};
	const mark = markOf(session);
	const time = sessionTime(session, now);
	const dotCls = [
		styles.sidebarLiveDot,
		mark === "running"
			? styles.sidebarLiveDotStreaming
			: mark === "later"
				? styles.sidebarDotLater
				: mark === "archive"
					? styles.sidebarDotArchived
					: "",
	]
		.filter(Boolean)
		.join(" ");

	const items = sessionMenuItems(
		session,
		onMove ? (location) => onMove(session, location) : undefined,
		onTrash ? () => onTrash(session) : undefined,
	);

	// The working row's second line: what the agent is doing (running) or what
	// it last said (Inbox). Later and Archive rows stay one line — nothing is
	// owed there.
	const line: ActivityLine | null =
		mark === "running"
			? activityLine(session, now)
			: mark === "inbox"
				? { text: session.lastMessageText ?? "" }
				: null;
	// The row's own title is the precise instant: the trailing slot hands itself
	// to the menu button on hover, so a title on the timestamp itself is the one
	// thing the pointer can never reach. The name and the second line carry their
	// own, so hovering the row never merely repeats the name.
	const rowTitle = formatWhenFull(time.when);
	return (
		<div className={styles.sidebarItemWrap}>
			<button
				type="button"
				className={[styles.sidebarItem, selected ? styles.sidebarItemSelected : ""].filter(Boolean).join(" ")}
				onClick={() => onOpen(session)}
				title={rowTitle}
				aria-current={selected ? "page" : undefined}
			>
				<span className={dotCls} aria-hidden="true" />
				<span className={styles.sidebarItemText}>
					<span className={styles.sidebarItemRow}>
						<span className={styles.sidebarItemName} title={label}>
							{label.slice(0, 60)}
						</span>
						<time className={styles.sidebarItemTime} dateTime={time.when} title={formatWhenFull(time.when)}>
							{time.text}
						</time>
					</span>
					{line !== null && (line.tool !== undefined || line.text !== "") && (
						<span className={styles.sidebarItemStatus} title={activityLineTitle(line)}>
							{line.tool !== undefined && <ToolChip tool={line.tool} />}
							{line.text !== "" && <span className={styles.sidebarItemStatusText}>{line.text}</span>}
						</span>
					)}
				</span>
			</button>
			{items.length > 0 && (
				<button
					ref={menuBtnRef}
					type="button"
					className={styles.sidebarMenuBtn}
					aria-label="Session menu"
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					onClick={(e) => {
						e.stopPropagation();
						setMenu(!menuOpen);
					}}
				>
					<MoreIcon size={14} />
				</button>
			)}
			{menuOpen && items.length > 0 && (
				<AnchoredMenu
					anchor={menuBtnRef.current}
					items={items}
					label="Session menu"
					onClose={() => setMenu(false)}
				/>
			)}
		</div>
	);
});

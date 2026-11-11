// ============================================================================
// QueueRow — one row of the Launcher's queue: the location mark (overridden by
// running), name and Project, the state chips, the time slot, and the preview
// line.
//
// A component of its own because it owns the row's live clock: a running row
// counts its run in seconds, and only a row showing a live duration should
// re-render every second (see useNow.ts). The Launcher itself stays on the
// minute clock.
// ============================================================================

import { memo } from "react";
import type { SessionInfo } from "../../../../src/core/index.ts";
import { formatWhenFull } from "../../infra/lib/time.ts";
import { useLabelClock } from "../../infra/lib/useNow.ts";
import { useRpc } from "../../infra/net/useRpc.ts";
import { ToolChip } from "../../render/ToolChip.tsx";
import { type ActivityLine, activityLine, activityLineTitle } from "../sidebar/activityLine.ts";
import { sessionTime } from "../sidebar/sessionTime.ts";
import styles from "./Launcher.module.css";

export const QueueRow = memo(function QueueRow({ session }: { session: SessionInfo }) {
	const rpc = useRpc();
	// Two independent facts: running overrides the location mark.
	const running = session.activity !== undefined;
	const now = useLabelClock(running);
	const label = session.name || session.firstMessageText || session.stem;
	// A running row says what it is doing; otherwise preview the latest message,
	// falling back to the first when the copy only has one (or the file scan
	// predates the field).
	const preview = session.lastMessageText ?? session.firstMessageText ?? "";
	const line: ActivityLine | null = running ? activityLine(session, now) : preview === "" ? null : { text: preview };
	const time = sessionTime(session, now);
	// The row's own title is the precise instant, as on the sidebar rail: the name
	// and the preview carry their own, and a row-wide tooltip that merely repeats
	// the name says nothing.
	const rowTitle = formatWhenFull(time.when);
	const dotCls = [styles.dot, running ? styles.dotStreaming : session.location === "later" ? styles.dotLater : ""]
		.filter(Boolean)
		.join(" ");
	return (
		<div className={styles.row}>
			<span className={dotCls} aria-hidden="true" />
			<button
				type="button"
				className={styles.rowMain}
				onClick={() => rpc.openSession(session.projectId, session.stem, session.sessionId)}
				title={rowTitle}
			>
				<div className={styles.rowLine1}>
					<span className={styles.rowName} title={label}>
						{label}
					</span>
					<span className={styles.rowCwd} title={session.stem}>
						<bdi>{session.projectId}</bdi>
					</span>
					{running && <span className={styles.streaming}>running</span>}
					{session.location === "later" && <span className={styles.later}>later</span>}
					<time className={styles.rowTime} dateTime={time.when} title={formatWhenFull(time.when)}>
						{time.text}
					</time>
				</div>
				{line !== null && (
					<div className={styles.rowPreview} title={activityLineTitle(line)}>
						{line.tool !== undefined && <ToolChip tool={line.tool} />}
						{line.text !== "" && <span className={styles.rowPreviewText}>{line.text}</span>}
					</div>
				)}
			</button>
		</div>
	);
});

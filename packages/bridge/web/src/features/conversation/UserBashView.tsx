// UserBashView — a user-initiated shell execution (`! command`) as a
// standalone turn between user/assistant turns. The same frameless expanded
// content as the tool cards: status line (light + exit/cancelled/truncated
// chips) in the upper chrome, the output as the content region below the
// divider. The tinted row keeps the bash hue but the `$` prompt marks it as the
// user's own run (not the agent's); `!!` runs (excluded from context) render
// muted.

import { memo, useCallback, useMemo } from "react";
import type { UserBashTurn } from "../../../../src/viewmodel/index.ts";
import { useStore } from "../../infra/state/store.tsx";
import styles from "./actions.module.css";
import { CardControls, CardStatusLine, TruncationNotice } from "./tools/CardSkeleton.tsx";
import { BASH_TAIL_LINES } from "./tools/resultText.ts";
import { sanitizeOutputText } from "./tools/sanitize.ts";
import turnStyles from "./turns.module.css";

export const UserBashView = memo(function UserBashView({ turn }: { turn: UserBashTurn }) {
	const actionKey = `${turn.entryId}:b0`;
	const wrap = useStore((s) => s.cardWrap);
	const toggleCardWrap = useStore((s) => s.toggleCardWrap);
	const toggleCardMarkdown = useStore((s) => s.toggleCardMarkdown);
	// Tail-vs-full cap (same store key the top-bar "show all" control
	// flips); line-count-based like the tool bash card — no scroll window.
	const isUncapped = useStore(useCallback((s) => s.uncappedDetails.has(actionKey), [actionKey]));
	const toggleUncap = useStore((s) => s.toggleUncapDetails);

	const output = useMemo(() => sanitizeOutputText(turn.output), [turn.output]);
	const lineCount = output ? output.split("\n").length : 0;
	const capped = isUncapped ? "uncapped" : lineCount > BASH_TAIL_LINES ? "capped" : "none";
	const showTail = capped === "capped";
	const status = turn.exitCode !== null && turn.exitCode !== 0 ? "error" : "done";
	const chips = useMemo(() => {
		const list: Array<{ text: string; tone: "error" | "warning" }> = [];
		if (turn.exitCode !== null && turn.exitCode !== 0) list.push({ text: `exit ${turn.exitCode}`, tone: "error" });
		if (turn.cancelled) list.push({ text: "cancelled", tone: "error" });
		if (turn.truncated) list.push({ text: "truncated", tone: "warning" });
		if (turn.excludeFromContext) list.push({ text: "not in context", tone: "warning" });
		return list;
	}, [turn.exitCode, turn.cancelled, turn.truncated, turn.excludeFromContext]);

	return (
		<div className={turnStyles.userBashTurn}>
			<div className={styles.action} data-kind="bash" data-muted={turn.excludeFromContext || undefined}>
				<div className={styles.actionHead}>
					<span className={turnStyles.userBashPrompt}>$</span>
					<span className={styles.actionSummary}>{turn.command}</span>
				</div>
				<div className={styles.detailsCard}>
					<div className={styles.cardBar}>
						<CardStatusLine status={status} timing={null} timeout={null} chips={chips} />
						<CardControls
							copyText={output || null}
							showWrap
							wrap={wrap}
							showMarkdown={false}
							markdown={false}
							capped={capped}
							onToggleWrap={toggleCardWrap}
							onToggleMarkdown={toggleCardMarkdown}
							onToggleCap={() => toggleUncap(actionKey)}
						/>
					</div>
					<div className={styles.actionDetailsWrap}>
						{/* No max-height cap: the middle state is the tail slice, and
						    "show all" means the whole output (line-count cap, not a
						    scroll window). */}
						<div className={styles.actionDetails} style={{ maxHeight: "none" }}>
							{output && (
								<div className={styles.cardBody}>
									{showTail && (
										<div
											className={styles.outputHint}
										>{`… ${lineCount - BASH_TAIL_LINES} earlier line${lineCount - BASH_TAIL_LINES === 1 ? "" : "s"}`}</div>
									)}
									<div className={styles.cardOutput} data-wrap={wrap || undefined}>
										{(showTail ? output.split("\n").slice(-BASH_TAIL_LINES) : output.split("\n")).map(
											(line, i) => (
												// biome-ignore lint/suspicious/noArrayIndexKey: output lines have no stable id
												<div key={i} className={styles.outputLine}>
													{line}
												</div>
											),
										)}
									</div>
									{turn.truncated && (
										<TruncationNotice notice="output saved to file" fullPath={turn.fullOutputPath} />
									)}
								</div>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
});

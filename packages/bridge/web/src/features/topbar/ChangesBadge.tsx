// ============================================================================
// ChangesBadge — the TopBar's dirty-now indicator: how many files differ from
// HEAD in the attached session's Project worktree. Sampled when a turn settles
// (never per streamed entry) and by hand, mirroring the retired Changes tab's
// discipline; hidden while clean or unavailable. Click opens the review menu.
//
// It is the one git surface that makes no turn attribution, which is why the
// live worktree comparison lives here rather than on any single turn: dirt
// from several trailing turns is indistinguishable now, so a turn-anchored
// count would be a lie.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import type { GitDiffFileStat } from "../../../../src/core/index.ts";
import { gitDiffRpc } from "../../infra/net/useRpc.ts";
import { useStore } from "../../infra/state/store.tsx";
import { AnchoredMenu, type MenuItem } from "../../render/AnchoredMenu.tsx";
import styles from "./TopBar.module.css";

type Uncommitted =
	| { status: "idle" }
	| { status: "ok"; stem: string; count: number; omitted: number; asOf: string }
	| { status: "unavailable" };

export function ChangesBadge() {
	const openDiffView = useStore((s) => s.openDiffView);
	const currentStem = useStore((s) => s.currentStem);
	const projectCwd = useStore((s) => s.projects.find((p) => p.id === s.currentProjectId)?.cwd ?? null);
	const leafId = useStore((s) => s.document.status.leafId);
	const isStreaming = useStore((s) => s.document.status.isStreaming);
	const [state, setState] = useState<Uncommitted>({ status: "idle" });
	const [menu, setMenu] = useState<DOMRect | null>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	// Last-write-wins for overlapping refreshes. Cross-session staleness is
	// covered by the currentStem guard in the request.
	const requestRef = useRef(0);

	// The `_trigger` parameter exists so the settle effect below can list the
	// leaf id as a dependency (it re-samples on every turn settle); the value
	// itself is unused.
	const fetchCount = useCallback(
		async (_trigger: string | null) => {
			if (currentStem === null || projectCwd === null) return;
			const request = ++requestRef.current;
			const reply = await gitDiffRpc(projectCwd, "head", "worktree");
			if (request !== requestRef.current) return;
			if (reply === null) {
				setState({ status: "unavailable" });
				return;
			}
			const files = (reply.files as GitDiffFileStat[] | undefined) ?? [];
			const omitted = reply.untrackedOmitted ?? 0;
			setState({
				status: "ok",
				stem: currentStem,
				count: files.length + omitted,
				omitted,
				asOf: new Date().toISOString(),
			});
		},
		[currentStem, projectCwd],
	);

	useEffect(() => {
		if (isStreaming) return;
		void fetchCount(leafId);
	}, [fetchCount, leafId, isStreaming]);

	// A count read for a different session is hidden until this session's fetch
	// lands, so a switch cannot show the previous worktree's dirt.
	if (state.status !== "ok" || state.count === 0 || state.stem !== currentStem) return null;

	const omittedNote = state.omitted > 0 ? ` (+${state.omitted} untracked omitted)` : "";
	const items: MenuItem[] = [
		{
			key: "review",
			label: `Review ${state.count} uncommitted file${state.count === 1 ? "" : "s"}`,
			detail: `HEAD → working tree${omittedNote}`,
			onSelect: () => openDiffView({ old: "head", new: "worktree" }, "Uncommitted changes"),
		},
	];

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				className={styles.changesBadge}
				onClick={() => setMenu(buttonRef.current?.getBoundingClientRect() ?? null)}
				aria-haspopup="menu"
				aria-expanded={menu !== null}
				aria-label={`${state.count} uncommitted file${state.count === 1 ? "" : "s"}`}
				title={`${state.count} file${state.count === 1 ? "" : "s"} differ from HEAD — as of ${state.asOf}`}
			>
				{"Δ "}
				{state.count}
				{" ▾"}
			</button>
			{menu && (
				<AnchoredMenu
					anchor={menu}
					items={items}
					onClose={() => setMenu(null)}
					align="end"
					label="Uncommitted changes"
				/>
			)}
		</>
	);
}

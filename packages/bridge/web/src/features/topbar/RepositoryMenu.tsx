// RepositoryMenu — the TopBar's project-files control: one menu for the rendered
// Project's worktree, present whenever a Project is (session or Project home).
// It is the chrome entry to the file browser, and it cannot be gated on git
// state: a clean worktree or a Project that is not a git repository would then
// have no way in. Only the review row and the count chip depend on the read —
// files differing from HEAD, sampled on address change and when a turn settles
// (never per streamed entry), shown only while non-zero.
//
// The control is turn-agnostic by design: dirt from several trailing turns is
// indistinguishable now, so attributing it to any one turn would be a lie. The
// folder mark, not the branch mark, because the menu's object is the Project's
// files; the count carries the git fact.

import { useCallback, useEffect, useRef, useState } from "react";
import type { GitDiffFileStat } from "../../../../src/core/index.ts";
import { formatWhenFull } from "../../infra/lib/time.ts";
import { gitDiffRpc } from "../../infra/net/useRpc.ts";
import { useStore } from "../../infra/state/store.tsx";
import { lastBrowsedFile } from "../../infra/state/ui.ts";
import { AnchoredMenu, type MenuItem } from "../../render/AnchoredMenu.tsx";
import { FolderIcon } from "../../render/icons.tsx";
import { repositoryMenuRows } from "./repositoryMenuRows.ts";
import styles from "./TopBar.module.css";

/** A worktree sample, tagged with the Project it describes: a read made for
 * another cwd is not this Project's dirt. */
type Sample =
	| { status: "idle" }
	| { status: "ok"; cwd: string; count: number; omitted: number; asOf: string }
	| { status: "unavailable"; cwd: string };

export function RepositoryMenu() {
	const projectCwd = useStore((s) => s.projects.find((p) => p.id === s.currentProjectId)?.cwd ?? null);
	const leafId = useStore((s) => s.document.status.leafId);
	const isStreaming = useStore((s) => s.document.status.isStreaming);
	const openBrowser = useStore((s) => s.openBrowser);
	const openDiffView = useStore((s) => s.openDiffView);
	/** The Project's last read file: the browse row resumes it, and its own root
	 * (a file outside the Project keeps that file's directory). */
	const remembered = useStore(lastBrowsedFile);
	const [sample, setSample] = useState<Sample>({ status: "idle" });
	const [menuOpen, setMenuOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	// Last-write-wins for overlapping reads; the cwd tag covers cross-Project
	// staleness at render.
	const requestRef = useRef(0);

	const fetchCount = useCallback(
		async (_trigger: string | null) => {
			if (projectCwd === null) return;
			const request = ++requestRef.current;
			const reply = await gitDiffRpc(projectCwd, "head", "worktree");
			if (request !== requestRef.current) return;
			if (reply === null) {
				setSample({ status: "unavailable", cwd: projectCwd });
				return;
			}
			const files = (reply.files as GitDiffFileStat[] | undefined) ?? [];
			const omitted = reply.untrackedOmitted ?? 0;
			setSample({
				status: "ok",
				cwd: projectCwd,
				count: files.length + omitted,
				omitted,
				asOf: new Date().toISOString(),
			});
		},
		[projectCwd],
	);

	// Mount, Project change (`fetchCount` identity), and turn settle. A streaming
	// turn is not a sample point — its entries are still moving.
	useEffect(() => {
		if (isStreaming) return;
		void fetchCount(leafId);
	}, [fetchCount, leafId, isStreaming]);

	// No Project is rendered (the Launcher): there is nothing to browse, and the
	// History clock hides there for the same reason.
	if (projectCwd === null) return null;

	const dirt = sample.status === "ok" && sample.cwd === projectCwd ? sample : null;
	const changed = dirt?.count ?? 0;
	// The count chip is state, not the control's identity: absent when clean, and
	// absent when the worktree cannot be read — never a `0`.
	const count = changed > 0 ? changed : null;
	const rows = repositoryMenuRows(dirt === null ? null : { count: dirt.count, omitted: dirt.omitted });
	const items: MenuItem[] = rows.map((row) =>
		row.key === "review"
			? {
					...row,
					onSelect: () => openDiffView({ old: "head", new: "worktree" }, "Uncommitted changes"),
				}
			: {
					...row,
					onSelect: () =>
						openBrowser({
							root: remembered?.root ?? projectCwd,
							path: remembered?.path,
							state: "worktree",
							tree: "all",
							presentation: "file",
						}),
				},
	);

	const files = count === null ? "" : ` ${count} uncommitted file${count === 1 ? "" : "s"}`;
	const title =
		dirt === null
			? "Browse this Project's files"
			: `${count === null ? "No files differ" : `${count} file${count === 1 ? " differs" : "s differ"}`} from HEAD — as of ${formatWhenFull(dirt.asOf)}`;

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				className={styles.repositoryMenu}
				onClick={() => setMenuOpen((open) => !open)}
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				aria-label={`Project files${files}`}
				title={title}
			>
				{/* Sized by the row's slot (20, like every other TopBar mark), not by
				    the count's meta step — the slot follows the row. */}
				<FolderIcon size={20} />
				{count}
			</button>
			{menuOpen && (
				<AnchoredMenu
					anchor={buttonRef.current}
					items={items}
					onClose={() => setMenuOpen(false)}
					align="end"
					label="Project files"
				/>
			)}
		</>
	);
}

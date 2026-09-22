// ============================================================================
// FileBrowser — the one repository browser (ADR 14), in the FileViewer's
// fullscreen portal role (mounted once in App; Escape / ✕ / backdrop close;
// read-only).
//
// Left: a file tree. Right: file content. One target (`BrowserTarget` in the
// ui slice) drives both, so every entry point — a markdown link, a tool card,
// a git-stamp window, a commit card — opens the same surface:
//
//   • `tree: "all"` lists directories lazily, one level per expansion
//     (`listDirectory`), with change markers overlaid when a baseline exists.
//   • `tree: "changed"` comes from the diff directive, never from walking the
//     repository and filtering it client-side.
//   • `presentation: "file"` shows the selected file at `state`
//     (`FileContent`), with an optional baseline diff toggle.
//   • `presentation: "review"` stacks the changed files' diffs, lazily — one
//     payload pair per section, diffed in the client by the conversation's
//     shared `DiffSections` renderer.
//
// The target is a selector, not a snapshot: every open and every state change
// refetches. Worktree-derived results carry an "as of" time and a Refresh
// control; commit-addressed content is immutable and needs neither.
// ============================================================================

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DirectoryEntry, GitDiffFileStat, GitDiffFileStatus, SnapshotFile } from "../../../../src/core/index.ts";
import { isUnder, parentDirectory } from "../../infra/lib/paths.ts";
import { formatTimestamp } from "../../infra/lib/time.ts";
import { useMediaQuery } from "../../infra/lib/useMediaQuery.ts";
import { gitDiffRpc, listDirectoryRpc, readFileRpc } from "../../infra/net/useRpc.ts";
import { useStore } from "../../infra/state/store.tsx";
import { useViewModel } from "../../infra/state/useViewModel.ts";
import { FileContent } from "../../render/FileContent.tsx";
import { extToLang } from "../conversation/tools/args.ts";
import { DiffSections } from "../conversation/tools/DiffSections.tsx";
import { browserHeading } from "./browserHeading.ts";
import { type SectionRect, sectionKey, visibleSectionKey } from "./browserSections.ts";
import { buildChangedTree, buildDirectoryTree } from "./browserTree.ts";
import { CompareMenu } from "./CompareMenu.tsx";
import { collectDiffStates, isPinnedCommit } from "./diffStates.ts";
import styles from "./FileBrowser.module.css";
import { FileTree, type TreeNode } from "./FileTree.tsx";
import { StatePicker } from "./StatePicker.tsx";
import viewerStyles from "./Viewer.module.css";

/** The diff directive's state. */
type Directive =
	| { status: "loading" }
	| { status: "error"; message: string }
	| {
			status: "open";
			files: GitDiffFileStat[];
			filesOmitted: number;
			untrackedOmitted: number;
			asOf: string;
	  };

/** One section's fetched pair, diffed in the client. */
type Payload =
	| { status: "loading" }
	| { status: "error" }
	| { status: "too-large" }
	| { status: "binary" }
	| { status: "ready"; oldText: string; newText: string };

/** The file pane's content at the target state. */
type FilePane =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "absent"; label: string }
	| { status: "binary"; label: string; bytes: number }
	| { status: "open"; content: string; truncated: boolean; path: string; label: string };

/** A section's whole-file view (the `state` end of the pair). */
type FileView =
	| { status: "loading" }
	| { status: "error" }
	| { status: "absent"; label: string }
	| { status: "binary"; label: string }
	| { status: "open"; path: string; content: string; truncated: boolean; label: string };

/** Human label for one repository state. */
function stateLabel(state: string): string {
	if (state === "worktree") return "working tree";
	if (state === "head") return "HEAD";
	if (state === "index") return "index";
	return state.slice(0, 8);
}

/** Content of one fetched side, or null when it cannot be diffed (binary or
 * truncated). An absent side is the empty text (a whole-file add or delete). */
function sideText(file: SnapshotFile): string | null {
	if (file.kind === "absent") return "";
	if (file.kind === "binary") return null;
	if (file.truncated) return null;
	return file.content;
}

function formatCounts(f: GitDiffFileStat): { add: string; del: string } {
	if (f.binary) return { add: "bin", del: "" };
	return { add: `+${f.additions}`, del: `−${f.deletions}` };
}

/** Context lines with "Expand all lines" off; effectively unlimited on. */
const CONTEXT_LINES = 3;
/** The "expanded" sentinel for DiffSections' contextLines prop. */
const ALL_LINES = 1_000_000;

export const FileBrowser = memo(function FileBrowser() {
	const browser = useStore((s) => s.browser);
	const closeBrowser = useStore((s) => s.closeBrowser);
	const openBrowser = useStore((s) => s.openBrowser);
	const adoptBrowserPath = useStore((s) => s.adoptBrowserPath);
	const cardWrap = useStore((s) => s.cardWrap);
	// The settle signal (leafId) and the streaming flag: a worktree-valued target
	// refetches when a turn settles, never per streamed entry.
	const leafId = useStore((s) => s.document.status.leafId);
	const isStreaming = useStore((s) => s.document.status.isStreaming);
	const vm = useViewModel();
	const states = useMemo(() => collectDiffStates(vm.turns), [vm.turns]);
	// The app's pane-topology breakpoint (the Sidebar and History panes, the
	// index.css mobile block), so the tree drawer lands exactly where the other
	// panes change shape instead of at a fourth, browser-local width.
	const narrow = !useMediaQuery("(min-width: 768px)");
	// The attached session's identity: a reply that lands after an address
	// change must be dropped, not rendered under the new session's header. The
	// store also closes the portal on that change.
	const sessionKey = useStore((s) => `${s.currentProjectId ?? ""}\u0000${s.currentStem ?? ""}`);
	const sessionKeyRef = useRef(sessionKey);
	sessionKeyRef.current = sessionKey;

	// Primitive target fields, so the effects below can depend on values rather
	// than on the target object's identity.
	const root = browser?.root ?? "";
	const state = browser?.state ?? "worktree";
	const baseline = browser?.baseline;
	const treeMode = browser?.tree ?? "all";
	const presentation = browser?.presentation ?? "file";
	const selectedPath = browser?.path;
	const line = browser?.line;

	const [directive, setDirective] = useState<Directive>({ status: "loading" });
	const [dirs, setDirs] = useState<Map<string, DirectoryEntry[]>>(new Map());
	// Directories whose listing failed. Kept apart from `dirs` (a failed listing
	// leaves no entry) so the node stays expandable — the next toggle retries —
	// and the tree can report the failure instead of showing an empty directory.
	const [dirErrors, setDirErrors] = useState<Set<string>>(new Set());
	const [treeExpanded, setTreeExpanded] = useState<Set<string>>(new Set());
	// The changed tree's children are prebuilt, so it tracks the inverse: the
	// directories the user collapsed. One set per scope keeps each semantic
	// obvious rather than overloading one with two meanings.
	const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
	const [filePane, setFilePane] = useState<FilePane>({ status: "loading" });
	const [fileDiff, setFileDiff] = useState<Payload | null>(null);
	const [payloads, setPayloads] = useState<Map<string, Payload>>(new Map());
	const [fileViews, setFileViews] = useState<Map<string, FileView>>(new Map());
	const [sectionsOpen, setSectionsOpen] = useState<Set<string>>(new Set());
	const [expandAllLines, setExpandAllLines] = useState(false);
	const [diffMode, setDiffMode] = useState(false);
	const [treeOpen, setTreeOpen] = useState(true);
	// The section the viewport is reading (review presentation): the tree
	// highlight follows it. Kept local — it is a scroll position, not a target.
	const [visibleSection, setVisibleSection] = useState<string | null>(null);
	const requestRef = useRef(0);
	const contentRef = useRef<HTMLDivElement>(null);
	// Section payloads with a fetch in flight, so the approach prefetch and a
	// click in the same frame cannot request the same pair twice.
	const inflightSections = useRef<Set<string>>(new Set());
	// Last leaf this browser refreshed for at settle; a leaf move is what makes a
	// worktree-valued view stale.
	const settleRef = useRef<string | null>(leafId);

	// The tree collapses into a drawer on narrow viewports; it does not sit as
	// an empty column. Widening restores it.
	useEffect(() => {
		setTreeOpen(!narrow);
	}, [narrow]);

	const fetchDirective = useCallback(async (dir: string, base: string, head: string, request: number) => {
		const key = sessionKeyRef.current;
		const reply = await gitDiffRpc(dir, base, head);
		if (request !== requestRef.current || key !== sessionKeyRef.current) return;
		if (reply === null) {
			setDirective({
				status: "error",
				message:
					dir === ""
						? "Diff not available — the browser has no directory to scope it to."
						: "Diff not available — the recorded commits may no longer be reachable.",
			});
			return;
		}
		setDirective({
			status: "open",
			files: reply.files ?? [],
			filesOmitted: reply.filesOmitted ?? 0,
			untrackedOmitted: reply.untrackedOmitted ?? 0,
			asOf: new Date().toISOString(),
		});
	}, []);

	const fetchDirectory = useCallback(async (dir: string, at: string, request: number) => {
		const key = sessionKeyRef.current;
		const listing = await listDirectoryRpc(dir, at);
		if (request !== requestRef.current || key !== sessionKeyRef.current) return;
		setDirs((m) => {
			const next = new Map(m);
			if (listing === null) next.delete(dir);
			else next.set(dir, listing.absent ? [] : listing.entries);
			return next;
		});
		setDirErrors((prev) => {
			const next = new Set(prev);
			if (listing === null) next.add(dir);
			else next.delete(dir);
			return next;
		});
	}, []);

	const fetchFilePane = useCallback(
		async (path: string, at: string, request: number) => {
			const key = sessionKeyRef.current;
			const label = stateLabel(at);
			setFilePane({ status: "loading" });
			const file = await readFileRpc(path, at);
			if (request !== requestRef.current || key !== sessionKeyRef.current) return;
			if (file === null) {
				setFilePane({ status: "error", message: "Not connected" });
			} else if (file.path !== path) {
				// The host owns HOME and expands a `~`-rooted target; adopt the resolved
				// absolute path so the tree's node keys and the file header agree. The
				// path change re-runs this read, so the unresolved reply must not also
				// write the pane.
				adoptBrowserPath(path, file.path);
				return;
			} else if (file.kind === "absent") {
				setFilePane({ status: "absent", label });
			} else if (file.kind === "binary") {
				setFilePane({ status: "binary", label, bytes: file.bytes });
			} else {
				setFilePane({ status: "open", content: file.content, truncated: file.truncated, path: file.path, label });
			}
		},
		[adoptBrowserPath],
	);

	const fetchFileDiff = useCallback(async (path: string, base: string, head: string, request: number) => {
		const key = sessionKeyRef.current;
		setFileDiff({ status: "loading" });
		const [oldSide, newSide] = await Promise.all([readFileRpc(path, base), readFileRpc(path, head)]);
		if (request !== requestRef.current || key !== sessionKeyRef.current) return;
		if (oldSide === null || newSide === null) {
			setFileDiff({ status: "error" });
			return;
		}
		const oldText = sideText(oldSide);
		const newText = sideText(newSide);
		if (oldText === null || newText === null) {
			setFileDiff({ status: "too-large" });
			return;
		}
		setFileDiff({ status: "ready", oldText, newText });
	}, []);

	const fetchSectionPayload = useCallback(async (file: GitDiffFileStat, dir: string, base: string, head: string) => {
		// Every section-scoped key is the file's absolute path — the same form a
		// tree node carries, so a tree click and its section address one thing.
		const abs = sectionKey(dir, file.path);
		if (inflightSections.current.has(abs)) return;
		inflightSections.current.add(abs);
		try {
			const request = requestRef.current;
			const key = sessionKeyRef.current;
			setPayloads((m) => new Map(m).set(abs, { status: "loading" }));
			if (file.binary) {
				setPayloads((m) => new Map(m).set(abs, { status: "binary" }));
				return;
			}
			const oldSide: SnapshotFile | null = file.untracked
				? { kind: "absent", state: base, path: abs }
				: await readFileRpc(sectionKey(dir, file.oldPath ?? file.path), base);
			const newSide = await readFileRpc(abs, head);
			if (request !== requestRef.current || key !== sessionKeyRef.current) return;
			if (oldSide === null || newSide === null) {
				setPayloads((m) => new Map(m).set(abs, { status: "error" }));
				return;
			}
			const oldText = sideText(oldSide);
			const newText = sideText(newSide);
			if (oldText === null || newText === null) {
				setPayloads((m) => new Map(m).set(abs, { status: "too-large" }));
				return;
			}
			setPayloads((m) => new Map(m).set(abs, { status: "ready", oldText, newText }));
		} finally {
			inflightSections.current.delete(abs);
		}
	}, []);

	// Target change: a new root, state, or baseline is a different read, so
	// everything scoped to the old one resets and reloads. The deps are the
	// primitive values, not the target object: a selection change must not
	// re-scope (and so reset) the browser. `treeMode` is deliberately not a dep —
	// switching tree scope reuses the loaded tree and keeps the review's open
	// sections and view toggles.
	const isOpen = browser !== null;
	useEffect(() => {
		if (!isOpen) {
			requestRef.current++;
			return;
		}
		const request = ++requestRef.current;
		setDirs(new Map());
		setDirErrors(new Set());
		setTreeExpanded(new Set());
		setCollapsedDirs(new Set());
		setPayloads(new Map());
		setFileViews(new Map());
		setSectionsOpen(new Set());
		setVisibleSection(null);
		setExpandAllLines(false);
		setDiffMode(false);
		setFileDiff(null);
		if (baseline === undefined) {
			setDirective({
				status: "open",
				files: [],
				filesOmitted: 0,
				untrackedOmitted: 0,
				asOf: new Date().toISOString(),
			});
		} else {
			setDirective({ status: "loading" });
			void fetchDirective(root, baseline, state, request);
		}
		// The root listing always loads, so a review target can switch to the
		// full tree without a second round trip.
		if (root !== "") void fetchDirectory(root, state, request);
	}, [root, state, baseline, isOpen, fetchDirective, fetchDirectory]);

	const files = directive.status === "open" ? directive.files : [];

	// Section key → directive record, for the approach prefetch (below): the DOM
	// reports a section's key, and the payload fetch needs the file behind it.
	const fileBySection = useMemo(() => {
		const map = new Map<string, GitDiffFileStat>();
		for (const file of files) map.set(sectionKey(root, file.path), file);
		return map;
	}, [files, root]);

	// The one reread of a worktree-valued target: the Refresh control and the
	// turn-settle effect share it, so they cannot diverge. Open sections are
	// refetched rather than dropped — a cleared payload would strand an open
	// section on "Loading…" because its expand handler no longer fires. The
	// whole-file views fall back to the (refetched) diff.
	const refresh = useCallback(() => {
		const request = ++requestRef.current;
		if (baseline !== undefined) void fetchDirective(root, baseline, state, request);
		if (root !== "") void fetchDirectory(root, state, request);
		if (selectedPath !== undefined) void fetchFilePane(selectedPath, state, request);
		// The file presentation's diff is a second read of the same path, so a
		// refetch must cover it too — otherwise a settled turn leaves a stale diff
		// on screen until the diff toggle is cycled.
		if (diffMode && baseline !== undefined && selectedPath !== undefined) {
			void fetchFileDiff(selectedPath, baseline, state, request);
		}
		if (baseline !== undefined) {
			for (const file of files) {
				const sectionId = sectionKey(root, file.path);
				// Only payloads that have loaded are reread. A section that was opened
				// but never fetched (an `Expand files` far below the viewport) stays
				// unfetched, so the approach prefetch reads it fresh instead of a refresh
				// fanning out one pair per changed file.
				if (sectionsOpen.has(sectionId) && payloads.has(sectionId)) {
					void fetchSectionPayload(file, root, baseline, state);
				}
			}
		}
		setFileViews(new Map());
	}, [
		root,
		state,
		baseline,
		selectedPath,
		files,
		sectionsOpen,
		payloads,
		diffMode,
		fetchDirective,
		fetchDirectory,
		fetchFilePane,
		fetchFileDiff,
		fetchSectionPayload,
	]);

	// Turn settle: the worktree is the one state a running agent changes under
	// the view, so a worktree-valued target refetches when the leaf moves and the
	// turn is no longer streaming. Commit-addressed content is immutable and
	// needs nothing; the first render for a target is already loaded above.
	useEffect(() => {
		if (!isOpen || isStreaming) return;
		if (settleRef.current === leafId) return;
		settleRef.current = leafId;
		if (state !== "worktree" && baseline !== "worktree") return;
		refresh();
	}, [leafId, isStreaming, isOpen, state, baseline, refresh]);

	// File selection (or state change): read the file.
	useEffect(() => {
		if (!isOpen || selectedPath === undefined) return;
		void fetchFilePane(selectedPath, state, requestRef.current);
	}, [selectedPath, state, isOpen, fetchFilePane]);

	// The file presentation's baseline diff is opt-in.
	useEffect(() => {
		if (!diffMode || baseline === undefined || selectedPath === undefined) return;
		void fetchFileDiff(selectedPath, baseline, state, requestRef.current);
	}, [diffMode, selectedPath, baseline, state, fetchFileDiff]);

	// A `path:98` / `#L98` anchor scrolls to its line. The line elements exist
	// only once shiki's highlighted result has rendered (the pre-load fallback
	// is plain text), so retry across frames for a bounded window.
	useEffect(() => {
		if (!isOpen || line === undefined || filePane.status !== "open") return;
		const container = contentRef.current;
		if (container === null) return;
		const deadline = Date.now() + 2000;
		let raf = 0;
		const seek = () => {
			const el = container.querySelector(`[data-line="${line}"]`);
			if (el) {
				el.scrollIntoView({ block: "center" });
				return;
			}
			if (Date.now() < deadline) raf = requestAnimationFrame(seek);
		};
		raf = requestAnimationFrame(seek);
		return () => cancelAnimationFrame(raf);
	}, [isOpen, line, filePane.status]);

	// A file link can point deep into the tree: expand and load its ancestors
	// so the selection is visible where it lives.
	useEffect(() => {
		if (!isOpen || treeMode !== "all" || root === "" || selectedPath === undefined) return;
		if (!isUnder(root, selectedPath)) return;
		const ancestors: string[] = [];
		for (let dir = parentDirectory(selectedPath); dir !== root && isUnder(root, dir); dir = parentDirectory(dir)) {
			ancestors.push(dir);
		}
		if (ancestors.length === 0) return;
		setTreeExpanded((prev) => {
			const next = new Set(prev);
			for (const dir of ancestors) next.add(dir);
			return next;
		});
		for (const dir of ancestors) void fetchDirectory(dir, state, requestRef.current);
	}, [selectedPath, root, treeMode, state, isOpen, fetchDirectory]);

	useEffect(() => {
		if (!isOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") closeBrowser();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [isOpen, closeBrowser]);

	// Review: clicking a tree file scrolls to and opens its section. Section and
	// node share the absolute key, so `selectedPath` addresses the section.
	useEffect(() => {
		if (presentation !== "review" || selectedPath === undefined) return;
		setSectionsOpen((s) => (s.has(selectedPath) ? s : new Set(s).add(selectedPath)));
		const section = contentRef.current?.querySelector(`[data-section="${CSS.escape(selectedPath)}"]`);
		section?.scrollIntoView({ block: "start" });
	}, [selectedPath, presentation]);

	// The tree follows the viewport and an open section fetches its payload as it
	// approaches: the highlighted node is the section being read, and
	// `Expand files` loads diffs on approach instead of one click at a time.
	// Positions are DOM reads, so the handler is rAF-throttled; the effect re-runs
	// as payloads land, which fetches the next batch inside the window.
	useEffect(() => {
		if (presentation !== "review" || baseline === undefined) return;
		const container = contentRef.current;
		if (container === null) return;
		let raf = 0;
		const measure = () => {
			raf = 0;
			const containerTop = container.getBoundingClientRect().top;
			const ahead = container.clientHeight * 2;
			const rects: SectionRect[] = [];
			const approaching: string[] = [];
			for (const el of container.querySelectorAll<HTMLElement>("[data-section]")) {
				const key = el.dataset.section;
				if (key === undefined) continue;
				const top = el.getBoundingClientRect().top - containerTop;
				rects.push({ key, top });
				if (top <= ahead && sectionsOpen.has(key) && !payloads.has(key)) approaching.push(key);
			}
			setVisibleSection(visibleSectionKey(rects, 0));
			for (const key of approaching) {
				const file = fileBySection.get(key);
				if (file !== undefined) void fetchSectionPayload(file, root, baseline, state);
			}
		};
		const onScroll = () => {
			if (raf === 0) raf = requestAnimationFrame(measure);
		};
		container.addEventListener("scroll", onScroll, { passive: true });
		measure();
		return () => {
			container.removeEventListener("scroll", onScroll);
			if (raf !== 0) cancelAnimationFrame(raf);
		};
	}, [presentation, baseline, sectionsOpen, payloads, fileBySection, root, state, fetchSectionPayload]);

	const changedPath = useMemo(() => {
		const map = new Map<string, GitDiffFileStatus>();
		for (const file of files) map.set(sectionKey(root, file.path), file.status);
		return map;
	}, [files, root]);

	const treeNodes: TreeNode[] =
		treeMode === "changed"
			? buildChangedTree(root, files, collapsedDirs)
			: buildDirectoryTree(root, dirs, treeExpanded, changedPath, dirErrors);
	// Review highlights the section being read (the tree follows the viewport);
	// file presentation highlights the selection.
	const treeSelection = presentation === "review" ? (visibleSection ?? selectedPath) : selectedPath;

	const toggleDirectory = useCallback(
		(node: TreeNode) => {
			if (treeMode === "changed") {
				setCollapsedDirs((prev) => {
					const next = new Set(prev);
					if (next.has(node.path)) next.delete(node.path);
					else next.add(node.path);
					return next;
				});
				return;
			}
			setTreeExpanded((prev) => {
				const next = new Set(prev);
				if (next.has(node.path)) {
					next.delete(node.path);
				} else {
					next.add(node.path);
					if (!dirs.has(node.path)) void fetchDirectory(node.path, state, requestRef.current);
				}
				return next;
			});
		},
		[treeMode, dirs, fetchDirectory, state],
	);

	const selectNode = useCallback(
		(node: TreeNode) => {
			if (browser === null || node.isDirectory) return;
			setDiffMode(false);
			// The drawer covers the content it was opened over, so choosing a file
			// dismisses it; a wide viewport keeps the tree in place.
			if (narrow) setTreeOpen(false);
			// A new file drops the previous target's line anchor: `path:98` belongs
			// to the file it was parsed from.
			openBrowser({ ...browser, path: node.path, line: undefined });
		},
		[browser, openBrowser, narrow],
	);

	const toggleSection = useCallback(
		(file: GitDiffFileStat) => {
			if (baseline === undefined) return;
			const abs = sectionKey(root, file.path);
			const next = new Set(sectionsOpen);
			if (next.has(abs)) {
				next.delete(abs);
			} else {
				next.add(abs);
				if (!payloads.has(abs)) void fetchSectionPayload(file, root, baseline, state);
			}
			setSectionsOpen(next);
		},
		[baseline, payloads, root, sectionsOpen, state, fetchSectionPayload],
	);

	const allSectionsOpen = files.length > 0 && files.every((file) => sectionsOpen.has(sectionKey(root, file.path)));

	// The one-shot alternative to clicking every section: open them all and let
	// the approach prefetch fill in payloads as they come into view (or clear
	// them all again).
	const toggleAllSections = useCallback(() => {
		if (files.length === 0) return;
		setSectionsOpen((prev) =>
			files.every((file) => prev.has(sectionKey(root, file.path)))
				? new Set()
				: new Set(files.map((file) => sectionKey(root, file.path))),
		);
	}, [files, root]);

	const toggleFullFile = useCallback(
		async (file: GitDiffFileStat) => {
			const abs = sectionKey(root, file.path);
			if (fileViews.has(abs)) {
				setFileViews((m) => {
					const next = new Map(m);
					next.delete(abs);
					return next;
				});
				return;
			}
			setFileViews((m) => new Map(m).set(abs, { status: "loading" }));
			setSectionsOpen((s) => (s.has(abs) ? s : new Set(s).add(abs)));
			const request = requestRef.current;
			const key = sessionKeyRef.current;
			const label = stateLabel(state);
			const result = await readFileRpc(abs, state);
			if (request !== requestRef.current || key !== sessionKeyRef.current) return;
			if (result === null) {
				setFileViews((m) => new Map(m).set(abs, { status: "error" }));
			} else if (result.kind === "absent") {
				setFileViews((m) => new Map(m).set(abs, { status: "absent", label }));
			} else if (result.kind === "binary") {
				setFileViews((m) => new Map(m).set(abs, { status: "binary", label }));
			} else {
				setFileViews((m) =>
					new Map(m).set(abs, {
						status: "open",
						path: result.path,
						content: result.content,
						truncated: result.truncated,
						label,
					}),
				);
			}
		},
		[fileViews, root, state],
	);

	if (browser === null) return null;

	const involvesWorktree = state === "worktree" || baseline === "worktree";
	const newIsCommit = isPinnedCommit(state);
	const changedCount = files.length;
	// The header names the task, not the endpoint pair: the pair is metadata in
	// the detail line, and arbitrary selection lives in `Compare…`.
	const heading = browserHeading({ state, baseline, label: browser.label, origin: browser.origin }, states);
	const filesText = `${changedCount} file${changedCount === 1 ? "" : "s"} changed`;
	const asOfText = involvesWorktree && directive.status === "open" ? `as of ${formatTimestamp(directive.asOf)}` : null;
	const headingDetail =
		heading.surface === "files" ? root : [filesText, heading.comparison, asOfText].filter(Boolean).join(" · ");

	return (
		<>
			<button
				type="button"
				aria-label="Close file browser"
				className={viewerStyles.viewerOverlay}
				onClick={closeBrowser}
			/>
			<div role="dialog" className={viewerStyles.viewerPanel}>
				<div className={viewerStyles.viewerHeader}>
					<div className={styles.headerMain}>
						{!treeOpen && (
							<button
								type="button"
								className={styles.refreshBtn}
								onClick={() => setTreeOpen(true)}
								title="Show the file tree"
							>
								Files
							</button>
						)}
						<div className={styles.headingText}>
							<span className={styles.headingTitle} title={heading.title}>
								{heading.title}
							</span>
							{headingDetail && (
								<span className={styles.headingDetail} title={headingDetail}>
									{headingDetail}
								</span>
							)}
						</div>
					</div>
					<span className={styles.headerActions}>
						{baseline === undefined && (
							<StatePicker
								value={state}
								states={states}
								onPick={(next) => openBrowser({ ...browser, state: next })}
								className={newIsCommit ? styles.commitChip : undefined}
								title="Content at"
							/>
						)}
						<CompareMenu
							baseline={baseline}
							state={state}
							states={states}
							onApply={(nextBaseline, nextState) =>
								openBrowser({
									...browser,
									baseline: nextBaseline,
									state: nextState,
									tree: "changed",
									presentation: "review",
									label: undefined,
									origin: undefined,
								})
							}
						/>
						{baseline !== undefined && (
							<button
								type="button"
								className={styles.refreshBtn}
								data-on={presentation === "review" || undefined}
								aria-pressed={presentation === "review"}
								onClick={() =>
									openBrowser({ ...browser, presentation: presentation === "review" ? "file" : "review" })
								}
								title="Toggle stacked review"
							>
								Review
							</button>
						)}
						{involvesWorktree && (
							<button
								type="button"
								className={styles.refreshBtn}
								onClick={refresh}
								title="Refresh the worktree-derived view"
							>
								Refresh
							</button>
						)}
					</span>
					<button type="button" className={viewerStyles.viewerClose} onClick={closeBrowser} aria-label="Close">
						✕
					</button>
				</div>
				<div className={styles.browserBody}>
					{treeOpen && narrow && (
						<button
							type="button"
							className={styles.treeScrim}
							onClick={() => setTreeOpen(false)}
							aria-label="Hide file tree"
						/>
					)}
					{treeOpen && (
						<aside className={styles.treePane}>
							<div className={styles.treeHead}>
								{baseline !== undefined ? (
									<button
										type="button"
										className={styles.treeScope}
										data-on={treeMode === "changed" || undefined}
										aria-pressed={treeMode === "changed"}
										onClick={() =>
											openBrowser({ ...browser, tree: treeMode === "changed" ? "all" : "changed" })
										}
										title={treeMode === "changed" ? "Show all files" : "Show only changed files"}
									>
										{treeMode === "changed" ? `Changed (${changedCount})` : "All files"}
									</button>
								) : (
									<span>Files</span>
								)}
								<button
									type="button"
									className={styles.refreshBtn}
									onClick={() => setTreeOpen(false)}
									aria-label="Hide file tree"
								>
									Hide
								</button>
							</div>
							{directive.status === "error" && <div className={styles.note}>{directive.message}</div>}
							{directive.status === "open" && treeMode === "changed" && files.length === 0 && (
								<div className={styles.note}>No differences between the selected states.</div>
							)}
							{treeMode === "all" && dirErrors.has(root) && (
								<div className={styles.note}>Could not list this directory.</div>
							)}
							{treeMode === "all" && !dirErrors.has(root) && dirs.get(root)?.length === 0 && (
								<div className={styles.note}>Nothing to list here.</div>
							)}
							{directive.status === "open" && directive.untrackedOmitted > 0 && treeMode === "changed" && (
								<div className={styles.note}>
									{directive.untrackedOmitted} more untracked file
									{directive.untrackedOmitted === 1 ? " is" : "s are"} not shown.
								</div>
							)}
							{directive.status === "open" && directive.filesOmitted > 0 && (
								<div className={styles.note}>
									{directive.filesOmitted} more changed file
									{directive.filesOmitted === 1 ? " is" : "s are"} not listed.
								</div>
							)}
							<FileTree
								nodes={treeNodes}
								selectedPath={treeSelection}
								onSelect={selectNode}
								onToggle={toggleDirectory}
							/>
						</aside>
					)}
					<main className={styles.contentPane} ref={contentRef}>
						{baseline !== undefined && (
							<div className={styles.reviewBar}>
								{presentation === "review" && (
									<button
										type="button"
										className={styles.refreshBtn}
										onClick={toggleAllSections}
										title={allSectionsOpen ? "Collapse every file section" : "Expand every file section"}
									>
										{allSectionsOpen ? "Collapse files" : "Expand files"}
									</button>
								)}
								<button
									type="button"
									className={styles.refreshBtn}
									data-on={expandAllLines || undefined}
									aria-pressed={expandAllLines}
									onClick={() => setExpandAllLines((v) => !v)}
									title="Show the complete diff instead of three context lines"
								>
									Expand all lines
								</button>
							</div>
						)}
						{presentation === "file" ? (
							<FilePaneView
								pane={filePane}
								path={selectedPath}
								line={line}
								diff={baseline !== undefined ? fileDiff : null}
								diffMode={diffMode}
								onToggleDiff={() => setDiffMode((v) => !v)}
								hasBaseline={baseline !== undefined}
								stateLabel={stateLabel(state)}
								expandAllLines={expandAllLines}
								wrap={cardWrap}
							/>
						) : (
							<>
								{directive.status === "loading" && <div className={styles.note}>Loading…</div>}
								{directive.status === "error" && <div className={styles.note}>{directive.message}</div>}
								{directive.status === "open" && files.length === 0 && (
									<div className={styles.emptyState}>No differences between the selected states.</div>
								)}
								{directive.status === "open" && directive.filesOmitted > 0 && (
									<div className={styles.note}>
										{directive.filesOmitted} more changed file
										{directive.filesOmitted === 1 ? " is" : "s are"} not listed.
									</div>
								)}
								{directive.status === "open" && (
									<div className={styles.sections}>
										{files.map((file) => {
											const sectionId = sectionKey(root, file.path);
											return (
												<FileSection
													key={sectionId}
													sectionId={sectionId}
													file={file}
													open={sectionsOpen.has(sectionId)}
													onToggle={() => toggleSection(file)}
													payload={payloads.get(sectionId)}
													fileView={fileViews.get(sectionId)}
													onToggleFile={() => void toggleFullFile(file)}
													newLabel={stateLabel(state)}
													expandAllLines={expandAllLines}
													wrap={cardWrap}
												/>
											);
										})}
									</div>
								)}
							</>
						)}
					</main>
				</div>
			</div>
		</>
	);
});

/** The file presentation: one file at `state`, with an optional baseline diff. */
function FilePaneView({
	pane,
	path,
	line,
	diff,
	diffMode,
	onToggleDiff,
	hasBaseline,
	stateLabel: atLabel,
	expandAllLines,
	wrap,
}: {
	pane: FilePane;
	path: string | undefined;
	line: number | undefined;
	diff: Payload | null;
	diffMode: boolean;
	onToggleDiff: () => void;
	hasBaseline: boolean;
	stateLabel: string;
	expandAllLines: boolean;
	wrap: boolean;
}) {
	if (path === undefined) {
		return <div className={styles.emptyState}>Select a file to read it.</div>;
	}
	return (
		<>
			<div className={styles.fileBar}>
				<span className={styles.fileBarPath} title={path}>
					{path}
				</span>
				{hasBaseline && (
					<button
						type="button"
						className={styles.refreshBtn}
						data-on={diffMode || undefined}
						aria-pressed={diffMode}
						onClick={onToggleDiff}
					>
						{diffMode ? "File" : "Diff"}
					</button>
				)}
			</div>
			{diffMode ? (
				<DiffBody
					payload={diff}
					path={path}
					wrap={wrap}
					contextLines={expandAllLines ? ALL_LINES : CONTEXT_LINES}
				/>
			) : (
				<>
					{pane.status === "loading" && <div className={styles.note}>Loading…</div>}
					{pane.status === "error" && <div className={styles.note}>Could not read {path}.</div>}
					{pane.status === "absent" && <div className={styles.note}>Not present at {atLabel}.</div>}
					{pane.status === "binary" && (
						<div className={styles.note}>
							Binary file at {atLabel} ({pane.bytes} bytes).
						</div>
					)}
					{pane.status === "open" && (
						<div className={styles.fileBody}>
							<FileContent
								path={pane.path}
								content={pane.content}
								language={extToLang(pane.path)}
								truncated={pane.truncated}
								lineNumbers
								{...(line === undefined ? {} : { highlightLine: line })}
							/>
						</div>
					)}
				</>
			)}
		</>
	);
}
/** One review section: the client-side diff of two fetched snapshots. */
const DiffBody = memo(function DiffBody({
	payload,
	path,
	wrap,
	contextLines,
}: {
	payload: Payload | null;
	path: string;
	wrap: boolean;
	contextLines: number;
}) {
	if (payload === null || payload.status === "loading") return <div className={styles.note}>Loading…</div>;
	if (payload.status === "error") return <div className={styles.note}>Could not load this file&rsquo;s diff.</div>;
	if (payload.status === "binary") return <div className={styles.note}>Binary file differs.</div>;
	if (payload.status === "too-large") {
		return <div className={styles.note}>This file is too large to diff — open the whole file instead.</div>;
	}
	if (payload.oldText === payload.newText) return <div className={styles.note}>No content changes.</div>;
	return (
		<DiffSections
			sections={[{ title: null, lang: extToLang(path), oldText: payload.oldText, newText: payload.newText }]}
			lineNumbers
			contextLines={contextLines}
			wrap={wrap}
		/>
	);
});

const FileSection = memo(function FileSection({
	file,
	sectionId,
	open,
	onToggle,
	payload,
	fileView,
	onToggleFile,
	newLabel,
	expandAllLines,
	wrap,
}: {
	file: GitDiffFileStat;
	/** Absolute path — the section's identity, shared with its tree node. */
	sectionId: string;
	open: boolean;
	onToggle: () => void;
	payload: Payload | undefined;
	fileView: FileView | undefined;
	onToggleFile: () => void;
	newLabel: string;
	expandAllLines: boolean;
	wrap: boolean;
}) {
	const counts = formatCounts(file);
	return (
		<div className={styles.section} data-section={sectionId}>
			<div className={styles.sectionHead}>
				<button
					type="button"
					className={styles.sectionToggle}
					onClick={onToggle}
					aria-expanded={open}
					aria-label={`${open ? "Collapse" : "Expand"} diff for ${file.path}`}
				>
					<span className={styles.sectionTri}>{open ? "▾" : "▸"}</span>
					<span className={styles.sectionPath}>
						{file.oldPath && <span className={styles.sectionOldPath}>{file.oldPath}</span>}
						{file.path}
					</span>
					<span className={styles.sectionCounts}>
						{!file.binary && <span className={counts.del ? styles.countDel : undefined}>{counts.del}</span>}
						<span className={counts.add ? styles.countAdd : undefined}>{counts.add}</span>
					</span>
				</button>
				<button
					type="button"
					className={styles.sectionFileBtn}
					data-on={fileView ? true : undefined}
					aria-pressed={fileView !== undefined}
					aria-label={`Show the whole file ${file.path}`}
					title={`Show the whole file at ${newLabel}`}
					onClick={onToggleFile}
				>
					file
				</button>
			</div>
			{open && (
				<div className={styles.sectionBody}>
					{fileView ? (
						<FullFile fileView={fileView} />
					) : (
						<DiffBody
							payload={payload ?? null}
							path={file.path}
							wrap={wrap}
							contextLines={expandAllLines ? ALL_LINES : CONTEXT_LINES}
						/>
					)}
				</div>
			)}
		</div>
	);
});

/** A section's whole-file view at one end of the pair. */
const FullFile = memo(function FullFile({ fileView }: { fileView: FileView }) {
	if (fileView.status === "loading") return <div className={styles.note}>Loading…</div>;
	if (fileView.status === "error") return <div className={styles.note}>Could not load this file.</div>;
	if (fileView.status === "absent") return <div className={styles.note}>Not present at {fileView.label}.</div>;
	if (fileView.status === "binary") return <div className={styles.note}>Binary file at {fileView.label}.</div>;
	return (
		<div className={styles.fileBody}>
			<div className={styles.fileNote}>
				{fileView.label} · {fileView.path}
			</div>
			<FileContent
				path={fileView.path}
				content={fileView.content}
				language={extToLang(fileView.path)}
				truncated={fileView.truncated}
				lineNumbers
			/>
		</div>
	);
});

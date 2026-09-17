// ============================================================================
// ConversationArea — renders the turn list via ViewModel projection.
// Turn-based dispatch: UserTurn, AssistantTurn (flat blocks), SystemTurn.
// Consecutive steps share a visual spine; grouping is renderer-owned
// (segmentBlocks) — the ViewModel has no group entity.
// ============================================================================

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ViewModel } from "../../../../src/viewmodel/index.ts";
import { getStore, useStore } from "../../infra/store.tsx";
import { ChevronDownIcon } from "../../render/icons.tsx";
import { AssistantTurnView } from "./AssistantTurnView.tsx";
import styles from "./conversation.module.css";
import { GitChangeView } from "./GitChangeView.tsx";
import { SystemTurnView } from "./SystemTurnView.tsx";
import { UserBashView } from "./UserBashView.tsx";
import { UserTurnView } from "./UserTurnView.tsx";

interface ConversationAreaProps {
	vm: ViewModel;
	isStreaming: boolean;
	onToggleGroup: (key: string, cardKeys: string[]) => void;
	onToggleStep: (key: string) => void;
	onNavigate: (entryId: string) => void;
	onEdit: (entryId: string, index: number, text: string) => void;
}

export const ConversationArea = memo(function ConversationArea({
	vm,
	isStreaming,
	onToggleGroup,
	onToggleStep,
	onNavigate,
	onEdit,
}: ConversationAreaProps) {
	const userScrolledUpRef = useRef(false);
	// Jump-to-bottom: reactive mirrors of the scroll state. awayFromBottom is
	// pure geometry (viewport not at the live end) — it drives the floating
	// button's visibility. newContentBelow is the "something landed below
	// your viewport" signal: set by the auto-scroll effect when it skips (the
	// user is reading up), cleared whenever the live end is reached (scroll or
	// button). setState bails on equal values, so scroll-event churn stays
	// render-free (ADR 07 invariant 3a). Both are fed from the existing scroll
	// handler / auto-scroll effect — never a parallel detection — so the ref
	// and the rendered view of "at bottom" cannot drift.
	const [awayFromBottom, setAwayFromBottom] = useState(false);
	const [newContentBelow, setNewContentBelow] = useState(false);
	// True while the jump button's smooth scroll is animating. The auto-scroll
	// effect must not fire its instant scrollTo during the animation (that
	// cancels it); it re-issues a smooth scroll toward the moved live end
	// instead (smooth follow). Cleared by the scroll handler on arrival at the
	// live end, or when the user scrolls up (wheel input cancels the animation
	// and the flag must not outlive it).
	const smoothJumpRef = useRef(false);
	// entriesRef for the sibling pager — updated via Zustand subscribe
	// (not useStore) to avoid re-rendering ConversationArea on every
	// streaming patch. ADR 07 invariant 3a: only the streaming text block
	// re-renders on append.
	const entriesRef = useRef(getStore().getState().document.entries);
	useEffect(
		() =>
			getStore().subscribe((state) => {
				entriesRef.current = state.document.entries;
			}),
		[],
	);

	// Viewport state model: the viewport is either "at-bottom" (tracking the
	// live end — auto-scroll and auto-shrink both run, movement is expected) or
	// "in-middle" (the user scrolled up to read — auto-scroll paused, and
	// auto-shrink is harmless because the folded spine is below the viewport
	// and no clamp fires). The state is user-driven only: a browser clamp
	// (content shrink pushing scrollTop down to the new max) must NOT flip
	// in-middle → at-bottom, or the next auto-scroll yanks the reader off
	// their chosen position (the nit-2 race). So we track scrollHeight alongside
	// scrollTop and skip the state update whenever the document shrank — that
	// scroll is a clamp or layout shift, not user intent. Programmatic scrolls
	// (auto-scroll, navigation anchors) land where the state already agrees or
	// manage the state at their call site, so they need no special handling
	// here.
	const lastScrollTopRef = useRef(0);
	const lastScrollHeightRef = useRef(0);
	useEffect(() => {
		// The viewport (document) is the scroll container now — see
		// App.module.css. Attach to window and read document metrics.
		const handleScroll = () => {
			const st = window.scrollY;
			const sh = document.documentElement.scrollHeight;
			const shrank = sh < lastScrollHeightRef.current - 2;
			lastScrollHeightRef.current = sh;
			// Clamp / layout shift, not user intent. Bookkeep the position so
			// the next event's direction delta is correct, but leave the
			// viewport state untouched — the user didn't move.
			if (shrank) {
				lastScrollTopRef.current = st;
				return;
			}

			// Geometry mirror — computed before the no-net-change guard below:
			// programmatic scrolls (jump button, auto-scroll, anchors) pre-update
			// lastScrollTopRef so their event reads as no movement, and would
			// otherwise early-return with a stale awayFromBottom (the jump
			// button not disappearing after its own click). Threshold-based, so
			// ≤2px jitter events updating it is harmless.
			const threshold = 30;
			const isAtBottom = sh - st - window.innerHeight <= threshold;
			setAwayFromBottom(!isAtBottom);
			if (isAtBottom) {
				userScrolledUpRef.current = false;
				smoothJumpRef.current = false;
				// Reaching the live end by any means consumes the new-content signal.
				setNewContentBelow(false);
			}

			if (Math.abs(st - lastScrollTopRef.current) <= 2) return;
			if (!isAtBottom && st < lastScrollTopRef.current - 1) {
				userScrolledUpRef.current = true;
				smoothJumpRef.current = false;
			}

			lastScrollTopRef.current = st;
		};

		window.addEventListener("scroll", handleScroll, { passive: true });
		return () => window.removeEventListener("scroll", handleScroll);
	}, []);

	// Auto-scroll to bottom when new content arrives and user hasn't scrolled up.
	// Only structural changes (entries added/removed, new streaming blocks)
	// drive re-scroll. Content-only changes (lazy pull ingests, expand toggles)
	// are user-initiated reading actions — never auto-scroll.
	const prevStructKeyRef = useRef<string>("");
	// Structural identity of the leaf path, sourced from the ViewModel the
	// caller already projected. Replaces a render-time getStore().getState()
	// reach-in that re-walked the path (duplicating App's VM cache key and
	// computeViewModel's projectLeafPath). vm is reactive, so this stays in
	// sync with projection without a store subscription.
	const structKey = vm.pathKey;
	// Content-delta key: per-block text/thinking field lengths on the leaf
	// entry. Captures streaming deltas (text_delta / thinking_delta) that
	// structKey (block counts) misses. Gated on `isStreaming` below so
	// completed-turn lazy pulls of thinking — which also change this key —
	// don't trip auto-scroll (those are reading actions, not new content).
	const streamingKey = vm.streamingKey;
	const prevStreamingKeyRef = useRef<string>("");
	// Readable-text identity (user/assistant `text` blocks only). The dot's
	// "new content below" signal is gated on this, not on structKey/streamingKey:
	// thinking and tool-call churn must not raise the dot while the user is
	// reading up. Auto-scroll (when at the bottom) still follows every change.
	const textKey = vm.textKey;
	const prevTextKeyRef = useRef<string>("");

	// biome-ignore lint/correctness/useExhaustiveDependencies: vm is the content-change signal; expanded* state is a deliberate omission
	useEffect(() => {
		// Fire on either (a) a structural change (new entries/blocks — covers
		// block-appending events) or (b) streaming intra-block content growth
		// (text/thinking deltas) while the turn is in-flight. The latter is the
		// fix for the old problem: a single streaming text/thinking block grows
		// its field without appending a block, so structKey never changed and
		// the viewport didn't follow. isStreaming excludes completed-turn lazy
		// pulls (also text/thinking-length changes) and expand toggles.
		const structChanged = structKey !== prevStructKeyRef.current;
		const streamingGrew = isStreaming && streamingKey !== prevStreamingKeyRef.current;
		if (!structChanged && !streamingGrew) return;
		const textChanged = textKey !== prevTextKeyRef.current;
		prevStructKeyRef.current = structKey;
		prevStreamingKeyRef.current = streamingKey;
		prevTextKeyRef.current = textKey;
		// The user is reading up: don't yank the viewport — raise the
		// new-content signal on the jump button instead, but only for readable
		// text. Thinking/tool blocks arriving below the viewport update the refs
		// above without touching the dot, so the notifier does not fire on
		// activity the reader did not come to read.
		if (userScrolledUpRef.current) {
			if (textChanged) setNewContentBelow(true);
			return;
		}
		// A smooth jump is animating: an instant scrollTo here would cancel it.
		// Re-aim the animation at the (moved) live end instead — each re-issue
		// retargets from the current position, so streaming growth chases
		// smoothly. Arrival at the live end clears smoothJumpRef (scroll
		// handler), after which normal instant-follow resumes.
		if (smoothJumpRef.current) {
			window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
			return;
		}
		const target = document.documentElement.scrollHeight;
		window.scrollTo(0, target);
		// scrollTo is synchronous; read back the clamped position so the
		// async scroll event sees no net change and doesn't re-trip the
		// handler. Refresh the height bookkeeping too, in case scrollTo
		// lands on the same position (no scroll event) and would otherwise
		// leave lastScrollHeightRef stale for the next handler invocation.
		lastScrollTopRef.current = window.scrollY;
		lastScrollHeightRef.current = document.documentElement.scrollHeight;
	}, [vm, structKey, streamingKey, textKey, isStreaming]);

	// Anchor scroll: when the tree dialog selects a message, navigate sets
	// `scrollToEntryId`; after the VM re-renders with the new leaf path, scroll
	// the matching turn into view (top-aligned with a small offset) and clear
	// the pending id. This is independent of the auto-scroll-above: a navigation
	// is a user-driven context switch, not bottom-following growth.
	//
	// Cross-branch correctness: the navigate RPC is async, so the VM may still
	// reflect the *old* path on the first render after the store sets the id.
	// The clicked node isn't on the old path, so the element is absent. We must
	// NOT clear in that state — wait for the VM to include the target, then
	// scroll and clear. Guarded against leaks by the path-presence check: if
	// the navigate somehow never lands (e.g. the entry was pruned), the id stays
	// set but does no harm; a later navigation overwrites it.
	const scrollToEntryId = useStore((s) => s.scrollToEntryId);
	useEffect(() => {
		if (!scrollToEntryId) return;
		// Wait for the navigate to land — the target must be on the current path.
		const onPath = vm.turns.some((t) => t.entryId === scrollToEntryId);
		if (!onPath) return;
		// Document-level scroll: resolve the turn's absolute position via
		// getBoundingClientRect (offsetTop would be relative to the nearest
		// positioned ancestor, not the document).
		const el = document.querySelector(`[data-entry-id="${CSS.escape(scrollToEntryId)}"]`);
		if (el instanceof HTMLElement) {
			const top = el.getBoundingClientRect().top + window.scrollY - 12;
			window.scrollTo(0, Math.max(0, top));
			lastScrollTopRef.current = window.scrollY;
			// A non-streaming navigate resumes bottom-follow — it's a context
			// switch to a new branch. A look-only anchor during streaming (Q3:
			// history-pane on-path click) must PAUSE follow instead, or the next
			// streaming delta yanks the viewport right back to the bottom. The
			// scroll handler re-arms follow when the user scrolls back to bottom.
			userScrolledUpRef.current = isStreaming;
		}
		getStore().getState().setScrollToEntryId(null);
	}, [scrollToEntryId, vm, isStreaming]);

	// Keyboard focus (j/k/g/G): scroll the focused turn into view. Unlike the
	// tree-dialog anchor above, the target is usually already rendered (no
	// navigate RPC), so this lands immediately — BUT a branch switch (h/l)
	// repoints focus to a sibling that isn't on the active path yet, so the
	// element renders only after the navigate lands. The `vm` dep makes this
	// effect retry on the next render; `lastScrolledFocusRef` caps it to one
	// scroll per focus id (streaming re-runs the effect but won't re-scroll).
	// `block: start` top-anchors the turn below the fixed TopBar via
	// scroll-margin-top — predictable for every turn, and correct for long
	// messages that `nearest` would only partially reveal. No `behavior`
	// (defaults to instant): Gmail-style snap, so rapid j/k doesn't queue or
	// lag like `smooth` does across long distances.
	const focusedTurnId = useStore((s) => s.focusedTurnId);
	const lastScrolledFocusRef = useRef<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: vm is the retry signal — a branch switch (h/l) repoints focus to a sibling that renders only after the async navigate lands, so this effect must re-run on vm updates to find the element. lastScrolledFocusRef caps it to one scroll per id so streaming's vm churn doesn't re-scroll.
	useEffect(() => {
		if (!focusedTurnId) {
			lastScrolledFocusRef.current = null;
			return;
		}
		if (lastScrolledFocusRef.current === focusedTurnId) return;
		// data-turn-key — unique per turn. data-entry-id would land on the
		// entry-head turn even when focus is on a split entry's trailing turn.
		const el = document.querySelector(`[data-turn-key="${CSS.escape(focusedTurnId)}"]`);
		if (!el) return; // not rendered yet; the vm dep retries when it is
		lastScrolledFocusRef.current = focusedTurnId;
		el.scrollIntoView({ block: "start" });
	}, [focusedTurnId, vm]);

	// Jump to bottom (the floating button): animate to the live end and re-arm
	// bottom-follow. Smooth — the button is a deliberate single action, unlike
	// rapid j/k focus scrolls which stay instant. Consequences of async
	// animation: no read-back bookkeeping (scrollY hasn't moved yet; the
	// intermediate scroll events update lastScrollTopRef progressively), and
	// no instant button hide (mid-flight events are not at-bottom and would
	// re-show it — the geometry mirror fades it out on arrival instead).
	// prefers-reduced-motion falls back to the instant path with the original
	// synchronous bookkeeping.
	const jumpToBottom = useCallback(() => {
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		smoothJumpRef.current = !reduced;
		if (reduced) {
			window.scrollTo(0, document.documentElement.scrollHeight);
			lastScrollTopRef.current = window.scrollY;
			lastScrollHeightRef.current = document.documentElement.scrollHeight;
		} else {
			window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
		}
		userScrolledUpRef.current = false;
		setNewContentBelow(false);
	}, []);

	if (vm.turns.length === 0) {
		return (
			<div className={styles.scrollContainer}>
				<div className={styles.empty}>No messages yet. Send a prompt to begin.</div>
			</div>
		);
	}

	const lastTurn = vm.turns[vm.turns.length - 1];

	return (
		<div className={styles.scrollContainer}>
			{vm.turns.map((turn) => {
				switch (turn.kind) {
					case "user":
						return (
							<UserTurnView
								key={turn.entryId}
								turn={turn}
								entriesRef={entriesRef}
								onNavigate={onNavigate}
								onEdit={onEdit}
							/>
						);
					case "assistant":
						return (
							<AssistantTurnView
								// turnKey — not entryId: a split entry produces two turns
								// that share the first entry's id (message turn + trailing-tool turn).
								key={turn.turnKey}
								turn={turn}
								isStreaming={isStreaming && turn === lastTurn}
								onToggleGroup={onToggleGroup}
								onToggleStep={onToggleStep}
							/>
						);
					case "system":
						return <SystemTurnView key={turn.entryId} turn={turn} />;
					case "userBash":
						return <UserBashView key={turn.entryId} turn={turn} />;
					case "gitChange":
						return <GitChangeView key={turn.entryId} turn={turn} />;
					default:
						return null;
				}
			})}
			{/* Always mounted — visibility animates (opacity/translate) rather than
			    a hard mount/unmount. data-visible drives the transition; the hidden
			    state is inert (visibility + pointer-events) and untabbable. */}
			<button
				type="button"
				className={styles.jumpToBottom}
				onClick={jumpToBottom}
				data-visible={awayFromBottom ? "true" : "false"}
				data-new={newContentBelow ? "true" : "false"}
				tabIndex={awayFromBottom ? 0 : -1}
				aria-hidden={!awayFromBottom}
				aria-label={newContentBelow ? "Jump to new messages" : "Jump to bottom"}
				title={newContentBelow ? "Jump to new messages" : "Jump to bottom"}
			>
				<ChevronDownIcon size={16} />
				<span className={styles.jumpDot} aria-hidden="true" />
			</button>
		</div>
	);
});

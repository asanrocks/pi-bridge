// ============================================================================
// useViewportTracking — the conversation viewport's scroll state machine,
// extracted from ConversationArea so that component only renders turns.
//
// The viewport is either "at-bottom" (tracking the live end — auto-scroll
// runs, movement is expected) or "in-middle" (the user scrolled up to read
// — auto-scroll paused, the jump button shows a dot on new readable text).
// The state is user-driven only: a browser clamp (content shrink pushing
// scrollTop down to the new max) must NOT flip in-middle → at-bottom, or
// the next auto-scroll yanks the reader off their chosen position.
//
// Owns, in dependency order:
//   1. the geometry anchor (capture/restore of the reading position across
//      column reflow — pane open/resize, window resize below the measure cap)
//   2. the scroll listener (intent detection + geometry mirror)
//   3. the session landing (first paint of a session's content: streaming →
//      live end + follow, idle → anchor on the last user turn)
//   4. auto-scroll on structural change / streaming growth
//   5. the history-pane anchor scroll (scrollToEntryId, set on navigation)
//   6. the keyboard focus scroll (focusedTurnId, j/k/g/G)
//   7. the jump-to-bottom button handler
//   8. the go-live handler (peek return)
//
// Exposes only what the renderer needs: the two button-driving booleans
// (awayFromBottom, newContentBelow) and jumpToBottom.
// ============================================================================

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { ViewModel } from "../../../../src/viewmodel/index.ts";
import { getStore, useStore } from "../../infra/state/store.tsx";

interface ViewportTracking {
	/** Pure geometry: viewport not at the live end. Drives the floating jump
	 * button's visibility. */
	awayFromBottom: boolean;
	/** "Something readable landed below your viewport" — set by the
	 * auto-scroll effect when it skips (user reading up), cleared whenever
	 * the live end is reached (scroll or button). Drives the button's dot. */
	newContentBelow: boolean;
	/** Jump button handler: animate to the live end and re-arm follow. */
	jumpToBottom: () => void;
	/** Return-to-live handler (peek): unpin the rendering leaf, then anchor
	 * at the live end once the live projection has rendered. */
	goLive: () => void;
}

export function useViewportTracking(
	vm: ViewModel,
	isStreaming: boolean,
	isDiverged: boolean,
	scrollContainerRef: RefObject<HTMLDivElement | null>,
): ViewportTracking {
	// True while the user has deliberately scrolled up (reading), pausing
	// auto-scroll. Cleared by reaching the live end (any means) or the jump
	// button.
	const userScrolledUpRef = useRef(false);
	// Reactive mirrors of the scroll state for the jump button. setState bails
	// on equal values, so scroll-event churn stays render-free (ADR 07
	// invariant 3a). Both are fed from the scroll handler / auto-scroll
	// effect — never a parallel detection — so the refs and the rendered view
	// of "at bottom" cannot drift.
	const [awayFromBottom, setAwayFromBottom] = useState(false);
	const [newContentBelow, setNewContentBelow] = useState(false);
	// True while the jump button's smooth scroll is animating. The auto-scroll
	// effect must not fire its instant scrollTo during the animation (that
	// cancels it); it re-issues a smooth scroll toward the moved live end
	// instead (smooth follow). Cleared by the scroll handler on arrival at the
	// live end, or when the user scrolls up (wheel input cancels the animation
	// and the flag must not outlive it).
	const smoothJumpRef = useRef(false);

	// ---------------------------------------------------------------------------
	// 1. Geometry anchor — keep the reading position through column reflow
	// ---------------------------------------------------------------------------
	// Opening/resizing a docked pane (sidebar, history) republishes a gutter
	// CSS var; the measure-capped conversation column narrows, text re-wraps,
	// and every turn's height changes. The browser keeps the raw scrollY pixel
	// offset through a reflow — native scroll anchoring only compensates DOM
	// mutations, not geometry changes — so the text under your eye slides by
	// the accumulated rewrap delta. This reimplements anchoring for geometry
	// changes:
	//   - capture: the deepest DOM element under the viewport-top probe plus
	//     its viewport-relative top (identity = live node reference — a CSS
	//     reflow moves boxes but never mutates the DOM, so the node survives
	//     without any React-level identity scheme), kept continuously fresh
	//     on every scroll event and programmatic scroll. The enclosing turn
	//     (`data-turn-key`) is recorded alongside as fallback identity;
	//   - restore: on a column WIDTH change (height-only growth is streaming
	//     or expansion, not rewrap), scroll the recorded point of the
	//     recorded element back to the same viewport position. If React has
	//     replaced the node meanwhile (streaming delta, lazy pull, expand
	//     toggle — `isConnected` detects it), degrade to pinning the recorded
	//     turn's boundary; if that is gone too, keep the offset.
	// Scroll bookkeeping, shared with the §2 listener: pre-updating both refs
	// around a programmatic scroll makes its event read as no net movement.
	const lastScrollTopRef = useRef(0);
	const lastScrollHeightRef = useRef(0);
	const anchorRef = useRef<{
		el: HTMLElement;
		relTop: number;
		turnKey: string | null;
		turnRelTop: number | null;
	} | null>(null);
	const columnWidthRef = useRef(0);

	const captureAnchor = useCallback(() => {
		// Probe just below the fixed TopBar: elementFromPoint is a cheap hit
		// test that yields the deepest element under the probe — usually the
		// paragraph or inline span actually carrying the line being read, so
		// the pin is as fine-grained as native scroll anchoring's.
		const topbarH = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--topbar-h")) || 0;
		const probeY = topbarH + 1;
		let el: HTMLElement | null = null;
		let turnKey: string | null = null;
		let turnRelTop: number | null = null;
		const container = scrollContainerRef.current;
		if (container) {
			// Probe the column's center — window center can sit in a docked pane.
			// Only content inside the column qualifies: a hit on the container
			// itself (the margin gap between turns) or on an overlay portal
			// (open menu) falls through to the turn scan below.
			const rect = container.getBoundingClientRect();
			const hit = document.elementFromPoint(rect.left + rect.width / 2, probeY);
			if (hit instanceof HTMLElement && hit !== container && container.contains(hit)) {
				el = hit;
				const turnEl = hit.closest("[data-turn-key]");
				if (turnEl instanceof HTMLElement && turnEl.dataset.turnKey) {
					turnKey = turnEl.dataset.turnKey;
					turnRelTop = turnEl.getBoundingClientRect().top;
				}
			}
		}
		// Gap between turns or covered probe: fall back to the first turn
		// starting below the probe — pin its boundary exactly.
		if (!el) {
			for (const t of document.querySelectorAll<HTMLElement>("[data-turn-key]")) {
				if (t.getBoundingClientRect().bottom > probeY) {
					el = t;
					turnKey = t.dataset.turnKey ?? null;
					turnRelTop = t.getBoundingClientRect().top;
					break;
				}
			}
		}
		if (!el) {
			anchorRef.current = null;
			return;
		}
		anchorRef.current = { el, relTop: el.getBoundingClientRect().top, turnKey, turnRelTop };
	}, [scrollContainerRef]);

	const restoreAnchor = useCallback(() => {
		const anchor = anchorRef.current;
		if (!anchor) return;
		// Live reference first. If the node was replaced (isConnected false),
		// degrade to the recorded turn boundary; if that is gone too (session
		// switched, turn pruned), keep the offset.
		let el: HTMLElement | null = anchor.el.isConnected ? anchor.el : null;
		let relTop = anchor.relTop;
		if (!el && anchor.turnKey && anchor.turnRelTop !== null) {
			const turnEl = document.querySelector(`[data-turn-key="${CSS.escape(anchor.turnKey)}"]`);
			if (turnEl instanceof HTMLElement) {
				el = turnEl;
				relTop = anchor.turnRelTop;
			}
		}
		if (!el) return;
		const target = el.getBoundingClientRect().top + window.scrollY - relTop;
		window.scrollTo(0, Math.max(0, target));
		lastScrollTopRef.current = window.scrollY;
		lastScrollHeightRef.current = document.documentElement.scrollHeight;
	}, []);

	// The observer lives on the column element (swapped by ConversationArea's
	// empty-state branch — hasTurns re-attaches on that flip). Width-only
	// filter: height callbacks are content growth, not rewrap.
	const hasTurns = vm.turns.length > 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: hasTurns is the re-attach signal — the observed element is swapped by ConversationArea's empty-state branch, so the observer must re-attach on that flip even though the dep is unread inside.
	useEffect(() => {
		const el = scrollContainerRef.current;
		if (!el) return;
		captureAnchor();
		const ro = new ResizeObserver((entries) => {
			const width = entries[entries.length - 1]?.contentRect.width ?? 0;
			if (width <= 0) return; // display:none or unmounted
			const prev = columnWidthRef.current;
			columnWidthRef.current = width;
			if (prev === 0 || Math.abs(width - prev) < 1) return;
			restoreAnchor();
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [hasTurns, captureAnchor, restoreAnchor, scrollContainerRef]);

	// ---------------------------------------------------------------------------
	// 2. Scroll listener — intent detection
	// ---------------------------------------------------------------------------
	// Track scrollHeight alongside scrollTop and skip the state update
	// whenever the document shrank — that scroll is a clamp or layout shift,
	// not user intent. Programmatic scrolls (auto-scroll, navigation anchors)
	// land where the state already agrees or manage the state at their call
	// site, so they need no special handling here. Every event also refreshes
	// the geometry anchor (§1), so the reading position is always current
	// when a width change needs it.
	useEffect(() => {
		// The viewport (document) is the scroll container — see App.module.css.
		// Attach to window and read document metrics.
		const handleScroll = () => {
			captureAnchor();
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
	}, [captureAnchor]);

	// ---------------------------------------------------------------------------
	// 3. Session landing — the first paint of a session's content
	// ---------------------------------------------------------------------------
	// When a session's content first appears (open, launcher switch, cold URL
	// load, re-attach after reconnect), the landing position is a rule, not a
	// leftover of the previous session's viewport state:
	//   - streaming session → live end with follow armed. The auto-scroll
	//     effect (§4) performs the scroll on the struct change; this effect
	//     only resets the reading state BEFORE §4 runs in the same commit,
	//     which is why it is declared above it.
	//   - idle session → top-anchored on the last user turn of the active
	//     path (the "you are here" marker), via the §5 anchor machinery.
	//     Degenerate case (no user turns) falls back to the live end.
	// activeSessionId flips on the initial-sync frame, and the pipeline
	// applies the frame's document synchronously in the same handler, so this
	// effect always sees the new session's VM.
	const activeSessionId = useStore((s) => s.activeSessionId);
	const landedSessionRef = useRef<string | null>(null);
	useEffect(() => {
		if (!activeSessionId) {
			landedSessionRef.current = null;
			return;
		}
		if (landedSessionRef.current === activeSessionId) return;
		landedSessionRef.current = activeSessionId;
		// The previous session's reading state must not leak: follow is armed
		// unconditionally here (the §2 scroll handler re-pauses on user intent).
		userScrolledUpRef.current = false;
		smoothJumpRef.current = false;
		setNewContentBelow(false);
		if (isStreaming) return;
		let lastUserId: string | null = null;
		for (const t of vm.turns) if (t.kind === "user") lastUserId = t.entryId;
		if (lastUserId) {
			getStore().getState().setScrollToEntryId(lastUserId);
			return;
		}
		window.scrollTo(0, document.documentElement.scrollHeight);
		lastScrollTopRef.current = window.scrollY;
		lastScrollHeightRef.current = document.documentElement.scrollHeight;
	}, [activeSessionId, vm, isStreaming]);

	// ---------------------------------------------------------------------------
	// 4. Auto-scroll — follow the live end on growth, never on reading actions
	// ---------------------------------------------------------------------------
	// Only structural changes (entries added/removed, new streaming blocks)
	// drive re-scroll. Content-only changes (lazy pull ingests, expand toggles)
	// are user-initiated reading actions — never auto-scroll.
	const prevStructKeyRef = useRef<string>("");
	// Structural identity of the leaf path, sourced from the ViewModel the
	// caller already projected. vm is reactive, so this stays in sync with
	// projection without a store subscription.
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
		// While peeking (rendering leaf pinned off the live path) the auto-scroll
		// machinery pauses entirely: the VM describes the peeked path, whose keys
		// don't track live growth, and the viewport belongs to the reader. Refs
		// are deliberately left stale — returning to live sees changed keys and
		// §4 re-runs once (the go-live pending flag handles the scroll).
		if (isDiverged) return;
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
	}, [vm, structKey, streamingKey, textKey, isStreaming, isDiverged]);

	// ---------------------------------------------------------------------------
	// 5. Anchor scroll — history-pane selection after a navigation
	// ---------------------------------------------------------------------------
	// When the tree dialog selects a message, navigate sets `scrollToEntryId`;
	// after the VM re-renders with the new leaf path, scroll the matching turn
	// into view (top-aligned with a small offset) and clear the pending id.
	// This is independent of the auto-scroll-above: a navigation is a
	// user-driven context switch, not bottom-following growth.
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

	// ---------------------------------------------------------------------------
	// 6. Keyboard focus scroll (j/k/g/G)
	// ---------------------------------------------------------------------------
	// Unlike the tree-dialog anchor above, the target is usually already
	// rendered (no navigate RPC), so this lands immediately — BUT a branch
	// switch (h/l) repoints focus to a sibling that isn't on the active path
	// yet, so the element renders only after the navigate lands. The `vm` dep
	// makes this effect retry on the next render; `lastScrolledFocusRef` caps
	// it to one scroll per focus id (streaming re-runs the effect but won't
	// re-scroll). `block: start` top-anchors the turn below the fixed TopBar
	// via scroll-margin-top — predictable for every turn, and correct for long
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

	// ---------------------------------------------------------------------------
	// 7. Jump to bottom (the floating button)
	// ---------------------------------------------------------------------------
	// Smooth — the button is a deliberate single action, unlike rapid j/k
	// focus scrolls which stay instant. Consequences of async animation: no
	// read-back bookkeeping (scrollY hasn't moved yet; the intermediate scroll
	// events update lastScrollTopRef progressively), and no instant button
	// hide (mid-flight events are not at-bottom and would re-show it — the
	// geometry mirror fades it out on arrival instead).
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

	// ---------------------------------------------------------------------------
	// 8. Go live (the jump button's peek meaning)
	// ---------------------------------------------------------------------------
	// Unpin the rendering leaf and anchor at the live end once the live
	// projection has rendered. The scroll can't happen inline: the peeked
	// content is still mounted in this tick, and the live path's height isn't
	// known until the store flip re-projects and React commits. The pending
	// flag makes the §4 effect (which re-runs on the projection change) do the
	// scroll — same retry pattern as the §5 anchor. Live growth that landed
	// while peeking is included, so this is "catch up with everything".
	const goLivePendingRef = useRef(false);
	const goLive = useCallback(() => {
		goLivePendingRef.current = true;
		userScrolledUpRef.current = false;
		smoothJumpRef.current = false;
		setNewContentBelow(false);
		getStore().getState().setRenderLeaf(null);
	}, []);

	useEffect(() => {
		if (!goLivePendingRef.current || isDiverged) return;
		goLivePendingRef.current = false;
		window.scrollTo(0, document.documentElement.scrollHeight);
		lastScrollTopRef.current = window.scrollY;
		lastScrollHeightRef.current = document.documentElement.scrollHeight;
		// The isDiverged flip IS the projection-change signal: setRenderLeaf(null)
		// flips it, the store subscribers re-render, and this effect runs after
		// that same commit — the live content's height is final here.
	}, [isDiverged]);

	return { awayFromBottom, newContentBelow, jumpToBottom, goLive };
}

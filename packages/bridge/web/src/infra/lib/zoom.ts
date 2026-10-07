// ============================================================================
// zoom — display scale for the reading surface.
//
// The web client is a document reader: the conversation column must stay
// viewport-width, so a pinch must not magnify a region (the browser's visual
// zoom) but change the app's type scale — the effect Ctrl + / - has in a
// browser. A pinch steps through a discrete ladder and a double-tap is the
// Ctrl+0 reset; the chosen step is a device preference (localStorage), not
// session state.
//
// The scale is published as the `--ui-scale` custom property on the document
// element, and app/index.css multiplies the --fs-* type tokens by it. Putting
// the lever on the rem-based type tokens (rather than the root font-size) lets
// the OS/browser text-size preference compose with it instead of being
// overwritten, and leaves the px-based shell geometry untouched. Components
// whose geometry is measured in px and coupled to text (the History graph's
// fixed row pitch) read the scale through `useZoomScale` and rescale.
//
// Touch only: desktop trackpad pinch stays suppressed (see installZoomGestures)
// so the browser's own keyboard and menu zoom remain the desktop paths.
// ============================================================================

import { useSyncExternalStore } from "react";

/**
 * The steps a pinch walks. Deliberately asymmetric: the reader's primary
 * gesture is pulling back to skim more of the transcript at once, so the
 * zoom-out side is fine-grained (0.1 rungs) and reaches 60%, while zoom-in is
 * short and shallow (two rungs, ceiling 125%) — enlarging past that trades
 * away the whole-width reading column the client exists to keep.
 */
export const ZOOM_LADDER: readonly number[] = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25];

export const DEFAULT_ZOOM = 1;

/** Custom property the scale is published as; app/index.css consumes it. */
const SCALE_VAR = "--ui-scale";
const LS_KEY = "pi-bridge:zoom";

/** Finger travel (current / reference distance) that advances one step. */
export const PINCH_STEP_RATIO = 1.15;
/** Two taps closer in time and space than this are one reset gesture. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 24;
/** A tap held longer than this is a press/drag, not half of a double-tap. */
const TAP_MAX_MS = 400;

/** Nearest ladder step to an arbitrary value (also sanitizes stored state). */
export function snapZoom(value: number): number {
	let best = ZOOM_LADDER[0];
	for (const step of ZOOM_LADDER) {
		if (Math.abs(step - value) < Math.abs(best - value)) best = step;
	}
	return best;
}

/** Next ladder step in `direction`, clamped at both ends. */
export function stepZoom(current: number, direction: 1 | -1): number {
	const at = ZOOM_LADDER.indexOf(snapZoom(current));
	return ZOOM_LADDER[Math.min(ZOOM_LADDER.length - 1, Math.max(0, at + direction))];
}

/**
 * Discretize a continuous pinch: given the reference finger distance and the
 * current one, report whether the gesture has travelled far enough to step
 * (and which way) plus the new reference. Rebasing on every step lets a long
 * pinch step repeatedly, like holding Ctrl +.
 */
export function stepPinch(reference: number, distance: number): { reference: number; direction: -1 | 0 | 1 } {
	if (distance > reference * PINCH_STEP_RATIO) return { reference: distance, direction: 1 };
	if (distance < reference / PINCH_STEP_RATIO) return { reference: distance, direction: -1 };
	return { reference, direction: 0 };
}

// ---------------------------------------------------------------------------
// State + DOM publication
// ---------------------------------------------------------------------------

let currentScale = DEFAULT_ZOOM;
const listeners = new Set<() => void>();

function readStored(): number {
	if (typeof localStorage === "undefined") return DEFAULT_ZOOM;
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (raw === null) return DEFAULT_ZOOM;
		const value = Number.parseFloat(raw);
		return Number.isFinite(value) ? snapZoom(value) : DEFAULT_ZOOM;
	} catch {
		return DEFAULT_ZOOM;
	}
}

function writeStored(scale: number): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(LS_KEY, String(scale));
	} catch {
		// Storage unavailable (private mode): the scale still applies for this
		// page life, it just does not survive a reload.
	}
}

function paint(scale: number): void {
	if (typeof document === "undefined") return;
	document.documentElement.style.setProperty(SCALE_VAR, String(scale));
}

/** Current ladder step. */
export function getZoomScale(): number {
	return currentScale;
}

function commit(scale: number): number {
	const next = snapZoom(scale);
	paint(next);
	if (next !== currentScale) {
		currentScale = next;
		writeStored(next);
		for (const listener of listeners) listener();
	}
	return next;
}

/** Apply the persisted preference. Call once, before the first render. */
export function initZoom(): void {
	currentScale = readStored();
	paint(currentScale);
}

export function zoomIn(): number {
	return commit(stepZoom(currentScale, 1));
}

export function zoomOut(): number {
	return commit(stepZoom(currentScale, -1));
}

export function resetZoom(): number {
	return commit(DEFAULT_ZOOM);
}

export function subscribeZoom(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Reactive scale for components whose px geometry tracks the type scale. */
export function useZoomScale(): number {
	return useSyncExternalStore(subscribeZoom, getZoomScale, () => DEFAULT_ZOOM);
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

function isControlTarget(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	return target.closest("input, textarea, select, button, a, [contenteditable]") !== null;
}

/**
 * Bind pinch-to-step-zoom and double-tap-to-reset.
 *
 * A two-finger touchmove is read directly (touch events carry every pointer on
 * both iOS and Android, and are what remain once `touch-action: pan-x pan-y`
 * and the gesture blocker below remove the native pinch). `preventDefault` on
 * a two-finger move suppresses whatever pan/zoom default is left. Desktop
 * trackpad pinch arrives as `wheel` with ctrlKey (Chrome/Firefox) or as
 * Safari's `gesture*` events — both stay suppressed, so keyboard and browser
 * zoom are unchanged there.
 */
export function installZoomGestures(): void {
	if (typeof window === "undefined") return;

	let reference = 0;
	let moved = false;
	let touchStartAt = 0;
	let touchStartX = 0;
	let touchStartY = 0;
	let lastTapAt = 0;
	let lastTapX = 0;
	let lastTapY = 0;

	const distance = (touches: TouchList): number => {
		const a = touches[0];
		const b = touches[1];
		return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
	};

	const advance = (current: number): void => {
		const stepped = stepPinch(reference, current);
		reference = stepped.reference;
		if (stepped.direction === 1) zoomIn();
		else if (stepped.direction === -1) zoomOut();
	};

	const onTouchStart = (e: TouchEvent): void => {
		if (e.touches.length === 2) {
			reference = distance(e.touches);
			moved = true; // a pinch is never a tap
		} else if (e.touches.length === 1) {
			touchStartAt = e.timeStamp;
			touchStartX = e.touches[0].clientX;
			touchStartY = e.touches[0].clientY;
			moved = false;
		}
	};

	const onTouchMove = (e: TouchEvent): void => {
		if (e.touches.length === 2) {
			e.preventDefault();
			advance(distance(e.touches));
			return;
		}
		if (e.touches.length === 1 && !moved) {
			const t = e.touches[0];
			if (Math.hypot(t.clientX - touchStartX, t.clientY - touchStartY) > DOUBLE_TAP_SLOP_PX) {
				moved = true;
			}
		}
	};

	const onTouchEnd = (e: TouchEvent): void => {
		if (e.touches.length === 0) reference = 0;
		if (moved || e.changedTouches.length !== 1) return;
		if (e.timeStamp - touchStartAt > TAP_MAX_MS) return;
		if (isControlTarget(e.target)) return;
		const t = e.changedTouches[0];
		if (
			e.timeStamp - lastTapAt < DOUBLE_TAP_MS &&
			Math.hypot(t.clientX - lastTapX, t.clientY - lastTapY) < DOUBLE_TAP_SLOP_PX
		) {
			lastTapAt = 0;
			resetZoom();
			return;
		}
		lastTapAt = e.timeStamp;
		lastTapX = t.clientX;
		lastTapY = t.clientY;
	};

	const onTouchCancel = (): void => {
		reference = 0;
		moved = false;
	};

	// Desktop trackpad pinch — both spellings are left to preventDefault so the
	// only desktop zoom paths stay the browser's keyboard shortcuts and menu.
	const onWheel = (e: WheelEvent): void => {
		if (e.ctrlKey) e.preventDefault();
	};
	const blockGesture = (e: Event): void => e.preventDefault();

	window.addEventListener("touchstart", onTouchStart, { passive: true });
	window.addEventListener("touchmove", onTouchMove, { passive: false });
	window.addEventListener("touchend", onTouchEnd, { passive: true });
	window.addEventListener("touchcancel", onTouchCancel, { passive: true });
	window.addEventListener("wheel", onWheel, { passive: false });
	window.addEventListener("gesturestart", blockGesture);
	window.addEventListener("gesturechange", blockGesture);
	window.addEventListener("gestureend", blockGesture);
}

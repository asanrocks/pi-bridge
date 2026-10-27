import { afterEach, describe, expect, it } from "vitest";
import { bindButton } from "../../src/dictation/button.ts";
import type { Dictation, DictationPhase } from "../../src/dictation/control.ts";
import type { LevelReading } from "../../src/dictation/level.ts";
import type { FakeWindow } from "../helpers/fake-element.ts";
import { FakeButton, installFakeWindow } from "../helpers/fake-element.ts";

interface Stub {
	mode: "hold" | "toggle" | "auto";
	isActive: boolean;
	readonly phase: DictationPhase;
	start(): Promise<void>;
	stop(): Promise<void>;
	subscribe(listener: (phase: DictationPhase) => void): () => void;
	onLevel(listener: (reading: LevelReading) => void): () => void;
	calls: string[];
	emit(phase: DictationPhase): void;
	emitLevel(reading: LevelReading): void;
}

/**
 * Structural double: the affordance only reads `mode`, `isActive`, `phase` and
 * the two channels, so the whole controller is not needed to test the binding.
 */
function stub(mode: "hold" | "toggle" | "auto" = "hold"): Stub {
	const phaseListeners = new Set<(phase: DictationPhase) => void>();
	const levelListeners = new Set<(reading: LevelReading) => void>();
	let phase: DictationPhase = { kind: "idle" };
	const calls: string[] = [];

	const api: Stub = {
		mode,
		isActive: false,
		get phase() {
			return phase;
		},
		start: () => {
			calls.push("start");
			api.isActive = true;
			return Promise.resolve();
		},
		stop: () => {
			calls.push("stop");
			api.isActive = false;
			return Promise.resolve();
		},
		subscribe: (listener) => {
			phaseListeners.add(listener);
			return () => {
				phaseListeners.delete(listener);
			};
		},
		onLevel: (listener) => {
			levelListeners.add(listener);
			return () => {
				levelListeners.delete(listener);
			};
		},
		calls,
		emit: (next) => {
			phase = next;
			for (const listener of phaseListeners) listener(next);
		},
		emitLevel: (reading) => {
			for (const listener of levelListeners) listener(reading);
		},
	};
	return api;
}

function asDictation(value: Stub): Dictation {
	return value as unknown as Dictation;
}

let installedWindow: ReturnType<typeof installFakeWindow> | undefined;

afterEach(() => {
	installedWindow?.restore();
	installedWindow = undefined;
});

/** The affordance listens on `window` for releases the button never sees. */
function installWindow(): FakeWindow {
	installedWindow = installFakeWindow();
	return installedWindow.window;
}

function press(button: FakeButton, pointerType?: string): void {
	button.dispatch("pointerdown", pointerType === undefined ? { button: 0 } : { button: 0, pointerType });
}

describe("bindButton", () => {
	it("mirrors the phase into data attributes and the accessible name", () => {
		installWindow();
		const button = new FakeButton();
		const dictation = stub();
		const detach = bindButton(button.element, asDictation(dictation));

		expect(button.dataset.state).toBe("idle");
		expect(button.getAttribute("aria-label")).toBe("Start dictation");
		expect(button.getAttribute("aria-pressed")).toBe("false");

		dictation.emit({ kind: "preparing" });
		expect(button.dataset.state).toBe("preparing");
		expect(button.dataset.sending).toBeUndefined();

		dictation.emit({ kind: "listening", sending: false });
		expect(button.dataset.state).toBe("listening");
		expect(button.dataset.sending).toBe("false");
		expect(button.getAttribute("aria-pressed")).toBe("true");
		expect(button.getAttribute("aria-label")).toBe("Stop dictation");

		dictation.emit({ kind: "listening", sending: true });
		expect(button.dataset.sending).toBe("true");

		detach();
		expect(button.dataset.state).toBeUndefined();
		expect(button.dataset.sending).toBeUndefined();
		expect(button.hasAttribute("aria-pressed")).toBe(false);
	});

	it("writes the level into one CSS custom property, never into text", () => {
		installWindow();
		const button = new FakeButton();
		const dictation = stub();
		const detach = bindButton(button.element, asDictation(dictation));

		dictation.emitLevel({ level: 0.42, speaking: true });
		expect(button.style.getPropertyValue("--asr-level")).toBe("0.420");
		expect(button.dataset.speaking).toBe("true");
		expect(button.textContent).toBe("");

		dictation.emitLevel({ level: 0, speaking: false });
		expect(button.dataset.speaking).toBe("false");

		detach();
		expect(button.style.getPropertyValue("--asr-level")).toBe("");
		expect(button.dataset.speaking).toBeUndefined();
	});

	it("honours a custom property name", () => {
		installWindow();
		const button = new FakeButton();
		const dictation = stub();
		const detach = bindButton(button.element, asDictation(dictation), { levelProperty: "--meter" });
		dictation.emitLevel({ level: 0.5, speaking: false });
		expect(button.style.getPropertyValue("--meter")).toBe("0.500");
		detach();
	});

	it("starts on press, stops on release, and prevents the press from moving focus", () => {
		const installed = installWindow();
		const button = new FakeButton();
		const dictation = stub("hold");
		const detach = bindButton(button.element, asDictation(dictation));

		press(button);
		// `preventDefault` is the whole of the no-focus-move rule the affordance can
		// state; whether focus then really stays put is the browser's part.
		expect(button.events.inputs.at(-1)?.defaultPrevented).toBe(true);
		expect(dictation.calls).toEqual(["start"]);

		// Released outside the button: capture must still stop.
		installed.dispatch("pointerup");
		expect(dictation.calls).toEqual(["start", "stop"]);

		// A release with no press behind it is not a stop.
		installed.dispatch("pointerup");
		expect(dictation.calls).toEqual(["start", "stop"]);
		detach();
	});

	it("ends a hold when the window loses focus, because no pointerup follows", () => {
		const installed = installWindow();
		const button = new FakeButton();
		const dictation = stub("hold");
		const detach = bindButton(button.element, asDictation(dictation));

		press(button);
		installed.dispatch("blur");
		expect(dictation.calls).toEqual(["start", "stop"]);

		// Nothing is holding any more, so a later release is not a second stop.
		installed.dispatch("pointerup");
		expect(dictation.calls).toEqual(["start", "stop"]);
		detach();
	});

	it("toggles on repeated presses in toggle mode", () => {
		const installed = installWindow();
		const button = new FakeButton();
		const dictation = stub("toggle");
		const detach = bindButton(button.element, asDictation(dictation));

		press(button);
		press(button);
		expect(dictation.calls).toEqual(["start", "stop"]);

		installed.dispatch("pointerup");
		expect(dictation.calls).toEqual(["start", "stop"]);
		detach();
	});

	it("picks hold for a finger and toggle for a mouse in auto mode", () => {
		const installed = installWindow();
		const button = new FakeButton();
		const dictation = stub("auto");
		const detach = bindButton(button.element, asDictation(dictation));

		// A finger is press-to-talk: the release, not a second tap, ends it.
		press(button, "touch");
		expect(dictation.calls).toEqual(["start"]);
		installed.dispatch("pointerup");
		expect(dictation.calls).toEqual(["start", "stop"]);

		// A mouse latches: the release does nothing, the next press stops.
		press(button, "mouse");
		installed.dispatch("pointerup");
		expect(dictation.calls).toEqual(["start", "stop", "start"]);
		press(button, "mouse");
		expect(dictation.calls).toEqual(["start", "stop", "start", "stop"]);
		detach();
	});

	it("treats an unknown pointer type and the keyboard as the latching form", () => {
		const installed = installWindow();
		const button = new FakeButton();
		const dictation = stub("auto");
		const detach = bindButton(button.element, asDictation(dictation));

		press(button);
		installed.dispatch("pointerup");
		expect(dictation.calls).toEqual(["start"]);

		button.dispatch("keydown", { key: " " });
		installed.dispatch("keyup", { key: " " });
		expect(dictation.calls).toEqual(["start", "stop"]);
		detach();
	});

	it("lets an explicit mode override what the pointer suggests", () => {
		const installed = installWindow();
		const button = new FakeButton();
		const dictation = stub("hold");
		const detach = bindButton(button.element, asDictation(dictation));

		press(button, "mouse");
		installed.dispatch("pointerup");
		expect(dictation.calls).toEqual(["start", "stop"]);
		detach();
	});

	it("is reachable from the keyboard", () => {
		const installed = installWindow();
		const button = new FakeButton();
		const dictation = stub("hold");
		const detach = bindButton(button.element, asDictation(dictation));

		button.dispatch("keydown", { key: "Enter" });
		expect(dictation.calls).toEqual(["start"]);
		installed.dispatch("keyup", { key: "Enter" });
		expect(dictation.calls).toEqual(["start", "stop"]);
		detach();
	});

	it("leaves the utterance running when the element goes away", () => {
		const installed = installWindow();
		const button = new FakeButton();
		const dictation = stub("hold");
		const detach = bindButton(button.element, asDictation(dictation));

		press(button);
		detach();
		installed.dispatch("pointerup");

		// A remounting composer must not end a dictation through teardown; that is
		// `cancel()`/`dispose()`'s job.
		expect(dictation.calls).toEqual(["start"]);
	});
});

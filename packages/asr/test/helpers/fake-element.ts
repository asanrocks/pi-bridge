/// <reference lib="dom" />

/**
 * The two DOM surfaces the package touches, without a DOM.
 *
 * `attachInput` reads seven members of a field and `bindButton` reads the
 * attribute, dataset and style surfaces of a button. Emulating a browser would
 * test the emulator: `setRangeText`'s caret modes are copied here from the
 * specification, and the browser facts a double cannot witness — that the field
 * reaches React's value tracker, that `preventDefault` really keeps focus — stay
 * the demo's job.
 *
 * Tests therefore assert on this object's state, which is the adapter's own
 * output, and on the events it dispatched, which is the adapter's own contract.
 */

import { inputEvent } from "../../src/dom/events.ts";

/** The document as the adapters see it: only `execCommand` is read, dynamically. */
export class FakeDocument {
	execCommand: ((command: string, showUI?: boolean, value?: string) => boolean) | undefined;
}

interface RecordedCommand {
	start: number;
	end: number;
	removed: string;
	inserted: string;
}

/**
 * A text field: value, selection, and the two range methods.
 *
 * `enableNativeUndo()` installs the browser's own edit command, modelled on what
 * it does — record the range it replaces, replace it, dispatch `input` — so the
 * tests can assert what one Ctrl+Z would undo.
 */
export class FakeTextField {
	value: string;
	selectionStart = 0;
	selectionEnd = 0;
	/** The lock a host holds while an utterance runs; the command must refuse it. */
	readOnly = false;
	readonly ownerDocument = new FakeDocument();
	readonly commands: RecordedCommand[] = [];

	private readonly listeners = new Map<string, Set<(event: Event) => void>>();

	constructor(value = "") {
		this.value = value;
		this.selectionStart = value.length;
		this.selectionEnd = value.length;
	}

	/** `attachInput` narrows to a real element type; this double is structurally it. */
	get element(): HTMLTextAreaElement {
		return this as unknown as HTMLTextAreaElement;
	}

	focus(): void {
		// Nothing to do: the adapter only has to call it, and a fake that tracked
		// focus would be asserting its own bookkeeping rather than the browser's.
	}

	addEventListener(type: string, listener: (event: Event) => void): void {
		const set = this.listeners.get(type) ?? new Set();
		set.add(listener);
		this.listeners.set(type, set);
	}

	removeEventListener(type: string, listener: (event: Event) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	dispatchEvent(event: Event): boolean {
		for (const listener of this.listeners.get(event.type) ?? []) listener(event);
		return true;
	}

	setSelectionRange(start: number, end: number): void {
		this.selectionStart = start;
		this.selectionEnd = end;
	}

	setRangeText(
		replacement: string,
		start: number,
		end: number,
		mode: "select" | "start" | "end" | "preserve" = "preserve",
	): void {
		this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
		switch (mode) {
			case "select":
				this.setSelectionRange(start, start + replacement.length);
				return;
			case "start":
				this.setSelectionRange(start, start);
				return;
			case "end":
				this.setSelectionRange(start + replacement.length, start + replacement.length);
				return;
			case "preserve":
				return;
		}
	}

	/**
	 * Install the browser's edit command.
	 *
	 * Three things it does that the adapter depends on: it refuses a read-only
	 * field (which is why the commit lifts that lock for one synchronous
	 * command), it records the range it replaced (so a test can ask what one undo
	 * would restore), and it dispatches `input` itself, synchronously — which is
	 * why the commit must emit `compositionend` first.
	 */
	enableNativeUndo(): void {
		this.ownerDocument.execCommand = (_command, _showUI, value): boolean => {
			if (this.readOnly) return false;
			const start = this.selectionStart;
			const end = this.selectionEnd;
			const inserted = value ?? "";
			this.commands.push({ start, end, removed: this.value.slice(start, end), inserted });
			this.setRangeText(inserted, start, end, "end");
			this.dispatchEvent(inputEvent("insertText", inserted, false));
			return true;
		};
	}
}

/** A `pointerdown` / `keydown` as the affordance sees it. */
export interface FakeInput {
	type: string;
	button?: number;
	pointerType?: string;
	key?: string;
	repeat?: boolean;
	defaultPrevented: boolean;
	preventDefault(): void;
}

export interface FakeElementEvents {
	inputs: FakeInput[];
}

/** A button: `dataset`, `style`, attributes, and the two listener surfaces. */
export class FakeButton {
	readonly dataset: Record<string, string> = {};
	readonly attributes = new Map<string, string>();
	readonly properties = new Map<string, string>();
	readonly style = {
		setProperty: (name: string, value: string) => {
			this.properties.set(name, value);
		},
		getPropertyValue: (name: string): string => this.properties.get(name) ?? "",
		removeProperty: (name: string) => {
			this.properties.delete(name);
		},
	};
	textContent = "";
	title = "";
	/** Every dispatched event, in order, with whether the adapter prevented it. */
	readonly events: FakeElementEvents = { inputs: [] };

	private readonly listeners = new Map<string, Set<(event: FakeInput) => void>>();

	get element(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	addEventListener(type: string, listener: (event: FakeInput) => void): void {
		const set = this.listeners.get(type) ?? new Set();
		set.add(listener);
		this.listeners.set(type, set);
	}

	removeEventListener(type: string, listener: (event: FakeInput) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	dispatch(type: string, properties: Omit<FakeInput, "type" | "defaultPrevented" | "preventDefault">): FakeInput {
		const event: FakeInput = {
			type,
			...properties,
			defaultPrevented: false,
			preventDefault() {
				event.defaultPrevented = true;
			},
		};
		this.events.inputs.push(event);
		for (const listener of this.listeners.get(type) ?? []) listener(event);
		return event;
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}
}

/**
 * `bindButton` listens on `window` for the release a button never receives: a
 * pointer that left the element, a keyup, a lost window. Install one for the
 * duration of a test and restore what was there.
 */
export interface FakeWindow {
	addEventListener(type: string, listener: (event: FakeInput) => void): void;
	removeEventListener(type: string, listener: (event: FakeInput) => void): void;
	dispatch(type: string, properties?: { key?: string }): void;
}

export function installFakeWindow(): { window: FakeWindow; restore(): void } {
	const listeners = new Map<string, Set<(event: FakeInput) => void>>();
	const fake: FakeWindow = {
		addEventListener(type, listener) {
			const set = listeners.get(type) ?? new Set();
			set.add(listener);
			listeners.set(type, set);
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener);
		},
		dispatch(type, properties = {}) {
			const event: FakeInput = {
				type,
				...properties,
				defaultPrevented: false,
				preventDefault() {
					event.defaultPrevented = true;
				},
			};
			for (const listener of listeners.get(type) ?? []) listener(event);
		},
	};

	// Node has no `window`; a previous value would be another test's fake.
	const previous: unknown = Reflect.get(globalThis, "window");
	Reflect.set(globalThis, "window", fake);
	return {
		window: fake,
		restore: () => {
			Reflect.set(globalThis, "window", previous);
		},
	};
}

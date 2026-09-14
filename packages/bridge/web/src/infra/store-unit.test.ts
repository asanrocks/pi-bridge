// Unit tests for the store's detach/pin semantics: detachInstance is the
// user's "back to the instance list" action — it must clear all session
// state AND pin the Launcher, and the pin must survive reconnect syncs
// (attachedInstanceId: null rollbacks) until a real attach clears it.

import { describe, expect, it } from "vitest";
import type { InstanceInfo } from "../../../src/core/index.ts";
import { createClientStore } from "./store.ts";

function inst(id: string): InstanceInfo {
	return { instanceId: id, sessionId: `sess-${id}`, cwd: "/proj", name: id, isStreaming: false };
}

function attachAndDirty(store: ReturnType<typeof createClientStore>) {
	store.getState().syncInstances({ instances: [inst("a")], attachedInstanceId: "a" });
	store.getState().setActiveSessionId("sess-a");
	store.getState().setFocusedTurnId("turn-1");
	store.getState().setDraft({ kind: "compose", text: "unsent" });
}

describe("detachInstance", () => {
	it("clears instance state and pins the launcher", () => {
		const store = createClientStore();
		attachAndDirty(store);
		expect(store.getState().attachedInstanceId).toBe("a");

		store.getState().detachInstance();

		const s = store.getState();
		expect(s.attachedInstanceId).toBeNull();
		expect(s.activeSessionId).toBeNull();
		expect(s.sessions).toEqual([]);
		expect(s.focusedTurnId).toBeNull();
		expect(s.draft).toEqual({ kind: "idle" });
		expect(s.document.entries).toEqual({});
		expect(s.launcherPinned).toBe(true);
	});

	it("the pin survives an attachedInstanceId: null sync (switch rollback)", () => {
		const store = createClientStore();
		store.getState().detachInstance();

		// Rollback path in useRpc.switchInstance failure.
		store.getState().syncInstances({ attachedInstanceId: null });
		expect(store.getState().launcherPinned).toBe(true);
	});

	it("the pin survives an instances-only sync (launcher poll)", () => {
		const store = createClientStore();
		store.getState().detachInstance();

		store.getState().syncInstances({ instances: [inst("a"), inst("b")] });
		expect(store.getState().launcherPinned).toBe(true);
		expect(store.getState().attachedInstanceId).toBeNull();
	});

	it("attaching clears the pin", () => {
		const store = createClientStore();
		store.getState().detachInstance();

		store.getState().syncInstances({ attachedInstanceId: "a" });
		expect(store.getState().launcherPinned).toBe(false);
	});

	it("instance_exit (clearInstance) does not pin — death is not a user choice", () => {
		const store = createClientStore();
		attachAndDirty(store);

		store.getState().clearInstance();

		expect(store.getState().attachedInstanceId).toBeNull();
		expect(store.getState().launcherPinned).toBe(false);
	});
});

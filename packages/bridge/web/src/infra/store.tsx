// ============================================================================
// React store context — provides the Zustand ClientStore to all components.
// Created once at app mount; consumed via useStore(selector).
// ============================================================================

import { createContext, useContext } from "react";
import { useStore as useZustandStore } from "zustand";
import { type ClientStore, createClientStore } from "./store.ts";

const store = createClientStore();
const StoreContext = createContext(store);

/** Provide the store to children. Wrap the app root. */
export function StoreProvider({ children }: { children: React.ReactNode }) {
	return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/**
 * Subscribe to a slice of the store with a selector.
 * Returns the selected value and triggers re-render on change.
 */
export function useStore<T>(selector: (state: ClientStore) => T): T {
	const s = useContext(StoreContext);
	return useZustandStore(s, selector);
}

/** Get the store object directly (for actions, outside render). */
export function getStore() {
	return store;
}

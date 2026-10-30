// ============================================================================
// React store context — provides the Zustand ClientStore to all components.
// The store instance lives in store.ts (DOM- and React-free) so the
// imperative connection and event paths can reach it without a context;
// this module adds the React bindings over that one instance.
// ============================================================================

import { createContext, useContext } from "react";
import { useStore as useZustandStore } from "zustand";
import { type ClientStore, getStore } from "./store.ts";

const store = getStore();
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
export { getStore };

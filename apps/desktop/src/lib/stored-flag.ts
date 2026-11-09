import { create, type StoreApi, type UseBoundStore } from "zustand";

/**
 * A choice kept across relaunches: off until turned on. Each window has its
 * own store and they share the remembered value, so another window's change
 * arrives here through the `storage` event.
 */
export function createStoredFlag(key: string): {
  store: UseBoundStore<StoreApi<{ on: boolean }>>;
  set: (on: boolean) => void;
} {
  const load = (): boolean => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  };
  const store = create<{ on: boolean }>(() => ({ on: load() }));
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.key === key) store.setState({ on: event.newValue === "1" });
    });
  }
  return {
    store,
    set: (on) => {
      store.setState({ on });
      try {
        localStorage.setItem(key, on ? "1" : "0");
      } catch {
        /* ignore */
      }
    },
  };
}

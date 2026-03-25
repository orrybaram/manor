import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface HistoryEntry {
  url: string;
  title: string;
  lastVisited: number; // Date.now()
}

interface BrowserHistoryState {
  entries: HistoryEntry[];
  addEntry: (url: string, title: string) => void;
  search: (query: string) => HistoryEntry[];
}

const MAX_ENTRIES = 50;
const MAX_SEARCH_RESULTS = 8;

export const useBrowserHistoryStore = create<BrowserHistoryState>()(
  persist(
    (set, get) => ({
      entries: [],

      addEntry: (url: string, title: string) => {
        if (url === "about:blank") return;

        set((state) => {
          const existing = state.entries.find((e) => e.url === url);
          let updated: HistoryEntry[];

          if (existing) {
            updated = state.entries
              .map((e) =>
                e.url === url ? { ...e, title, lastVisited: Date.now() } : e
              )
              .sort((a, b) => b.lastVisited - a.lastVisited);
          } else {
            const newEntry: HistoryEntry = { url, title, lastVisited: Date.now() };
            updated = [newEntry, ...state.entries].slice(0, MAX_ENTRIES);
          }

          return { entries: updated };
        });
      },

      search: (query: string): HistoryEntry[] => {
        if (!query) return [];

        const lower = query.toLowerCase();
        return get()
          .entries.filter(
            (e) =>
              e.url.toLowerCase().includes(lower) ||
              e.title.toLowerCase().includes(lower)
          )
          .sort((a, b) => b.lastVisited - a.lastVisited)
          .slice(0, MAX_SEARCH_RESULTS);
      },
    }),
    {
      name: "browser-history",
    }
  )
);

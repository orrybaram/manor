import { create } from "zustand";

/**
 * The Tasks view's count line ("3 of 43 tasks · 3 projects"), which the
 * status bar shows while the view is open. Null when the view is closed.
 */
type TasksSummaryState = {
  summary: string | null;
  setSummary: (summary: string | null) => void;
};

export const useTasksSummaryStore = create<TasksSummaryState>((set) => ({
  summary: null,
  setSummary: (summary) => set({ summary }),
}));

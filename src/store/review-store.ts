import { create } from "zustand";

export interface DraftComment {
  id: string;
  filePath: string;
  /** Inclusive index range into DiffFile.lines. The inline anchor. */
  startIndex: number;
  endIndex: number;
  /** Snapshot taken at creation, so the prompt survives anchor drift. */
  snippet: string;
  /** e.g. "L12" / "L12-L18", for the card header. */
  startLabel: string;
  body: string;
  createdAt: number;
}

interface ReviewStoreState {
  /** workspacePath -> comments, in creation order. */
  drafts: Record<string, DraftComment[]>;
  addDraft(
    workspacePath: string,
    draft: Omit<DraftComment, "id" | "createdAt">,
  ): string;
  updateDraft(workspacePath: string, id: string, body: string): void;
  removeDraft(workspacePath: string, id: string): void;
  clearWorkspace(workspacePath: string): void;
}

/**
 * Stable empty identity for a workspace with no review in progress, so
 * `drafts[ws] ?? NO_DRAFTS` does not force a re-render every time a caller
 * reads an absent key. Mirrors `NO_STAGED_FILES` in `DiffPane.tsx`.
 */
export const NO_DRAFTS: DraftComment[] = [];

export const useReviewStore = create<ReviewStoreState>((set) => ({
  drafts: {},

  addDraft: (workspacePath, draft) => {
    const id = crypto.randomUUID();
    set((s) => {
      const existing = s.drafts[workspacePath] ?? NO_DRAFTS;
      const comment: DraftComment = { ...draft, id, createdAt: Date.now() };
      return {
        drafts: { ...s.drafts, [workspacePath]: [...existing, comment] },
      };
    });
    return id;
  },

  updateDraft: (workspacePath, id, body) =>
    set((s) => {
      const existing = s.drafts[workspacePath];
      if (!existing) return s;
      return {
        drafts: {
          ...s.drafts,
          [workspacePath]: existing.map((d) =>
            d.id === id ? { ...d, body } : d,
          ),
        },
      };
    }),

  removeDraft: (workspacePath, id) =>
    set((s) => {
      const existing = s.drafts[workspacePath];
      if (!existing) return s;
      const next = existing.filter((d) => d.id !== id);
      const drafts = { ...s.drafts };
      if (next.length > 0) drafts[workspacePath] = next;
      else delete drafts[workspacePath];
      return { drafts };
    }),

  clearWorkspace: (workspacePath) =>
    set((s) => {
      if (!(workspacePath in s.drafts)) return s;
      const drafts = { ...s.drafts };
      delete drafts[workspacePath];
      return { drafts };
    }),
}));

import { create } from "zustand";
import type { FileSearchParams } from "../../../electron.d";

/** What the Search view's fields hold, as typed. */
export type SearchForm = {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Comma-separated globs, as typed. */
  include: string;
  exclude: string;
};

/**
 * A search asked for from outside the view: ⌘⇧F with a selection, or Find
 * Usages / Go to Definition. It replaces the query, and the toggles it names
 * (the rest stay as they were); the globs stay. It runs at once, without the
 * typing debounce, under `label` ("Usages of x") until the query is edited.
 */
export type SearchRequest = {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  label?: string | null;
};

/** A file pane's Search view, kept by pane so it survives a view switch or a remount. */
export type PaneSearch = {
  form: SearchForm;
  /** The pill over the results; null for a search typed in the view. */
  label: string | null;
  /** Counts requests from outside: each new one runs at once. */
  asked: number;
  /** Files whose matches are folded away. */
  collapsed: string[];
};

export const EMPTY_FORM: SearchForm = {
  query: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: "",
  exclude: "",
};

const EMPTY: PaneSearch = { form: EMPTY_FORM, label: null, asked: 0, collapsed: [] };

type Store = {
  byPane: Record<string, PaneSearch>;
  /** The user changed fields: the label no longer describes the search. */
  edit: (paneId: string, patch: Partial<SearchForm>) => void;
  request: (paneId: string, request: SearchRequest) => void;
  setCollapsed: (paneId: string, collapsed: string[]) => void;
  /** Clear results: an empty query, no label; the toggles and globs stay. */
  clear: (paneId: string) => void;
  drop: (paneId: string) => void;
};

function update(
  byPane: Record<string, PaneSearch>,
  paneId: string,
  next: (prev: PaneSearch) => PaneSearch,
): Record<string, PaneSearch> {
  return { ...byPane, [paneId]: next(byPane[paneId] ?? EMPTY) };
}

/** Each file pane's Search view; the pane drops its entry once it is closed. */
export const useFileSearchState = create<Store>((set) => ({
  byPane: {},
  edit: (paneId, patch) =>
    set((s) => ({
      byPane: update(s.byPane, paneId, (p) => ({
        ...p,
        form: { ...p.form, ...patch },
        label: null,
        // A new search lists every file open again.
        collapsed: [],
      })),
    })),
  request: (paneId, request) =>
    set((s) => ({ byPane: update(s.byPane, paneId, (p) => applyRequest(p, request)) })),
  setCollapsed: (paneId, collapsed) =>
    set((s) => ({ byPane: update(s.byPane, paneId, (p) => ({ ...p, collapsed })) })),
  clear: (paneId) =>
    set((s) => ({
      byPane: update(s.byPane, paneId, (p) => ({
        ...p,
        form: { ...p.form, query: "" },
        label: null,
        asked: p.asked + 1,
        collapsed: [],
      })),
    })),
  drop: (paneId) =>
    set((s) => {
      if (!(paneId in s.byPane)) return s;
      const { [paneId]: _gone, ...rest } = s.byPane;
      return { byPane: rest };
    }),
}));

/** `pane`'s search once `request` is applied to it. */
export function applyRequest(pane: PaneSearch, request: SearchRequest): PaneSearch {
  const { form } = pane;
  return {
    form: {
      ...form,
      query: request.query,
      caseSensitive: request.caseSensitive ?? form.caseSensitive,
      wholeWord: request.wholeWord ?? form.wholeWord,
      regex: request.regex ?? form.regex,
    },
    label: request.label ?? null,
    asked: pane.asked + 1,
    collapsed: [],
  };
}

export function paneSearch(byPane: Record<string, PaneSearch>, paneId: string): PaneSearch {
  return byPane[paneId] ?? EMPTY;
}

/** "src/**, *.test.ts ," → ["src/**", "*.test.ts"]. */
export function parseGlobs(text: string): string[] {
  return text
    .split(",")
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0);
}

/** What `files.search` is asked for `form`. */
export function searchParams(form: SearchForm): FileSearchParams {
  return {
    query: form.query,
    caseSensitive: form.caseSensitive,
    wholeWord: form.wholeWord,
    regex: form.regex,
    include: parseGlobs(form.include),
    exclude: parseGlobs(form.exclude),
  };
}

/** The editor's selection as a query: one non-blank line, else nothing. */
export function selectionQuery(selection: string | null | undefined): string | null {
  if (!selection || /[\r\n]/.test(selection) || selection.trim() === "") return null;
  return selection;
}

// ── Opening the view from outside ──

const asked = new Set<string>();
const listeners = new Map<string, () => void>();

/**
 * Ask `paneId`'s file pane to open its Search view with the input focused,
 * running `request` there if given. The pane takes the ask once: as it
 * mounts (a pane just made for it), or at once when it is mounted. This is
 * the entry point for ⌘⇧F from elsewhere and for Find Usages / Go to
 * Definition.
 */
export function requestSearch(paneId: string, request?: SearchRequest | null): void {
  if (request) useFileSearchState.getState().request(paneId, request);
  asked.add(paneId);
  listeners.get(paneId)?.();
}

/** Whether `paneId` was asked to open Search, taken: it is answered once. */
export function takeSearchRequest(paneId: string): boolean {
  return asked.delete(paneId);
}

/** Called on each ask for `paneId`, while its file pane is mounted. */
export function onSearchRequest(paneId: string, listener: () => void): () => void {
  listeners.set(paneId, listener);
  return () => {
    if (listeners.get(paneId) === listener) listeners.delete(paneId);
  };
}

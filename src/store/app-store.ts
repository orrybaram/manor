import { create } from "zustand";
import {
  type PaneNode,
  type SplitDirection,
  allPaneIds,
  insertSplit,
  removePane,
  nextPaneId,
} from "./pane-tree";

function newPaneId(): string {
  return `pane-${crypto.randomUUID()}`;
}

function newTabId(): string {
  return `tab-${crypto.randomUUID()}`;
}

export interface Tab {
  id: string;
  title: string;
  rootNode: PaneNode;
  focusedPaneId: string;
}

function createTab(title?: string): Tab {
  const paneId = newPaneId();
  return {
    id: newTabId(),
    title: title ?? "Terminal",
    rootNode: { type: "leaf", paneId },
    focusedPaneId: paneId,
  };
}

export interface AppState {
  tabs: Tab[];
  selectedTabId: string;
  paneCwd: Record<string, string>;

  // Tab operations
  addTab: () => void;
  closeTab: (tabId: string) => void;
  selectTab: (tabId: string) => void;
  selectNextTab: () => void;
  selectPrevTab: () => void;

  // Pane operations
  splitPane: (direction: SplitDirection) => void;
  closePane: () => void;
  focusPane: (paneId: string) => void;
  focusNextPane: () => void;

  // CWD tracking
  setPaneCwd: (paneId: string, cwd: string) => void;

  // Resize
  updateSplitRatio: (firstPaneId: string, ratio: number) => void;
}

export const useAppStore = create<AppState>((set, get) => {
  const initialTab = createTab();

  return {
    tabs: [initialTab],
    selectedTabId: initialTab.id,
    paneCwd: {},

    addTab: () =>
      set((state) => {
        const tab = createTab();
        return {
          tabs: [...state.tabs, tab],
          selectedTabId: tab.id,
        };
      }),

    closeTab: (tabId: string) =>
      set((state) => {
        if (state.tabs.length <= 1) return state; // keep at least one tab
        const idx = state.tabs.findIndex((t) => t.id === tabId);
        const newTabs = state.tabs.filter((t) => t.id !== tabId);
        const newSelected =
          tabId === state.selectedTabId
            ? newTabs[Math.min(idx, newTabs.length - 1)].id
            : state.selectedTabId;
        return { tabs: newTabs, selectedTabId: newSelected };
      }),

    selectTab: (tabId: string) => set({ selectedTabId: tabId }),

    selectNextTab: () =>
      set((state) => {
        const idx = state.tabs.findIndex(
          (t) => t.id === state.selectedTabId
        );
        const next = (idx + 1) % state.tabs.length;
        return { selectedTabId: state.tabs[next].id };
      }),

    selectPrevTab: () =>
      set((state) => {
        const idx = state.tabs.findIndex(
          (t) => t.id === state.selectedTabId
        );
        const prev = (idx - 1 + state.tabs.length) % state.tabs.length;
        return { selectedTabId: state.tabs[prev].id };
      }),

    splitPane: (direction: SplitDirection) =>
      set((state) => {
        const tab = state.tabs.find((t) => t.id === state.selectedTabId);
        if (!tab) return state;
        const newPane = newPaneId();
        const newRoot = insertSplit(
          tab.rootNode,
          tab.focusedPaneId,
          direction,
          newPane
        );
        return {
          tabs: state.tabs.map((t) =>
            t.id === tab.id
              ? { ...t, rootNode: newRoot, focusedPaneId: newPane }
              : t
          ),
        };
      }),

    closePane: () => {
      const state = get();
      const tab = state.tabs.find((t) => t.id === state.selectedTabId);
      if (!tab) return;

      const remaining = removePane(tab.rootNode, tab.focusedPaneId);
      if (remaining === null) {
        // Last pane in tab — close the tab
        get().closeTab(tab.id);
        return;
      }

      const ids = allPaneIds(remaining);
      const newFocused = ids[0];

      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tab.id
            ? { ...t, rootNode: remaining, focusedPaneId: newFocused }
            : t
        ),
      }));
    },

    focusPane: (paneId: string) =>
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === state.selectedTabId
            ? { ...t, focusedPaneId: paneId }
            : t
        ),
      })),

    focusNextPane: () =>
      set((state) => {
        const tab = state.tabs.find((t) => t.id === state.selectedTabId);
        if (!tab) return state;
        const next = nextPaneId(tab.rootNode, tab.focusedPaneId);
        if (!next) return state;
        return {
          tabs: state.tabs.map((t) =>
            t.id === tab.id ? { ...t, focusedPaneId: next } : t
          ),
        };
      }),

    setPaneCwd: (paneId: string, cwd: string) =>
      set((state) => ({
        paneCwd: { ...state.paneCwd, [paneId]: cwd },
      })),

    updateSplitRatio: (_firstPaneId: string, _ratio: number) =>
      set((state) => {
        // TODO: implement ratio update via pane-tree.updateRatio
        return state;
      }),
  };
});

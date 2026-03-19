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

function newSessionId(): string {
  return `session-${crypto.randomUUID()}`;
}

export interface Session {
  id: string;
  title: string;
  rootNode: PaneNode;
  focusedPaneId: string;
}

function createSession(title?: string): Session {
  const paneId = newPaneId();
  return {
    id: newSessionId(),
    title: title ?? "Terminal",
    rootNode: { type: "leaf", paneId },
    focusedPaneId: paneId,
  };
}

interface WorkspaceSessionState {
  sessions: Session[];
  selectedSessionId: string;
}

function createWorkspaceState(): WorkspaceSessionState {
  const session = createSession();
  return { sessions: [session], selectedSessionId: session.id };
}

export interface AppState {
  workspaceSessions: Record<string, WorkspaceSessionState>;
  activeWorkspacePath: string | null;
  paneCwd: Record<string, string>;

  // Workspace activation
  setActiveWorkspace: (path: string) => void;

  // Session operations
  addSession: () => void;
  closeSession: (sessionId: string) => void;
  selectSession: (sessionId: string) => void;
  selectNextSession: () => void;
  selectPrevSession: () => void;

  // Pane operations
  splitPane: (direction: SplitDirection) => void;
  closePane: () => void;
  focusPane: (paneId: string) => void;
  focusNextPane: () => void;

  // CWD tracking
  setPaneCwd: (paneId: string, cwd: string) => void;

  // Zoom
  fontSize: number;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;

  // Resize
  updateSplitRatio: (firstPaneId: string, ratio: number) => void;
}

// Selector for the active workspace's session state
export function selectActiveWorkspace(state: AppState): WorkspaceSessionState | null {
  if (!state.activeWorkspacePath) return null;
  return state.workspaceSessions[state.activeWorkspacePath] ?? null;
}

const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

export const useAppStore = create<AppState>((set, get) => ({
  workspaceSessions: {},
  activeWorkspacePath: null,
  paneCwd: {},
  fontSize: DEFAULT_FONT_SIZE,

  setActiveWorkspace: (path: string) =>
    set((state) => {
      if (state.workspaceSessions[path]) {
        return { activeWorkspacePath: path };
      }
      return {
        activeWorkspacePath: path,
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: createWorkspaceState(),
        },
      };
    }),

  addSession: () =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;
      const session = createSession();
      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: { sessions: [...ws.sessions, session], selectedSessionId: session.id },
        },
      };
    }),

  closeSession: (sessionId: string) =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws || ws.sessions.length <= 1) return state;
      const idx = ws.sessions.findIndex((s) => s.id === sessionId);
      const newSessions = ws.sessions.filter((s) => s.id !== sessionId);
      const newSelected =
        sessionId === ws.selectedSessionId
          ? newSessions[Math.min(idx, newSessions.length - 1)].id
          : ws.selectedSessionId;
      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: { sessions: newSessions, selectedSessionId: newSelected },
        },
      };
    }),

  selectSession: (sessionId: string) =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;
      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: { ...ws, selectedSessionId: sessionId },
        },
      };
    }),

  selectNextSession: () =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;
      const idx = ws.sessions.findIndex((s) => s.id === ws.selectedSessionId);
      const next = (idx + 1) % ws.sessions.length;
      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: { ...ws, selectedSessionId: ws.sessions[next].id },
        },
      };
    }),

  selectPrevSession: () =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;
      const idx = ws.sessions.findIndex((s) => s.id === ws.selectedSessionId);
      const prev = (idx - 1 + ws.sessions.length) % ws.sessions.length;
      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: { ...ws, selectedSessionId: ws.sessions[prev].id },
        },
      };
    }),

  splitPane: (direction: SplitDirection) =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;
      const session = ws.sessions.find((s) => s.id === ws.selectedSessionId);
      if (!session) return state;
      const newPane = newPaneId();
      const newRoot = insertSplit(session.rootNode, session.focusedPaneId, direction, newPane);
      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: {
            ...ws,
            sessions: ws.sessions.map((s) =>
              s.id === session.id ? { ...s, rootNode: newRoot, focusedPaneId: newPane } : s
            ),
          },
        },
      };
    }),

  closePane: () => {
    const state = get();
    const path = state.activeWorkspacePath;
    if (!path) return;
    const ws = state.workspaceSessions[path];
    if (!ws) return;
    const session = ws.sessions.find((s) => s.id === ws.selectedSessionId);
    if (!session) return;

    const remaining = removePane(session.rootNode, session.focusedPaneId);
    if (remaining === null) {
      get().closeSession(session.id);
      return;
    }

    const ids = allPaneIds(remaining);
    const newFocused = ids[0];

    set((s) => {
      const currentWs = s.workspaceSessions[path];
      if (!currentWs) return s;
      return {
        workspaceSessions: {
          ...s.workspaceSessions,
          [path]: {
            ...currentWs,
            sessions: currentWs.sessions.map((t) =>
              t.id === session.id
                ? { ...t, rootNode: remaining, focusedPaneId: newFocused }
                : t
            ),
          },
        },
      };
    });
  },

  focusPane: (paneId: string) =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;
      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: {
            ...ws,
            sessions: ws.sessions.map((s) =>
              s.id === ws.selectedSessionId ? { ...s, focusedPaneId: paneId } : s
            ),
          },
        },
      };
    }),

  focusNextPane: () =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;
      const session = ws.sessions.find((s) => s.id === ws.selectedSessionId);
      if (!session) return state;
      const next = nextPaneId(session.rootNode, session.focusedPaneId);
      if (!next) return state;
      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: {
            ...ws,
            sessions: ws.sessions.map((s) =>
              s.id === session.id ? { ...s, focusedPaneId: next } : s
            ),
          },
        },
      };
    }),

  setPaneCwd: (paneId: string, cwd: string) =>
    set((state) => ({
      paneCwd: { ...state.paneCwd, [paneId]: cwd },
    })),

  zoomIn: () => set((state) => ({ fontSize: Math.min(state.fontSize + 1, MAX_FONT_SIZE) })),
  zoomOut: () => set((state) => ({ fontSize: Math.max(state.fontSize - 1, MIN_FONT_SIZE) })),
  resetZoom: () => set({ fontSize: DEFAULT_FONT_SIZE }),

  updateSplitRatio: (_firstPaneId: string, _ratio: number) =>
    set((state) => {
      // TODO: implement ratio update via pane-tree.updateRatio
      return state;
    }),
}));

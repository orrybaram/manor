import { create } from "zustand";
import {
  type PaneNode,
  type SplitDirection,
  allPaneIds,
  insertSplit,
  removePane,
  nextPaneId,
  prevPaneId,
} from "./pane-tree";
import type {
  PersistedWorkspace,
  PersistedSession,
  PersistedLayout,
  AgentState,
} from "../electron.d";

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
  pinnedSessionIds: string[];
}

function createWorkspaceState(): WorkspaceSessionState {
  const session = createSession();
  return { sessions: [session], selectedSessionId: session.id, pinnedSessionIds: [] };
}

/** Convert a PersistedWorkspace back into a WorkspaceSessionState */
function restoreWorkspaceState(
  persisted: PersistedWorkspace,
): WorkspaceSessionState {
  const sessions: Session[] = persisted.sessions.map((ps) => ({
    id: ps.id,
    title: ps.title,
    rootNode: ps.rootNode,
    focusedPaneId: ps.focusedPaneId,
  }));

  if (sessions.length === 0) {
    return createWorkspaceState();
  }

  return {
    sessions,
    selectedSessionId: persisted.selectedSessionId || sessions[0].id,
    pinnedSessionIds: persisted.pinnedSessionIds ?? [],
  };
}

export interface AppState {
  workspaceSessions: Record<string, WorkspaceSessionState>;
  activeWorkspacePath: string | null;
  paneCwd: Record<string, string>;
  paneTitle: Record<string, string>;
  paneAgentStatus: Record<string, AgentState>;
  layoutLoaded: boolean;
  /** Pane IDs that were explicitly closed by the user (should be killed, not detached) */
  closedPaneIds: Set<string>;
  /** Pending startup commands to run in new terminals (workspace path → script) */
  pendingStartupCommands: Record<string, string>;
  // Workspace activation
  setActiveWorkspace: (path: string) => void;

  // Layout restore — called once on startup
  loadPersistedLayout: () => Promise<void>;

  // Session operations
  addSession: () => void;
  closeSession: (sessionId: string) => void;
  selectSession: (sessionId: string) => void;
  selectNextSession: () => void;
  selectPrevSession: () => void;
  reorderSessions: (sessionIds: string[]) => void;
  togglePinSession: (sessionId: string) => void;

  // Pane operations
  splitPane: (direction: SplitDirection) => void;
  closePane: () => void;
  closePaneById: (paneId: string) => void;
  focusPane: (paneId: string) => void;
  focusNextPane: () => void;
  focusPrevPane: () => void;

  // CWD tracking
  setPaneCwd: (paneId: string, cwd: string) => void;

  // Title tracking (from terminal OSC sequences)
  setPaneTitle: (paneId: string, title: string) => void;

  // Agent status tracking
  setPaneAgentStatus: (paneId: string, agent: AgentState) => void;

  // Zoom
  fontSize: number;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;

  // Startup commands
  setPendingStartupCommand: (workspacePath: string, command: string) => void;
  consumePendingStartupCommand: (workspacePath: string) => string | null;

  // Workspace cleanup
  removeWorkspaceSessions: (workspacePath: string) => void;

  // Resize
  updateSplitRatio: (firstPaneId: string, ratio: number) => void;
}

// Selector for the active workspace's session state
export function selectActiveWorkspace(
  state: AppState,
): WorkspaceSessionState | null {
  if (!state.activeWorkspacePath) return null;
  return state.workspaceSessions[state.activeWorkspacePath] ?? null;
}

const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

// Cache the loaded layout so setActiveWorkspace can check it synchronously
let _cachedLayout: PersistedLayout | null = null;

export const useAppStore = create<AppState>((set, get) => ({
  workspaceSessions: {},
  activeWorkspacePath: null,
  paneCwd: {},
  paneTitle: {},
  paneAgentStatus: {},
  fontSize: DEFAULT_FONT_SIZE,
  layoutLoaded: false,
  closedPaneIds: new Set<string>(),
  pendingStartupCommands: {},

  loadPersistedLayout: async () => {
    try {
      const layout = await window.electronAPI?.layout.load();
      if (layout) {
        _cachedLayout = layout;

        // Pre-populate paneCwd, paneTitle, and paneAgentStatus from persisted data
        const cwds: Record<string, string> = {};
        const titles: Record<string, string> = {};
        const agents: Record<string, AgentState> = {};
        for (const ws of layout.workspaces) {
          for (const session of ws.sessions) {
            for (const [paneId, paneSession] of Object.entries(
              session.paneSessions,
            )) {
              if (paneSession.lastCwd) {
                cwds[paneId] = paneSession.lastCwd;
              }
              if (paneSession.lastTitle) {
                titles[paneId] = paneSession.lastTitle;
              }
              if (paneSession.lastAgentStatus &&
                  !(paneSession.lastAgentStatus.status === "idle" && paneSession.lastAgentStatus.kind === null)) {
                agents[paneId] = paneSession.lastAgentStatus as AgentState;
              }
            }
          }
        }

        set({
          layoutLoaded: true,
          paneCwd: { ...get().paneCwd, ...cwds },
          paneTitle: { ...get().paneTitle, ...titles },
          paneAgentStatus: { ...get().paneAgentStatus, ...agents },
        });
      } else {
        set({ layoutLoaded: true });
      }
    } catch {
      set({ layoutLoaded: true });
    }
  },

  setActiveWorkspace: (path: string) =>
    set((state) => {
      // Already initialized for this workspace
      if (state.workspaceSessions[path]) {
        return { activeWorkspacePath: path };
      }

      // Check persisted layout for this workspace
      if (_cachedLayout) {
        const persisted = _cachedLayout.workspaces.find(
          (w) => w.workspacePath === path,
        );
        if (persisted && persisted.sessions.length > 0) {
          return {
            activeWorkspacePath: path,
            workspaceSessions: {
              ...state.workspaceSessions,
              [path]: restoreWorkspaceState(persisted),
            },
          };
        }
      }

      // No persisted state — create fresh
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
          [path]: {
            sessions: [...ws.sessions, session],
            selectedSessionId: session.id,
          },
        },
      };
    }),

  closeSession: (sessionId: string) =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;

      // Mark all panes in the closing session as explicitly closed
      const closingSession = ws.sessions.find((s) => s.id === sessionId);
      const deadPaneIds: string[] = [];
      if (closingSession) {
        for (const pid of allPaneIds(closingSession.rootNode)) {
          state.closedPaneIds.add(pid);
          deadPaneIds.push(pid);
        }
      }

      const idx = ws.sessions.findIndex((s) => s.id === sessionId);
      const newSessions = ws.sessions.filter((s) => s.id !== sessionId);
      const newSelected =
        newSessions.length === 0
          ? ""
          : sessionId === ws.selectedSessionId
            ? newSessions[Math.min(idx, newSessions.length - 1)].id
            : ws.selectedSessionId;

      // Clean up metadata for dead panes
      const newCwd = { ...state.paneCwd };
      const newTitle = { ...state.paneTitle };
      const newAgentStatus = { ...state.paneAgentStatus };
      for (const pid of deadPaneIds) {
        delete newCwd[pid];
        delete newTitle[pid];
        delete newAgentStatus[pid];
      }

      return {
        paneCwd: newCwd,
        paneTitle: newTitle,
        paneAgentStatus: newAgentStatus,
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: {
            sessions: newSessions,
            selectedSessionId: newSelected,
            pinnedSessionIds: (ws.pinnedSessionIds ?? []).filter((id) => id !== sessionId),
          },
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
      const nextId = ws.sessions[next].id;
      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: { ...ws, selectedSessionId: nextId },
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
      const prevId = ws.sessions[prev].id;
      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: { ...ws, selectedSessionId: prevId },
        },
      };
    }),

  reorderSessions: (sessionIds: string[]) =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;
      const lookup = new Map(ws.sessions.map((s) => [s.id, s]));
      const reordered = sessionIds
        .map((id) => lookup.get(id))
        .filter(Boolean) as Session[];
      if (reordered.length !== ws.sessions.length) return state;
      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: { ...ws, sessions: reordered },
        },
      };
    }),

  togglePinSession: (sessionId: string) =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;
      const pinned = ws.pinnedSessionIds ?? [];
      const isPinned = pinned.includes(sessionId);
      let newPinned: string[];
      let newSessions: Session[];
      if (isPinned) {
        // Unpin: remove from pinned list, move to after last pinned tab
        newPinned = pinned.filter((id) => id !== sessionId);
        const session = ws.sessions.find((s) => s.id === sessionId);
        if (!session) return state;
        const others = ws.sessions.filter((s) => s.id !== sessionId);
        const insertIdx = newPinned.length;
        newSessions = [...others.slice(0, insertIdx), session, ...others.slice(insertIdx)];
      } else {
        newPinned = [...pinned, sessionId];
        const session = ws.sessions.find((s) => s.id === sessionId);
        if (!session) return state;
        const others = ws.sessions.filter((s) => s.id !== sessionId);
        const insertIdx = pinned.length;
        newSessions = [...others.slice(0, insertIdx), session, ...others.slice(insertIdx)];
      }
      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: { ...ws, sessions: newSessions, pinnedSessionIds: newPinned },
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
      const newRoot = insertSplit(
        session.rootNode,
        session.focusedPaneId,
        direction,
        newPane,
      );
      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: {
            ...ws,
            sessions: ws.sessions.map((s) =>
              s.id === session.id
                ? { ...s, rootNode: newRoot, focusedPaneId: newPane }
                : s,
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
    get().closePaneById(session.focusedPaneId);
  },

  closePaneById: (paneId: string) => {
    const state = get();
    const path = state.activeWorkspacePath;
    if (!path) return;
    const ws = state.workspaceSessions[path];
    if (!ws) return;

    const session = ws.sessions.find((s) =>
      allPaneIds(s.rootNode).includes(paneId),
    );
    if (!session) return;

    state.closedPaneIds.add(paneId);

    const remaining = removePane(session.rootNode, paneId);
    if (remaining === null) {
      for (const pid of allPaneIds(session.rootNode)) {
        state.closedPaneIds.add(pid);
      }
      get().closeSession(session.id);
      return;
    }

    const ids = allPaneIds(remaining);
    const newFocused =
      session.focusedPaneId === paneId ? ids[0] : session.focusedPaneId;

    set((s) => {
      const currentWs = s.workspaceSessions[path];
      if (!currentWs) return s;
      const newCwd = { ...s.paneCwd };
      const newTitle = { ...s.paneTitle };
      const newAgentStatus = { ...s.paneAgentStatus };
      delete newCwd[paneId];
      delete newTitle[paneId];
      delete newAgentStatus[paneId];
      return {
        paneCwd: newCwd,
        paneTitle: newTitle,
        paneAgentStatus: newAgentStatus,
        workspaceSessions: {
          ...s.workspaceSessions,
          [path]: {
            ...currentWs,
            sessions: currentWs.sessions.map((t) =>
              t.id === session.id
                ? { ...t, rootNode: remaining, focusedPaneId: newFocused }
                : t,
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
              s.id === ws.selectedSessionId
                ? { ...s, focusedPaneId: paneId }
                : s,
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
              s.id === session.id ? { ...s, focusedPaneId: next } : s,
            ),
          },
        },
      };
    }),

  focusPrevPane: () =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;
      const session = ws.sessions.find((s) => s.id === ws.selectedSessionId);
      if (!session) return state;
      const prev = prevPaneId(session.rootNode, session.focusedPaneId);
      if (!prev) return state;
      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: {
            ...ws,
            sessions: ws.sessions.map((s) =>
              s.id === session.id ? { ...s, focusedPaneId: prev } : s,
            ),
          },
        },
      };
    }),

  setPaneCwd: (paneId: string, cwd: string) =>
    set((state) => {
      if (state.paneCwd[paneId] === cwd) return state;
      return { paneCwd: { ...state.paneCwd, [paneId]: cwd } };
    }),

  setPaneTitle: (paneId: string, title: string) =>
    set((state) => {
      if (state.paneTitle[paneId] === title) return state;
      return { paneTitle: { ...state.paneTitle, [paneId]: title } };
    }),

  setPaneAgentStatus: (paneId: string, agent: AgentState) =>
    set((state) => {
      const current = state.paneAgentStatus[paneId];
      if (
        current &&
        current.status === agent.status &&
        current.kind === agent.kind &&
        current.since === agent.since &&
        current.title === agent.title &&
        current.processName === agent.processName
      )
        return state;
      // Remove from store only when agent is truly gone (kind is null)
      if (agent.status === "idle" && agent.kind === null) {
        const { [paneId]: _, ...rest } = state.paneAgentStatus;
        return { paneAgentStatus: rest };
      }
      return { paneAgentStatus: { ...state.paneAgentStatus, [paneId]: agent } };
    }),

  zoomIn: () =>
    set((state) => ({ fontSize: Math.min(state.fontSize + 1, MAX_FONT_SIZE) })),
  zoomOut: () =>
    set((state) => ({ fontSize: Math.max(state.fontSize - 1, MIN_FONT_SIZE) })),
  resetZoom: () => set({ fontSize: DEFAULT_FONT_SIZE }),

  setPendingStartupCommand: (workspacePath: string, command: string) =>
    set((state) => ({
      pendingStartupCommands: {
        ...state.pendingStartupCommands,
        [workspacePath]: command,
      },
    })),

  consumePendingStartupCommand: (workspacePath: string) => {
    const cmd = get().pendingStartupCommands[workspacePath] ?? null;
    if (cmd) {
      set((state) => {
        const { [workspacePath]: _, ...rest } = state.pendingStartupCommands;
        return { pendingStartupCommands: rest };
      });
    }
    return cmd;
  },

  removeWorkspaceSessions: (workspacePath: string) =>
    set((state) => {
      const ws = state.workspaceSessions[workspacePath];
      if (!ws) {
        const { [workspacePath]: _, ...rest } = state.workspaceSessions;
        return { workspaceSessions: rest };
      }

      // Mark all panes as closed so terminals get killed
      const deadPaneIds: string[] = [];
      for (const session of ws.sessions) {
        for (const pid of allPaneIds(session.rootNode)) {
          state.closedPaneIds.add(pid);
          deadPaneIds.push(pid);
        }
      }

      // Clean up metadata
      const newCwd = { ...state.paneCwd };
      const newTitle = { ...state.paneTitle };
      const newAgentStatus = { ...state.paneAgentStatus };
      for (const pid of deadPaneIds) {
        delete newCwd[pid];
        delete newTitle[pid];
        delete newAgentStatus[pid];
      }

      const { [workspacePath]: _, ...rest } = state.workspaceSessions;
      return {
        workspaceSessions: rest,
        paneCwd: newCwd,
        paneTitle: newTitle,
        paneAgentStatus: newAgentStatus,
      };
    }),

  updateSplitRatio: (_firstPaneId: string, _ratio: number) =>
    set((state) => {
      // TODO: implement ratio update via pane-tree.updateRatio
      return state;
    }),
}));

// ── Layout Persistence ──

let saveLayoutTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced save of the active workspace's layout to disk */
function saveActiveWorkspaceLayout(): void {
  if (saveLayoutTimer) clearTimeout(saveLayoutTimer);
  saveLayoutTimer = setTimeout(() => {
    saveLayoutTimer = null;

    const state = useAppStore.getState();
    const wsPath = state.activeWorkspacePath;
    if (!wsPath) return;
    const ws = state.workspaceSessions[wsPath];
    if (!ws) return;

    const persisted: PersistedWorkspace = {
      workspacePath: wsPath,
      sessions: ws.sessions.map((s) => {
        const paneIds = allPaneIds(s.rootNode);
        const paneSessions: Record<
          string,
          {
            daemonSessionId: string;
            lastCwd: string | null;
            lastTitle: string | null;
            lastAgentStatus?: AgentState | null;
          }
        > = {};
        for (const pid of paneIds) {
          paneSessions[pid] = {
            daemonSessionId: pid,
            lastCwd: state.paneCwd[pid] ?? null,
            lastTitle: state.paneTitle[pid] ?? null,
            lastAgentStatus: state.paneAgentStatus[pid] ?? null,
          };
        }
        return {
          id: s.id,
          title: s.title,
          rootNode: s.rootNode,
          focusedPaneId: s.focusedPaneId,
          paneSessions,
        } satisfies PersistedSession;
      }),
      selectedSessionId: ws.selectedSessionId,
      pinnedSessionIds: ws.pinnedSessionIds,
    };

    window.electronAPI?.layout.save(persisted);
  }, 500);
}

// Subscribe to store changes and auto-save layout
useAppStore.subscribe((state, prevState) => {
  if (
    state.workspaceSessions !== prevState.workspaceSessions ||
    state.activeWorkspacePath !== prevState.activeWorkspacePath ||
    state.paneAgentStatus !== prevState.paneAgentStatus
  ) {
    saveActiveWorkspaceLayout();
  }
});

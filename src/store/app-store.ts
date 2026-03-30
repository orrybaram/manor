import { create } from "zustand";
import {
  type PaneNode,
  type SplitDirection,
  allPaneIds,
  hasPaneId,
  insertSplit,
  insertSplitAt,
  movePane,
  insertSubtreeAt,
  removePane,
  nextPaneId,
  prevPaneId,
} from "./pane-tree";
import type {
  PersistedWorkspace,
  PersistedSession,
  PersistedLayout,
  AgentState,
  PickedElementResult,
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

function createEmptyWorkspaceState(): WorkspaceSessionState {
  return {
    sessions: [],
    selectedSessionId: "",
    pinnedSessionIds: [],
  };
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
    return createEmptyWorkspaceState();
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
  paneContentType: Record<string, "terminal" | "browser" | "diff">;
  paneUrl: Record<string, string>;
  panePickedElement: Record<string, PickedElementResult>;
  webviewFocusedPaneId: string | null;
  layoutLoaded: boolean;
  /** Pane IDs that were explicitly closed by the user (should be killed, not detached) */
  closedPaneIds: Set<string>;
  /** Pending startup commands to run in new terminals (workspace path → script) */
  pendingStartupCommands: Record<string, string>;
  /** Pane ID awaiting close confirmation (when agent is active) */
  pendingCloseConfirmPaneId: string | null;
  /** Session ID awaiting close confirmation (when agent is active in a pane) */
  pendingCloseConfirmSessionId: string | null;
  // Workspace activation
  setActiveWorkspace: (path: string) => void;

  // Layout restore — called once on startup
  loadPersistedLayout: () => Promise<void>;

  // Session operations
  addSession: () => void;
  addBrowserSession: (url: string) => void;
  addDiffSession: () => void;
  closeSession: (sessionId: string) => void;
  requestCloseSession: (sessionId: string) => void;
  setPendingCloseConfirmSessionId: (sessionId: string | null) => void;
  selectSession: (sessionId: string) => void;
  selectNextSession: () => void;
  selectPrevSession: () => void;
  reorderSessions: (sessionIds: string[]) => void;
  togglePinSession: (sessionId: string) => void;

  // Pane operations
  splitPane: (direction: SplitDirection) => void;
  splitPaneAt: (
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
    contentType?: "terminal" | "browser" | "diff",
  ) => void;
  movePaneToTarget: (
    sourcePaneId: string,
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
  ) => void;
  moveSessionToPane: (
    sessionId: string,
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
  ) => void;
  extractPaneToSession: (paneId: string) => void;
  closePane: () => void;
  closePaneById: (paneId: string) => void;
  requestClosePane: () => void;
  requestClosePaneById: (paneId: string) => void;
  setPendingCloseConfirmPaneId: (paneId: string | null) => void;
  focusPane: (paneId: string) => void;
  focusNextPane: () => void;
  focusPrevPane: () => void;

  // CWD tracking
  setPaneCwd: (paneId: string, cwd: string) => void;

  // Title tracking (from terminal OSC sequences)
  setPaneTitle: (paneId: string, title: string) => void;

  // Browser URL tracking
  setPaneUrl: (paneId: string, url: string) => void;

  // Agent status tracking
  setPaneAgentStatus: (paneId: string, agent: AgentState) => void;

  // Startup commands
  setPendingStartupCommand: (workspacePath: string, command: string) => void;
  consumePendingStartupCommand: (workspacePath: string) => string | null;

  // Workspace cleanup
  removeWorkspaceSessions: (workspacePath: string) => void;

  // Resize
  updateSplitRatio: (firstPaneId: string, ratio: number) => void;

  // Webview focus
  setWebviewFocused: (paneId: string | null) => void;

  // Picked element
  setPickedElement: (paneId: string, result: PickedElementResult) => void;
  clearPickedElement: (paneId: string) => void;
}

// Selector for the active workspace's session state
export function selectActiveWorkspace(
  state: AppState,
): WorkspaceSessionState | null {
  if (!state.activeWorkspacePath) return null;
  return state.workspaceSessions[state.activeWorkspacePath] ?? null;
}

// Cache the loaded layout so setActiveWorkspace can check it synchronously
let _cachedLayout: PersistedLayout | null = null;

export const useAppStore = create<AppState>((set, get) => ({
  workspaceSessions: {},
  activeWorkspacePath: null,
  paneCwd: {},
  paneTitle: {},
  paneAgentStatus: {},
  paneContentType: {},
  paneUrl: {},
  panePickedElement: {},
  webviewFocusedPaneId: null,
  layoutLoaded: false,
  closedPaneIds: new Set<string>(),
  pendingStartupCommands: {},
  pendingCloseConfirmPaneId: null,
  pendingCloseConfirmSessionId: null,

  loadPersistedLayout: async () => {
    try {
      const layout = await window.electronAPI?.layout.load();
      if (layout) {
        _cachedLayout = layout;

        // Pre-populate paneCwd, paneTitle, paneAgentStatus, paneContentType,
        // and paneUrl from persisted data
        const cwds: Record<string, string> = {};
        const titles: Record<string, string> = {};
        const agents: Record<string, AgentState> = {};
        const contentTypes: Record<string, "terminal" | "browser" | "diff"> = {};
        const urls: Record<string, string> = {};
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
              if (
                paneSession.lastAgentStatus &&
                !(
                  paneSession.lastAgentStatus.status === "idle" &&
                  paneSession.lastAgentStatus.kind === null
                )
              ) {
                agents[paneId] = paneSession.lastAgentStatus as AgentState;
              }
            }
            // Extract contentType and url from leaf nodes in the pane tree
            const extractLeafData = (node: PaneNode): void => {
              if (node.type === "leaf") {
                if (node.contentType) {
                  contentTypes[node.paneId] = node.contentType;
                }
                if (node.url) {
                  urls[node.paneId] = node.url;
                }
              } else {
                extractLeafData(node.first);
                extractLeafData(node.second);
              }
            };
            extractLeafData(session.rootNode);
          }
        }

        set({
          layoutLoaded: true,
          paneCwd: { ...get().paneCwd, ...cwds },
          paneTitle: { ...get().paneTitle, ...titles },
          paneAgentStatus: { ...get().paneAgentStatus, ...agents },
          paneContentType: { ...get().paneContentType, ...contentTypes },
          paneUrl: { ...get().paneUrl, ...urls },
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

      // No persisted state — start empty so WorkspaceEmptyState is shown
      return {
        activeWorkspacePath: path,
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: createEmptyWorkspaceState(),
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
            ...ws,
            sessions: [...ws.sessions, session],
            selectedSessionId: session.id,
          },
        },
      };
    }),

  addBrowserSession: (url: string) =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;
      const paneId = newPaneId();
      let title: string;
      try {
        const parsed = new URL(url);
        title = parsed.host || url;
      } catch {
        title = url;
      }
      const session: Session = {
        id: newSessionId(),
        title,
        rootNode: { type: "leaf", paneId, contentType: "browser", url },
        focusedPaneId: paneId,
      };
      return {
        paneContentType: { ...state.paneContentType, [paneId]: "browser" },
        paneUrl: { ...state.paneUrl, [paneId]: url },
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: {
            ...ws,
            sessions: [...ws.sessions, session],
            selectedSessionId: session.id,
          },
        },
      };
    }),

  addDiffSession: () =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;
      const paneId = newPaneId();
      const session: Session = {
        id: newSessionId(),
        title: "Diff",
        rootNode: { type: "leaf", paneId, contentType: "diff" },
        focusedPaneId: paneId,
      };
      return {
        paneContentType: { ...state.paneContentType, [paneId]: "diff" },
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: {
            ...ws,
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
      const newClosedPaneIds = new Set(state.closedPaneIds);
      if (closingSession) {
        for (const pid of allPaneIds(closingSession.rootNode)) {
          newClosedPaneIds.add(pid);
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
      const newContentType = { ...state.paneContentType };
      const newPaneUrl = { ...state.paneUrl };
      for (const pid of deadPaneIds) {
        delete newCwd[pid];
        delete newTitle[pid];
        delete newAgentStatus[pid];
        delete newContentType[pid];
        delete newPaneUrl[pid];
      }

      return {
        closedPaneIds: newClosedPaneIds,
        paneCwd: newCwd,
        paneTitle: newTitle,
        paneAgentStatus: newAgentStatus,
        paneContentType: newContentType,
        paneUrl: newPaneUrl,
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: {
            sessions: newSessions,
            selectedSessionId: newSelected,
            pinnedSessionIds: (ws.pinnedSessionIds ?? []).filter(
              (id) => id !== sessionId,
            ),
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
        newSessions = [
          ...others.slice(0, insertIdx),
          session,
          ...others.slice(insertIdx),
        ];
      } else {
        newPinned = [...pinned, sessionId];
        const session = ws.sessions.find((s) => s.id === sessionId);
        if (!session) return state;
        const others = ws.sessions.filter((s) => s.id !== sessionId);
        const insertIdx = pinned.length;
        newSessions = [
          ...others.slice(0, insertIdx),
          session,
          ...others.slice(insertIdx),
        ];
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

  splitPaneAt: (
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
    contentType?: "terminal" | "browser" | "diff",
  ) =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;
      const session = ws.sessions.find((s) =>
        hasPaneId(s.rootNode, targetPaneId),
      );
      if (!session) return state;
      const newPane = newPaneId();
      const newRoot = insertSplitAt(
        session.rootNode,
        targetPaneId,
        direction,
        newPane,
        position,
        contentType,
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
        ...(contentType && {
          paneContentType: { ...state.paneContentType, [newPane]: contentType },
        }),
      };
    }),

  movePaneToTarget: (
    sourcePaneId: string,
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
  ) =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;

      const sourceSession = ws.sessions.find((s) =>
        hasPaneId(s.rootNode, sourcePaneId),
      );
      const targetSession = ws.sessions.find((s) =>
        hasPaneId(s.rootNode, targetPaneId),
      );
      if (!sourceSession || !targetSession) return state;

      if (sourceSession.id === targetSession.id) {
        // Same-session move
        const newRoot = movePane(
          sourceSession.rootNode,
          sourcePaneId,
          targetPaneId,
          direction,
          position,
        );
        if (newRoot === null) return state;
        return {
          workspaceSessions: {
            ...state.workspaceSessions,
            [path]: {
              ...ws,
              sessions: ws.sessions.map((s) =>
                s.id === sourceSession.id
                  ? { ...s, rootNode: newRoot, focusedPaneId: sourcePaneId }
                  : s,
              ),
            },
          },
        };
      }

      // Cross-session move
      const sourceRootAfterRemove = removePane(
        sourceSession.rootNode,
        sourcePaneId,
      );
      const newTargetRoot = insertSplitAt(
        targetSession.rootNode,
        targetPaneId,
        direction,
        sourcePaneId,
        position,
      );

      let newSessions: Session[];
      if (sourceRootAfterRemove === null) {
        // Source session had only one pane — close it
        newSessions = ws.sessions
          .filter((s) => s.id !== sourceSession.id)
          .map((s) =>
            s.id === targetSession.id
              ? { ...s, rootNode: newTargetRoot, focusedPaneId: sourcePaneId }
              : s,
          );
      } else {
        newSessions = ws.sessions.map((s) => {
          if (s.id === sourceSession.id) {
            const ids = allPaneIds(sourceRootAfterRemove);
            const newFocused =
              s.focusedPaneId === sourcePaneId ? ids[0] : s.focusedPaneId;
            return {
              ...s,
              rootNode: sourceRootAfterRemove,
              focusedPaneId: newFocused,
            };
          }
          if (s.id === targetSession.id) {
            return {
              ...s,
              rootNode: newTargetRoot,
              focusedPaneId: sourcePaneId,
            };
          }
          return s;
        });
      }

      const newSelectedSessionId =
        ws.selectedSessionId === sourceSession.id &&
        sourceRootAfterRemove === null
          ? targetSession.id
          : ws.selectedSessionId;

      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: {
            ...ws,
            sessions: newSessions,
            selectedSessionId: newSelectedSessionId,
            pinnedSessionIds:
              sourceRootAfterRemove === null
                ? (ws.pinnedSessionIds ?? []).filter(
                    (id) => id !== sourceSession.id,
                  )
                : ws.pinnedSessionIds,
          },
        },
      };
    }),

  moveSessionToPane: (
    sessionId: string,
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
  ) =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;

      const sourceSession = ws.sessions.find((s) => s.id === sessionId);
      const targetSession = ws.sessions.find((s) =>
        hasPaneId(s.rootNode, targetPaneId),
      );
      if (
        !sourceSession ||
        !targetSession ||
        sourceSession.id === targetSession.id
      )
        return state;

      // Single-pane session: delegate to movePaneToTarget logic inline
      if (sourceSession.rootNode.type === "leaf") {
        const sourcePaneId = sourceSession.rootNode.paneId;
        const newTargetRoot = insertSplitAt(
          targetSession.rootNode,
          targetPaneId,
          direction,
          sourcePaneId,
          position,
        );
        const newSessions = ws.sessions
          .filter((s) => s.id !== sourceSession.id)
          .map((s) =>
            s.id === targetSession.id
              ? { ...s, rootNode: newTargetRoot, focusedPaneId: sourcePaneId }
              : s,
          );
        const newSelectedSessionId =
          ws.selectedSessionId === sourceSession.id
            ? targetSession.id
            : ws.selectedSessionId;
        return {
          workspaceSessions: {
            ...state.workspaceSessions,
            [path]: {
              ...ws,
              sessions: newSessions,
              selectedSessionId: newSelectedSessionId,
              pinnedSessionIds: (ws.pinnedSessionIds ?? []).filter(
                (id) => id !== sourceSession.id,
              ),
            },
          },
        };
      }

      // Multi-pane session: insert entire subtree
      const sourceIds = allPaneIds(sourceSession.rootNode);
      const newTargetRoot = insertSubtreeAt(
        targetSession.rootNode,
        targetPaneId,
        direction,
        sourceSession.rootNode,
        position,
      );
      const focusedPaneId = sourceIds[0];
      const newSessions = ws.sessions
        .filter((s) => s.id !== sourceSession.id)
        .map((s) =>
          s.id === targetSession.id
            ? { ...s, rootNode: newTargetRoot, focusedPaneId }
            : s,
        );
      const newSelectedSessionId =
        ws.selectedSessionId === sourceSession.id
          ? targetSession.id
          : ws.selectedSessionId;
      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: {
            ...ws,
            sessions: newSessions,
            selectedSessionId: newSelectedSessionId,
            pinnedSessionIds: (ws.pinnedSessionIds ?? []).filter(
              (id) => id !== sourceSession.id,
            ),
          },
        },
      };
    }),

  extractPaneToSession: (paneId: string) =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const ws = state.workspaceSessions[path];
      if (!ws) return state;

      const sourceSession = ws.sessions.find((s) =>
        hasPaneId(s.rootNode, paneId),
      );
      if (!sourceSession) return state;

      // If the pane is the only pane in its session, just select that session
      if (
        sourceSession.rootNode.type === "leaf" &&
        sourceSession.rootNode.paneId === paneId
      ) {
        return {
          workspaceSessions: {
            ...state.workspaceSessions,
            [path]: { ...ws, selectedSessionId: sourceSession.id },
          },
        };
      }

      // Remove the pane from the source session
      const remaining = removePane(sourceSession.rootNode, paneId);
      if (!remaining) return state;

      const ids = allPaneIds(remaining);
      const newFocused =
        sourceSession.focusedPaneId === paneId
          ? ids[0]
          : sourceSession.focusedPaneId;

      // Create a new session with the extracted pane
      const newSession: Session = {
        id: newSessionId(),
        title: "Terminal",
        rootNode: { type: "leaf", paneId },
        focusedPaneId: paneId,
      };

      const newSessions = ws.sessions.map((s) =>
        s.id === sourceSession.id
          ? { ...s, rootNode: remaining, focusedPaneId: newFocused }
          : s,
      );
      newSessions.push(newSession);

      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [path]: {
            ...ws,
            sessions: newSessions,
            selectedSessionId: newSession.id,
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
      hasPaneId(s.rootNode, paneId),
    );
    if (!session) return;

    const remaining = removePane(session.rootNode, paneId);
    if (remaining === null) {
      const newClosedPaneIds = new Set(state.closedPaneIds);
      for (const pid of allPaneIds(session.rootNode)) {
        newClosedPaneIds.add(pid);
      }
      set({ closedPaneIds: newClosedPaneIds });
      get().closeSession(session.id);
      return;
    }

    const ids = allPaneIds(remaining);
    const newFocused =
      session.focusedPaneId === paneId ? ids[0] : session.focusedPaneId;

    set((s) => {
      const currentWs = s.workspaceSessions[path];
      if (!currentWs) return s;
      const newClosedPaneIds = new Set(s.closedPaneIds);
      newClosedPaneIds.add(paneId);
      const newCwd = { ...s.paneCwd };
      const newTitle = { ...s.paneTitle };
      const newAgentStatus = { ...s.paneAgentStatus };
      const newContentType = { ...s.paneContentType };
      const newPaneUrl = { ...s.paneUrl };
      delete newCwd[paneId];
      delete newTitle[paneId];
      delete newAgentStatus[paneId];
      delete newContentType[paneId];
      delete newPaneUrl[paneId];
      return {
        closedPaneIds: newClosedPaneIds,
        paneCwd: newCwd,
        paneTitle: newTitle,
        paneAgentStatus: newAgentStatus,
        paneContentType: newContentType,
        paneUrl: newPaneUrl,
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

  setPendingCloseConfirmPaneId: (paneId: string | null) =>
    set({ pendingCloseConfirmPaneId: paneId }),

  setPendingCloseConfirmSessionId: (sessionId: string | null) =>
    set({ pendingCloseConfirmSessionId: sessionId }),

  requestCloseSession: (sessionId: string) => {
    const state = get();
    const path = state.activeWorkspacePath;
    if (!path) return;
    const ws = state.workspaceSessions[path];
    if (!ws) return;
    const session = ws.sessions.find((s) => s.id === sessionId);
    if (!session) return;

    const activeStatuses = ["thinking", "working", "requires_input"];
    const hasActiveAgent = allPaneIds(session.rootNode).some((pid) => {
      const agentState = state.paneAgentStatus[pid];
      return agentState && activeStatuses.includes(agentState.status);
    });

    if (hasActiveAgent) {
      set({ pendingCloseConfirmSessionId: sessionId });
    } else {
      get().closeSession(sessionId);
    }
  },

  requestClosePane: () => {
    const state = get();
    const path = state.activeWorkspacePath;
    if (!path) return;
    const ws = state.workspaceSessions[path];
    if (!ws) return;
    const session = ws.sessions.find((s) => s.id === ws.selectedSessionId);
    if (!session) return;
    const focusedPaneId = session.focusedPaneId;
    get().requestClosePaneById(focusedPaneId);
  },

  requestClosePaneById: (paneId: string) => {
    const state = get();
    const agentState = state.paneAgentStatus[paneId];
    const activeStatuses = ["thinking", "working", "requires_input"];
    if (agentState && activeStatuses.includes(agentState.status)) {
      set({ pendingCloseConfirmPaneId: paneId });
    } else {
      get().closePaneById(paneId);
    }
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

  setPaneUrl: (paneId: string, url: string) =>
    set((state) => {
      if (state.paneUrl[paneId] === url) return state;
      // Update the paneUrl map
      const newState: Partial<AppState> = {
        paneUrl: { ...state.paneUrl, [paneId]: url },
      };
      // Also update the url in the rootNode leaf so it persists
      const wsPath = state.activeWorkspacePath;
      if (wsPath) {
        const ws = state.workspaceSessions[wsPath];
        if (ws) {
          const updateLeafUrl = (node: PaneNode): PaneNode => {
            if (node.type === "leaf") {
              return node.paneId === paneId ? { ...node, url } : node;
            }
            const first = updateLeafUrl(node.first);
            const second = updateLeafUrl(node.second);
            if (first === node.first && second === node.second) return node;
            return { ...node, first, second };
          };
          const updatedSessions = ws.sessions.map((s) => {
            const newRoot = updateLeafUrl(s.rootNode);
            return newRoot === s.rootNode ? s : { ...s, rootNode: newRoot };
          });
          if (updatedSessions !== ws.sessions) {
            newState.workspaceSessions = {
              ...state.workspaceSessions,
              [wsPath]: { ...ws, sessions: updatedSessions },
            };
          }
        }
      }
      return newState;
    }),

  setWebviewFocused: (paneId: string | null) =>
    set({ webviewFocusedPaneId: paneId }),

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
        console.debug(`[agent-status] store: pane=${paneId} → REMOVED (gone)`);
        const { [paneId]: _, ...rest } = state.paneAgentStatus;
        return { paneAgentStatus: rest };
      }
      console.debug(
        `[agent-status] store: pane=${paneId} → ${agent.kind}/${agent.status} (title=${agent.title})`,
      );
      return { paneAgentStatus: { ...state.paneAgentStatus, [paneId]: agent } };
    }),

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
      const newClosedPaneIds = new Set(state.closedPaneIds);
      const deadPaneIds: string[] = [];
      for (const session of ws.sessions) {
        for (const pid of allPaneIds(session.rootNode)) {
          newClosedPaneIds.add(pid);
          deadPaneIds.push(pid);
        }
      }

      // Clean up metadata
      const newCwd = { ...state.paneCwd };
      const newTitle = { ...state.paneTitle };
      const newAgentStatus = { ...state.paneAgentStatus };
      const newContentType = { ...state.paneContentType };
      const newPaneUrl = { ...state.paneUrl };
      for (const pid of deadPaneIds) {
        delete newCwd[pid];
        delete newTitle[pid];
        delete newAgentStatus[pid];
        delete newContentType[pid];
        delete newPaneUrl[pid];
      }

      const { [workspacePath]: _, ...rest } = state.workspaceSessions;
      return {
        closedPaneIds: newClosedPaneIds,
        workspaceSessions: rest,
        paneCwd: newCwd,
        paneTitle: newTitle,
        paneAgentStatus: newAgentStatus,
        paneContentType: newContentType,
        paneUrl: newPaneUrl,
      };
    }),

  updateSplitRatio: (_firstPaneId: string, _ratio: number) =>
    set((state) => {
      // TODO: implement ratio update via pane-tree.updateRatio
      return state;
    }),

  setPickedElement: (paneId: string, result: PickedElementResult) =>
    set((state) => ({
      panePickedElement: { ...state.panePickedElement, [paneId]: result },
    })),

  clearPickedElement: (paneId: string) =>
    set((state) => {
      const { [paneId]: _, ...rest } = state.panePickedElement;
      return { panePickedElement: rest };
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

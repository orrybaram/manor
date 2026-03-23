import { useState, useCallback, useRef } from "react";
import { TabBar } from "./components/TabBar";
import { PaneLayout } from "./components/PaneLayout";
import { Sidebar } from "./components/Sidebar";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsModal } from "./components/SettingsModal";
import { WorkspaceEmptyState } from "./components/WorkspaceEmptyState";
import { WelcomeEmptyState } from "./components/WelcomeEmptyState";
import { NewWorkspaceDialog } from "./components/NewWorkspaceDialog";
import { ToastContainer } from "./components/Toast";
import { TasksModal } from "./components/TasksView";
import { useAppStore, selectActiveWorkspace } from "./store/app-store";
import { useProjectStore } from "./store/project-store";
import { useKeybindingsStore } from "./store/keybindings-store";
import { comboFromEvent, comboMatches } from "./lib/keybindings";
import { useThemeStore } from "./store/theme-store";
import { useMountEffect } from "./hooks/useMountEffect";
import { useAutoUpdate } from "./hooks/useAutoUpdate";
import type { TaskInfo } from "./electron.d";
import "./App.css";

const SESSION_BASE_STYLE: React.CSSProperties = {
  display: "flex",
  position: "absolute",
  inset: "0",
  overflow: "hidden",
};
const SESSION_VISIBLE_STYLE: React.CSSProperties = {
  ...SESSION_BASE_STYLE,
  visibility: "visible",
};
const SESSION_HIDDEN_STYLE: React.CSSProperties = {
  ...SESSION_BASE_STYLE,
  visibility: "hidden",
};

function App() {
  const loadTheme = useThemeStore((s) => s.loadTheme);
  useMountEffect(() => {
    loadTheme();
  });

  useAutoUpdate();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsProjectId(null);
  }, []);
  const [tasksOpen, setTasksOpen] = useState(false);
  const closeTasks = useCallback(() => setTasksOpen(false), []);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [preselectedProjectId, setPreselectedProjectId] = useState<
    string | null
  >(null);
  const [initialName, setInitialName] = useState("");
  const [initialBranch, setInitialBranch] = useState("");
  const closeNewWorkspace = useCallback(() => {
    setNewWorkspaceOpen(false);
    setPreselectedProjectId(null);
    setInitialName("");
    setInitialBranch("");
  }, []);

  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const handleOpenProjectSettings = useCallback((projectId: string) => {
    setSettingsProjectId(projectId);
    setSettingsOpen(true);
  }, []);
  const handleNewWorkspace = useCallback(
    (opts?: { projectId?: string; name?: string; branch?: string }) => {
      if (opts?.projectId) setPreselectedProjectId(opts.projectId);
      if (opts?.name) setInitialName(opts.name);
      if (opts?.branch) setInitialBranch(opts.branch);
      setNewWorkspaceOpen(true);
    },
    [],
  );

  const workspaceSessions = useAppStore((s) => s.workspaceSessions);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const ws = useAppStore(selectActiveWorkspace);
  const selectedSessionId = ws?.selectedSessionId ?? null;

  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const addSession = useAppStore((s) => s.addSession);
  const closeSession = useAppStore((s) => s.closeSession);
  const selectSession = useAppStore((s) => s.selectSession);
  const selectNextSession = useAppStore((s) => s.selectNextSession);
  const selectPrevSession = useAppStore((s) => s.selectPrevSession);
  const splitPane = useAppStore((s) => s.splitPane);
  const closePane = useAppStore((s) => s.closePane);
  const focusNextPane = useAppStore((s) => s.focusNextPane);
  const focusPrevPane = useAppStore((s) => s.focusPrevPane);
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const createWorktree = useProjectStore((s) => s.createWorktree);
  const sidebarVisible = useProjectStore((s) => s.sidebarVisible);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);

  const activeSession = ws?.sessions.find((s) => s.id === selectedSessionId);
  const hasProjects = projects.length > 0;
  const hasSessions = (ws?.sessions.length ?? 0) > 0;

  // Keybindings
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const handleNewTaskRef = useRef<() => void>(() => {});

  // Handler map: command ID → action
  const handlersRef = useRef<Record<string, () => void>>({});
  handlersRef.current = {
    "settings": () => setSettingsOpen((v) => !v),
    "command-palette": () => setPaletteOpen((v) => !v),
    "new-session": () => addSession(),
    "split-h": () => splitPane("horizontal"),
    "split-v": () => splitPane("vertical"),
    "close-pane": () => closePane(),
    "close-session": () => {
      const session = activeSessionRef.current;
      if (session) closeSession(session.id);
    },
    "next-session": () => selectNextSession(),
    "prev-session": () => selectPrevSession(),
    "next-pane": () => focusNextPane(),
    "prev-pane": () => focusPrevPane(),
    "toggle-sidebar": () => toggleSidebar(),
    "new-task": () => handleNewTaskRef.current(),
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `select-session-${i + 1}`,
        () => {
          const sessions = wsRef.current?.sessions;
          if (sessions && i < sessions.length) {
            selectSession(sessions[i].id);
          }
        },
      ]),
    ),
  };

  useMountEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Skip plain keys with no modifier — custom bindings always use at least one
      if (!e.metaKey && !e.ctrlKey && !e.altKey) return;

      const combo = comboFromEvent(e);
      const bindings = useKeybindingsStore.getState().bindings;

      for (const [commandId, boundCombo] of Object.entries(bindings)) {
        if (comboMatches(combo, boundCombo)) {
          e.preventDefault();
          handlersRef.current[commandId]?.();
          return;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const handleResumeTask = useCallback(
    (task: TaskInfo) => {
      if (task.workspacePath) {
        setActiveWorkspace(task.workspacePath);
      }
      addSession();
      setTimeout(() => {
        const state = useAppStore.getState();
        const activePath = state.activeWorkspacePath;
        if (!activePath) return;
        const wsState = state.workspaceSessions[activePath];
        if (!wsState) return;
        const selectedSession = wsState.sessions.find(
          (s) => s.id === wsState.selectedSessionId,
        );
        if (!selectedSession) return;
        const paneId = selectedSession.focusedPaneId;
        const taskProject = projects.find((p) =>
          p.workspaces.some((w) => w.path === task.workspacePath),
        );
        const baseCommand =
          taskProject?.agentCommand?.split(" ")[0] ?? "claude";
        window.electronAPI.pty.write(
          paneId,
          `${baseCommand} --resume ${task.claudeSessionId}\r`,
        );
      }, 150);
    },
    [setActiveWorkspace, addSession, projects],
  );

  const handleNewTask = useCallback(() => {
    addSession();
    setTimeout(() => {
      const state = useAppStore.getState();
      const activePath = state.activeWorkspacePath;
      if (!activePath) return;
      const wsState = state.workspaceSessions[activePath];
      if (!wsState) return;
      const selectedSession = wsState.sessions.find(
        (s) => s.id === wsState.selectedSessionId,
      );
      if (!selectedSession) return;
      const paneId = selectedSession.focusedPaneId;
      const currentProject = projects.find((p) =>
        p.workspaces.some((w) => w.path === activeWorkspacePath),
      );
      const command =
        currentProject?.agentCommand ?? "claude --dangerously-skip-permissions";
      window.electronAPI.pty.write(paneId, command + "\r");
    }, 150);
  }, [addSession, projects, activeWorkspacePath]);
  handleNewTaskRef.current = handleNewTask;

  return (
    <div className="app">
      <div className="app-body">
        {sidebarVisible && <Sidebar onShowTasks={() => setTasksOpen(true)} onOpenProjectSettings={handleOpenProjectSettings} />}
        <div className="main-content">
          {hasSessions ? <TabBar /> : <div className="drag-region" />}
          <div className="terminal-container">
            {/* Render all sessions across all workspaces — only show the active one.
                Keeping all mounted prevents PTY sessions from being killed on switch. */}
            {Object.entries(workspaceSessions).flatMap(([wpath, wsState]) =>
              wsState.sessions.map((session) => {
                const isVisible =
                  wpath === activeWorkspacePath &&
                  session.id === selectedSessionId;
                return (
                  <div
                    key={session.id}
                    style={
                      isVisible ? SESSION_VISIBLE_STYLE : SESSION_HIDDEN_STYLE
                    }
                  >
                    <PaneLayout node={session.rootNode} workspacePath={wpath} />
                  </div>
                );
              }),
            )}
            {!hasSessions &&
              (hasProjects ? <WorkspaceEmptyState /> : <WelcomeEmptyState />)}
          </div>
        </div>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        onOpenSettings={handleOpenSettings}
        onNewWorkspace={handleNewWorkspace}
        onResumeTask={handleResumeTask}
        onViewAllTasks={() => setTasksOpen(true)}
        onNewTask={handleNewTask}
      />
      <SettingsModal open={settingsOpen} onClose={closeSettings} initialProjectId={settingsProjectId} />
      <TasksModal
        open={tasksOpen}
        onClose={closeTasks}
        onResumeTask={handleResumeTask}
      />
      <NewWorkspaceDialog
        open={newWorkspaceOpen}
        onClose={closeNewWorkspace}
        projects={projects}
        selectedProjectIndex={selectedProjectIndex}
        preselectedProjectId={preselectedProjectId}
        initialName={initialName}
        initialBranch={initialBranch}
        onSubmit={async (projectId, name, branch) => {
          const result = await createWorktree(projectId, name, branch);
          if (result) {
            setNewWorkspaceOpen(false);
          }
          return !!result;
        }}
      />
      <ToastContainer />
    </div>
  );
}

export default App;

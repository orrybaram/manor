import { useState, useCallback, useRef } from "react";
import { PaneDragProvider } from "./contexts/PaneDragContext";
import { TabBar } from "./components/TabBar";
import { StatusBar } from "./components/StatusBar";
import { PaneLayout } from "./components/PaneLayout";
import { Sidebar } from "./components/Sidebar";
import { CommandPalette } from "./components/CommandPalette";
import type { PaletteView } from "./components/CommandPalette/types";
import { SettingsModal } from "./components/SettingsModal";
import { WorkspaceEmptyState } from "./components/WorkspaceEmptyState";
import { WelcomeEmptyState } from "./components/WelcomeEmptyState";
import { NewWorkspaceDialog } from "./components/NewWorkspaceDialog";
import { ToastContainer } from "./components/Toast";
import { TooltipProvider } from "./components/Tooltip";
import { TasksModal } from "./components/TasksView";
import { useAppStore, selectActiveWorkspace } from "./store/app-store";
import { useProjectStore } from "./store/project-store";
import { useKeybindingsStore } from "./store/keybindings-store";
import { useToastStore } from "./store/toast-store";
import { comboFromEvent, comboMatches } from "./lib/keybindings";
import { getBrowserPaneRef } from "./lib/browser-pane-registry";
import type { BrowserPaneRef } from "./components/BrowserPane";
import { useThemeStore } from "./store/theme-store";
import { useMountEffect } from "./hooks/useMountEffect";
import { useAutoUpdate } from "./hooks/useAutoUpdate";
import type { TaskInfo } from "./electron.d";
import { navigateToTask } from "./utils/task-navigation";
import { allPaneIds } from "./store/pane-tree";
import { DEFAULT_AGENT_COMMAND } from "./agent-defaults";
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
  const applyProjectTheme = useThemeStore((s) => s.applyProjectTheme);
  useMountEffect(() => {
    loadTheme();
  });

  useAutoUpdate();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteInitialView, setPaletteInitialView] = useState<PaletteView | undefined>();
  const [paletteInitialIssueId, setPaletteInitialIssueId] = useState<string | null>(null);
  const [paletteInitialGitHubIssueNumber, setPaletteInitialGitHubIssueNumber] = useState<number | null>(null);
  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    setPaletteInitialView(undefined);
    setPaletteInitialIssueId(null);
    setPaletteInitialGitHubIssueNumber(null);
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(
    null,
  );
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsProjectId(null);
    // Revert to the active project's theme in case settings was previewing
    // a different project's theme
    const activeTheme =
      useProjectStore.getState().projects[
        useProjectStore.getState().selectedProjectIndex
      ]?.themeName ?? null;
    applyProjectTheme(activeTheme);
  }, [applyProjectTheme]);
  const [tasksOpen, setTasksOpen] = useState(false);
  const closeTasks = useCallback(() => setTasksOpen(false), []);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [preselectedProjectId, setPreselectedProjectId] = useState<
    string | null
  >(null);
  const [initialName, setInitialName] = useState("");
  const [initialBranch, setInitialBranch] = useState("");
  const [agentPrompt, setAgentPrompt] = useState<string | null>(null);
  const [pendingLinkedIssue, setPendingLinkedIssue] = useState<import("./store/project-store").LinkedIssue | null>(null);
  const closeNewWorkspace = useCallback(() => {
    setNewWorkspaceOpen(false);
    setPreselectedProjectId(null);
    setInitialName("");
    setInitialBranch("");
    setAgentPrompt(null);
    setPendingLinkedIssue(null);
  }, []);

  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const handleOpenProjectSettings = useCallback((projectId: string) => {
    setSettingsProjectId(projectId);
    setSettingsOpen(true);
  }, []);
  const handleNewWorkspace = useCallback(
    (opts?: {
      projectId?: string;
      name?: string;
      branch?: string;
      agentPrompt?: string;
      linkedIssue?: import("./store/project-store").LinkedIssue;
    }) => {
      if (opts?.projectId) setPreselectedProjectId(opts.projectId);
      if (opts?.name) setInitialName(opts.name);
      if (opts?.branch) setInitialBranch(opts.branch);
      if (opts?.agentPrompt) setAgentPrompt(opts.agentPrompt);
      if (opts?.linkedIssue) setPendingLinkedIssue(opts.linkedIssue);
      setNewWorkspaceOpen(true);
    },
    [],
  );

  const handleOpenPaletteView = useCallback(
    (view: PaletteView) => {
      setPaletteInitialView(view);
      setPaletteOpen(true);
    },
    [],
  );

  const handleOpenIssueDetail = useCallback(
    (opts: { type: "linear"; issueId: string } | { type: "github"; issueNumber: number }) => {
      if (opts.type === "linear") {
        setPaletteInitialView("issue-detail");
        setPaletteInitialIssueId(opts.issueId);
      } else {
        setPaletteInitialView("github-issue-detail");
        setPaletteInitialGitHubIssueNumber(opts.issueNumber);
      }
      setPaletteOpen(true);
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
  const addBrowserSession = useAppStore((s) => s.addBrowserSession);
  const focusNextPane = useAppStore((s) => s.focusNextPane);
  const focusPrevPane = useAppStore((s) => s.focusPrevPane);
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const createWorktree = useProjectStore((s) => s.createWorktree);

  // Reactively apply project theme whenever the selected project changes
  const currentProjectThemeName =
    projects[selectedProjectIndex]?.themeName ?? null;
  const prevThemeRef = useRef(currentProjectThemeName);
  if (currentProjectThemeName !== prevThemeRef.current) {
    prevThemeRef.current = currentProjectThemeName;
    applyProjectTheme(currentProjectThemeName);
  }
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

  // Helper to get the focused browser pane's ref (if focused pane is a browser)
  function getFocusedBrowserRef(): BrowserPaneRef | undefined {
    const state = useAppStore.getState();
    const wsState = state.workspaceSessions[state.activeWorkspacePath ?? ""];
    if (!wsState) return;
    const session = wsState.sessions.find(s => s.id === wsState.selectedSessionId);
    if (!session) return;
    const focusedPaneId = session.focusedPaneId;
    if (!focusedPaneId) return;
    if (state.paneContentType[focusedPaneId] !== "browser") return;
    return getBrowserPaneRef(focusedPaneId);
  }

  // Handler map: command ID → action
  const handlersRef = useRef<Record<string, () => void>>({});
  handlersRef.current = {
    settings: () => setSettingsOpen((v) => !v),
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
    "new-workspace": () => setNewWorkspaceOpen(true),
    "new-browser": () => addBrowserSession("about:blank"),
    "copy-branch": () => {
      const state = useAppStore.getState();
      const awp = state.activeWorkspacePath;
      const proj = useProjectStore.getState().projects.find((p) =>
        p.workspaces.some((w) => w.path === awp),
      );
      const ws = proj?.workspaces.find((w) => w.path === awp);
      const branch = ws?.branch;
      if (branch) {
        navigator.clipboard.writeText(branch);
        useToastStore.getState().addToast({
          id: `copy-branch-${Date.now()}`,
          message: `Copied "${branch}"`,
          status: "success",
        });
      }
    },
    "browser-zoom-in": () => getFocusedBrowserRef()?.zoomIn(),
    "browser-zoom-out": () => getFocusedBrowserRef()?.zoomOut(),
    "browser-zoom-reset": () => getFocusedBrowserRef()?.zoomReset(),
    "browser-reload": () => getFocusedBrowserRef()?.reload(),
    "browser-focus-url": () => {
      const state = useAppStore.getState();
      const wsState = state.workspaceSessions[state.activeWorkspacePath ?? ""];
      if (!wsState) return;
      const session = wsState.sessions.find(s => s.id === wsState.selectedSessionId);
      const focusedPaneId = session?.focusedPaneId;
      if (!focusedPaneId || state.paneContentType[focusedPaneId] !== "browser") return;
      const input = document.querySelector<HTMLInputElement>(`[data-pane-url-input="${focusedPaneId}"]`);
      input?.focus();
      input?.select();
    },
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
          // Browser commands are conditional — only fire when focused pane is a browser.
          // When no browser is focused, skip this match entirely so the event
          // reaches the native menu (app zoom) or terminal unimpeded.
          if (commandId.startsWith("browser-")) {
            if (!getFocusedBrowserRef()) continue;
            e.preventDefault();
            handlersRef.current[commandId]?.();
            return;
          }
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
      // If the task is active and has a pane, switch to it instead of opening a new session
      if (task.status === "active" && task.paneId && task.workspacePath) {
        const wsSessions =
          useAppStore.getState().workspaceSessions[task.workspacePath];
        if (wsSessions) {
          const paneExists = wsSessions.sessions.some((session) =>
            allPaneIds(session.rootNode).includes(task.paneId!),
          );
          if (paneExists) {
            navigateToTask(task);
            return;
          }
        }
      }

      const wsPath = task.workspacePath;
      if (wsPath) {
        setActiveWorkspace(wsPath);
      }
      const activePath = wsPath ?? useAppStore.getState().activeWorkspacePath;
      if (activePath) {
        const taskProject = projects.find((p) =>
          p.workspaces.some((w) => w.path === wsPath),
        );
        const baseCommand =
          taskProject?.agentCommand?.split(" ")[0] ??
          DEFAULT_AGENT_COMMAND;
        useAppStore
          .getState()
          .setPendingStartupCommand(
            activePath,
            `${baseCommand} --resume ${task.agentSessionId}`,
          );
      }
      addSession();
    },
    [setActiveWorkspace, addSession, projects],
  );

  const handleNewTask = useCallback(() => {
    if (activeWorkspacePath) {
      const currentProject = projects.find((p) =>
        p.workspaces.some((w) => w.path === activeWorkspacePath),
      );
      const command =
        currentProject?.agentCommand ?? DEFAULT_AGENT_COMMAND;
      useAppStore
        .getState()
        .setPendingStartupCommand(activeWorkspacePath, command);
    }
    addSession();
  }, [addSession, projects, activeWorkspacePath]);
  handleNewTaskRef.current = handleNewTask;

  const handleNewTaskWithPrompt = useCallback(
    (prompt: string) => {
      if (activeWorkspacePath) {
        const currentProject = projects.find((p) =>
          p.workspaces.some((w) => w.path === activeWorkspacePath),
        );
        const baseCommand =
          currentProject?.agentCommand ??
          DEFAULT_AGENT_COMMAND;
        const escaped = prompt
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\$/g, "\\$")
          .replace(/`/g, "\\`");
        const command = `${baseCommand} "${escaped}"`;
        useAppStore
          .getState()
          .setPendingStartupCommand(activeWorkspacePath, command);
      }
      addSession();
    },
    [addSession, projects, activeWorkspacePath],
  );

  return (
    <TooltipProvider>
    <div className="app">
      <div className="app-body">
        {sidebarVisible && (
          <Sidebar
            onShowTasks={() => setTasksOpen(true)}
            onOpenProjectSettings={handleOpenProjectSettings}
          />
        )}
        <PaneDragProvider>
          <div className="main-content">
            {hasSessions ? <TabBar onNewTask={handleNewTask} /> : <div className="drag-region" />}
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
                      <PaneLayout
                        node={session.rootNode}
                        workspacePath={wpath}
                      />
                    </div>
                  );
                }),
              )}
              {!hasSessions &&
                (hasProjects ? <WorkspaceEmptyState onOpenIssueDetail={handleOpenIssueDetail} onOpenPaletteView={handleOpenPaletteView} /> : <WelcomeEmptyState />)}
            </div>
            <StatusBar
              onNewWorkspace={handleNewWorkspace}
              onNewTaskWithPrompt={handleNewTaskWithPrompt}
            />
          </div>
        </PaneDragProvider>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        onOpenSettings={handleOpenSettings}
        onNewWorkspace={handleNewWorkspace}
        initialView={paletteInitialView}
        initialIssueId={paletteInitialIssueId}
        initialGitHubIssueNumber={paletteInitialGitHubIssueNumber}
        onResumeTask={handleResumeTask}
        onViewAllTasks={() => setTasksOpen(true)}
        onNewTask={handleNewTask}
        onNewTaskWithPrompt={handleNewTaskWithPrompt}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={closeSettings}
        initialProjectId={settingsProjectId}
      />
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
          let agentCommand: string | undefined;
          if (agentPrompt) {
            const project = projects.find((p) => p.id === projectId);
            const baseCommand =
              project?.agentCommand ?? DEFAULT_AGENT_COMMAND;
            const escaped = agentPrompt
              .replace(/\\/g, "\\\\")
              .replace(/"/g, '\\"')
              .replace(/\$/g, "\\$")
              .replace(/`/g, "\\`");
            agentCommand = `${baseCommand} "${escaped}"`;
          }
          const result = await createWorktree(
            projectId,
            name,
            branch,
            agentCommand,
            pendingLinkedIssue ?? undefined,
          );
          if (result) {
            setNewWorkspaceOpen(false);
          }
          return !!result;
        }}
      />
      <ToastContainer />
    </div>
    </TooltipProvider>
  );
}

export default App;

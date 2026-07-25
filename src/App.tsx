import { useState, useCallback, useRef, useEffect, lazy, Suspense } from "react";
import { PaneDragProvider } from "./components/workspace-panes/PaneDragContext";
import { StatusBar } from "./components/statusbar/StatusBar/StatusBar";
import { PaneLayout } from "./components/workspace-panes/PaneLayout/PaneLayout";
import { PanelLayout } from "./components/panels/PanelLayout";
import { Sidebar } from "./components/sidebar/Sidebar/Sidebar";
import type { PaletteView } from "./components/command-palette/types";
import { WorkspaceEmptyState } from "./components/sidebar/WorkspaceEmptyState";
import { WelcomeEmptyState } from "./components/sidebar/WelcomeEmptyState/WelcomeEmptyState";
import { HomeEmptyState } from "./components/sidebar/HomeEmptyState";
import { ManorLogo } from "./components/ui/ManorLogo";
import { CloseAgentPaneDialog } from "./components/CloseAgentPaneDialog";
import { ToastContainer } from "./components/ui/Toast/Toast";
import { TooltipProvider } from "./components/ui/Tooltip/Tooltip";

const CommandPalette = lazy(() => import("./components/command-palette/CommandPalette").then(m => ({ default: m.CommandPalette })));
const SettingsModal = lazy(() => import("./components/settings/SettingsModal/SettingsModal").then(m => ({ default: m.SettingsModal })));
type SettingsPageId = import("./components/settings/SettingsModal/SettingsModal").SettingsPageId;
const NewWorkspaceDialog = lazy(() => import("./components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog").then(m => ({ default: m.NewWorkspaceDialog })));
const ProjectSetupWizard = lazy(() => import("./components/sidebar/ProjectSetupWizard/ProjectSetupWizard").then(m => ({ default: m.ProjectSetupWizard })));
const TasksModal = lazy(() => import("./components/sidebar/TasksView/TasksView").then(m => ({ default: m.TasksModal })));
const FeedbackModal = lazy(() => import("./components/statusbar/FeedbackModal/FeedbackModal").then(m => ({ default: m.FeedbackModal })));
import {
  useAppStore,
  selectActiveWorkspace,
  getPersistedActiveWorkspacePath,
} from "./store/app-store";
import { useProjectStore, runWorkspaceSetupScript } from "./store/project-store";
import { appCommandHandlers } from "./lib/app-commands";
import {
  createSharedKeybindingHandlers,
  dispatchKeybinding,
  startNewTask,
} from "./lib/keybinding-commands";
import { useThemeStore } from "./store/theme-store";
import { usePreferencesStore } from "./store/preferences-store";
import { useMountEffect } from "./hooks/useMountEffect";
import { useUpdaterToasts } from "./hooks/useUpdaterToasts";
import {
  useNavigationHistory,
  navigateBack,
  navigateForward,
} from "./hooks/useNavigationHistory";
import type { TaskInfo } from "./electron.d";
import { navigateToTask } from "./utils/task-navigation";
import { hasPaneId } from "./store/pane-tree";
import { DEFAULT_AGENT_COMMAND, getAgentKindForCommand } from "./agent-defaults";
import {
  escapeShellDoubleQuoted,
  isHomePath,
  homeLaunchCommand,
  HOME_PATH,
} from "./lib/home";
import { TAB_HIDDEN_STYLE } from "./lib/tab-styles";
import "./App.css";

function App() {
  const loadTheme = useThemeStore((s) => s.loadTheme);
  const applyProjectTheme = useThemeStore((s) => s.applyProjectTheme);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const loadPersistedLayout = useAppStore((s) => s.loadPersistedLayout);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const [appReady, setAppReady] = useState(false);

  useMountEffect(() => {
    loadTheme();
    Promise.all([loadProjects(), loadPersistedLayout()]).then(() => {
      // If the Home surface was the last-active surface, restore it directly —
      // it isn't a project workspace, so the project-based restore below can't
      // reach it. Other workspaces are restored via project selection.
      if (isHomePath(getPersistedActiveWorkspacePath())) {
        setActiveWorkspace(HOME_PATH);
      } else {
        const { projects: ps, selectedProjectIndex: idx } =
          useProjectStore.getState();
        const project = ps[idx];
        if (project) {
          const ws =
            project.workspaces[project.selectedWorkspaceIndex] ??
            project.workspaces[0];
          if (ws) setActiveWorkspace(ws.path);
        }
      }
      setAppReady(true);
      window.electronAPI.tasks.reconcileStale().catch(console.error);
    });
  });

  useUpdaterToasts();
  useNavigationHistory();

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
  const [settingsPage, setSettingsPage] = useState<SettingsPageId | null>(null);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsProjectId(null);
    setSettingsPage(null);
    // Revert to the active surface's theme in case settings was previewing a
    // different theme. Home has no project override — it inherits the global
    // theme (null).
    const activeTheme = isHomePath(useAppStore.getState().activeWorkspacePath)
      ? null
      : useProjectStore.getState().projects[
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
  const [_agentPrompt, setAgentPrompt] = useState<string | null>(null);
  const [_pendingLinkedIssue, setPendingLinkedIssue] = useState<import("./store/project-store").LinkedIssue | null>(null);
  const agentPromptRef = useRef<string | null>(null);
  const pendingLinkedIssueRef = useRef<import("./store/project-store").LinkedIssue | null>(null);
  const closeNewWorkspace = useCallback(() => {
    setNewWorkspaceOpen(false);
    setPreselectedProjectId(null);
    setInitialName("");
    setInitialBranch("");
    setAgentPrompt(null);
    setPendingLinkedIssue(null);
    agentPromptRef.current = null;
    pendingLinkedIssueRef.current = null;
  }, []);

  // Project setup wizard state
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardProjectId, setWizardProjectId] = useState<string | null>(null);
  const addProject = useProjectStore((s) => s.addProject);
  const selectProject = useProjectStore((s) => s.selectProject);
  const updateProject = useProjectStore((s) => s.updateProject);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);
  const closeWizard = useCallback(() => {
    if (wizardProjectId) {
      updateProject(wizardProjectId, { setupComplete: true });
    }
    setWizardOpen(false);
    setWizardProjectId(null);
  }, [wizardProjectId, updateProject]);

  const openWizardForLatestProject = useCallback(() => {
    const newProjects = useProjectStore.getState().projects;
    const newIndex = newProjects.length - 1;
    const newProject = newProjects[newIndex];
    if (newProject) {
      selectProject(newIndex);
      if (newProject.workspaces[0]) {
        selectWorkspace(newProject.id, 0);
      }
      setWizardProjectId(newProject.id);
      setWizardOpen(true);
    }
  }, [selectProject, selectWorkspace]);

  const handleAddProject = useCallback(async () => {
    const selected = await window.electronAPI.dialog.openDirectory();
    if (selected) {
      const name = selected.split("/").pop() || "Untitled";
      await addProject(name, selected);

      openWizardForLatestProject();
    }
  }, [addProject, openWizardForLatestProject]);

  const handleDropFolder = useCallback(async (folderPath: string) => {
    const name = folderPath.split("/").pop() || "Untitled";
    await addProject(name, folderPath);
    openWizardForLatestProject();
  }, [addProject, openWizardForLatestProject]);

  const handleOpenSettings = useCallback((page?: SettingsPageId) => {
    setSettingsPage(page ?? null);
    setSettingsOpen(true);
  }, []);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const handleOpenFeedback = useCallback(() => setFeedbackOpen(true), []);
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
      if (opts?.agentPrompt) {
        setAgentPrompt(opts.agentPrompt);
        agentPromptRef.current = opts.agentPrompt;
      }
      if (opts?.linkedIssue) {
        setPendingLinkedIssue(opts.linkedIssue);
        pendingLinkedIssueRef.current = opts.linkedIssue;
      }
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

  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const ws = useAppStore(selectActiveWorkspace);
  const selectedTabId = ws?.selectedTabId ?? null;

  const addTab = useAppStore((s) => s.addTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const pendingCloseConfirmPaneId = useAppStore((s) => s.pendingCloseConfirmPaneId);
  const setPendingCloseConfirmPaneId = useAppStore((s) => s.setPendingCloseConfirmPaneId);
  const closePaneById = useAppStore((s) => s.closePaneById);
  const requestCloseTab = useAppStore((s) => s.requestCloseTab);
  const pendingCloseConfirmTabId = useAppStore((s) => s.pendingCloseConfirmTabId);
  const setPendingCloseConfirmTabId = useAppStore((s) => s.setPendingCloseConfirmTabId);
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const createWorktree = useProjectStore((s) => s.createWorktree);

  // Clean up wizard state if the project is removed while wizard is open
  const wizardStillValid = wizardOpen && wizardProjectId && projects.some((p) => p.id === wizardProjectId);

  // Reactively apply the active surface's theme. Projects carry an optional
  // theme override; the home surface has no owning project, so it inherits the
  // global theme (null override) — switching to/from home re-applies here.
  const effectiveThemeName = isHomePath(activeWorkspacePath)
    ? null
    : projects[selectedProjectIndex]?.themeName ?? null;
  const prevThemeRef = useRef(effectiveThemeName);
  if (effectiveThemeName !== prevThemeRef.current) {
    prevThemeRef.current = effectiveThemeName;
    applyProjectTheme(effectiveThemeName);
  }
  const sidebarVisible = useProjectStore((s) => s.sidebarVisible);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);

  const activeTab = ws?.tabs.find((s) => s.id === selectedTabId);
  const hasProjects = projects.length > 0;
  const hasTabs = (ws?.tabs.length ?? 0) > 0;

  // Keep the prewarmed session in sync with the active workspace.
  // Derive the agent command outside the effect so it only re-fires when the
  // command actually changes, not on every unrelated project mutation.
  const activeProject = projects.find((p) =>
    p.workspaces.some((w) => w.path === activeWorkspacePath),
  );
  // The launch command for the active surface. Home has no owning project and
  // boots the configured home harness in ~/.manor/home (the pty boundary maps
  // its sentinel path to the real dir); a project workspace uses its
  // agentCommand. Shared by prewarming and both new-task handlers below.
  const homeHarness = usePreferencesStore((s) => s.preferences.homeHarness);
  const homeCustomCommand = usePreferencesStore((s) => s.preferences.homeCustomCommand);
  const homeCustomInterrupt = usePreferencesStore((s) => s.preferences.homeCustomInterrupt);
  const activeWorkspaceCommand = isHomePath(activeWorkspacePath)
    ? homeLaunchCommand({ homeHarness, homeCustomCommand, homeCustomInterrupt })
    : activeProject?.agentCommand ?? DEFAULT_AGENT_COMMAND;
  useEffect(() => {
    if (!activeWorkspacePath) return;
    const prewarmKind = getAgentKindForCommand(activeWorkspaceCommand);
    window.electronAPI.pty.updatePrewarmCwd(activeWorkspacePath, activeWorkspaceCommand, prewarmKind);
  }, [activeWorkspacePath, activeWorkspaceCommand]);

  // Projects mutated outside the renderer (MCP, CLI) — the store never saw the
  // result, so refetch it. Creating a workspace this way must show up in the
  // sidebar without a manual refresh.
  useEffect(() => window.electronAPI.onProjectsChanged(() => {
    void loadProjects();
  }), [loadProjects]);

  // A detached window sent its tab back to this primary window (ADR-156). Insert
  // it into the active panel; PTYs re-attach and webviews re-mount by paneId.
  useEffect(
    () =>
      window.electronAPI.window.onTabReattached((payload) => {
        useAppStore.getState().receiveReattachedTab(payload);
      }),
    [],
  );

  // A tab was dragged out of another window and dropped onto this one. Same
  // insertion path as a reattach — only the gesture that triggered it differs.
  useEffect(
    () =>
      window.electronAPI.window.onTabReceived((payload) => {
        useAppStore.getState().receiveReattachedTab(payload);
      }),
    [],
  );

  // App-commands from the main process (e.g. MCP start_agent). Main cannot
  // create panes directly, so it round-trips over the "app-command" channel.
  // Payloads carrying a `requestId` expect a reply; the rest are legacy
  // fire-and-forget commands that close over this component's callback refs.
  useEffect(() => {
    const cleanup = window.electronAPI.onAppCommand(
      async ({ cmd, requestId, workspacePath, prompt, script, args }) => {
        if (cmd === "start-agent" && workspacePath) {
          await loadProjects(); // ensure a freshly-created workspace is visible
          setActiveWorkspace(workspacePath);
          if (prompt) handleNewTaskWithPromptRef.current(prompt);
          else handleNewTaskRef.current();
          return;
        }
        if (cmd === "run-setup-script" && workspacePath && script) {
          await loadProjects(); // ensure a freshly-created workspace is visible
          setActiveWorkspace(workspacePath);
          runWorkspaceSetupScript(workspacePath, script);
          return;
        }

        if (!requestId) return;
        try {
          const handler = appCommandHandlers[cmd];
          // Must reject before an optional-chained call yields `undefined`:
          // replying `ok: true` to an unknown cmd hangs main until its timeout.
          if (!handler) throw new Error(`Unknown command: ${cmd}`);
          const data = await handler(args ?? {});
          window.electronAPI.sendAppCommandResult({ requestId, ok: true, data });
        } catch (err) {
          window.electronAPI.sendAppCommandResult({
            requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
    return cleanup;
  }, [loadProjects, setActiveWorkspace]);

  // Keybindings
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const handleNewTaskRef = useRef<() => void>(() => {});
  const handleNewTaskWithPromptRef = useRef<(prompt: string) => void>(() => {});

  // Handler map: command ID → action. The window-agnostic half is shared with
  // the detached-window renderer (see `keybinding-commands`); only the commands
  // that need this window's chrome (modals, sidebar, navigation history) live
  // here. The primary window is the one that owns the prewarmed session, so it
  // is also the only window that consumes it for a new task.
  const handlersRef = useRef<Record<string, () => void>>({});
  handlersRef.current = {
    ...createSharedKeybindingHandlers({ prewarmNewTask: true }),
    settings: () => setSettingsOpen((v) => !v),
    "command-palette": () => setPaletteOpen((v) => !v),
    "close-tab": () => {
      const tab = activeTabRef.current;
      if (tab) requestCloseTab(tab.id);
    },
    "toggle-sidebar": () => toggleSidebar(),
    "history-back": () => navigateBack(),
    "history-forward": () => navigateForward(),
    "new-workspace": () => setNewWorkspaceOpen(true),
  };

  useMountEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      dispatchKeybinding(e, handlersRef.current);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  // Mouse back/forward buttons (button 3/4). Skipped while a webview pane has
  // DOM focus — the guest page (and Chromium itself) already handles its own
  // back/forward navigation for that content, consistent with how
  // `useTerminalHotkeys` scopes app shortcuts away from focused input.
  useMountEffect(() => {
    function handleMouseUp(e: MouseEvent) {
      if (e.button !== 3 && e.button !== 4) return;
      if (useAppStore.getState().webviewFocusedPaneId) return;
      e.preventDefault();
      if (e.button === 3) {
        navigateBack();
      } else {
        navigateForward();
      }
    }

    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  });

  const handleResumeTask = useCallback(
    async (task: TaskInfo) => {
      // If the task is active and has a pane, switch to it instead of opening a new tab
      if (task.status === "active" && task.paneId && task.workspacePath) {
        const wsLayout =
          useAppStore.getState().workspaceLayouts[task.workspacePath];
        if (wsLayout) {
          const paneExists = Object.values(wsLayout.panels).some((panel) =>
            panel.tabs.some((tab) => hasPaneId(tab.rootNode, task.paneId!)),
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
        const agentCommand =
          task.agentCommand ??
          taskProject?.agentCommand ??
          DEFAULT_AGENT_COMMAND;
        useAppStore
          .getState()
          .setPendingStartupCommand(
            activePath,
            `${agentCommand} --resume ${task.agentSessionId}`,
          );
      }
      // Don't consume prewarmed — resume needs a specific --resume command
      addTab();
    },
    [setActiveWorkspace, addTab, projects],
  );

  const handleNewTask = useCallback(async () => {
    // Every surface — Home and project workspaces alike — consumes a prewarmed
    // session when one is ready. On a cold start (no prewarm, or the command
    // hadn't been injected yet) seed the surface's launch command; the pty
    // boundary resolves the cwd, so Home needs no special casing here.
    await startNewTask({ prewarm: true });
  }, []);
  handleNewTaskRef.current = handleNewTask;

  const handleNewTaskWithPrompt = useCallback(
    (prompt: string) => {
      if (activeWorkspacePath) {
        const escaped = escapeShellDoubleQuoted(prompt);
        const command = `${activeWorkspaceCommand} "${escaped}"`;
        useAppStore
          .getState()
          .setPendingStartupCommand(activeWorkspacePath, command);
      }
      // Don't consume prewarmed — it has the base agent command running,
      // but we need a different command with the prompt argument.
      addTab();
    },
    [addTab, activeWorkspacePath, activeWorkspaceCommand],
  );
  handleNewTaskWithPromptRef.current = handleNewTaskWithPrompt;

  if (!appReady) {
    return (
      <div className="app splash-screen">
        <div className="splash-logo">
          <ManorLogo />
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
    <div className="app">
      <div className="app-body">
        {sidebarVisible && hasProjects && (
          <Sidebar
            onShowTasks={() => setTasksOpen(true)}
            onOpenProjectSettings={handleOpenProjectSettings}
            onAddProject={handleAddProject}
          />
        )}
        <PaneDragProvider>
          <div className="main-content">
            {activeWorkspacePath && hasTabs ? (
              <PanelLayout
                key={activeWorkspacePath}
                node={workspaceLayouts[activeWorkspacePath].panelTree}
                workspacePath={activeWorkspacePath}
                onNewTask={handleNewTask}
              />
            ) : (
              <>
                <div className="drag-region" />
                <div className="terminal-container">
                  {wizardStillValid && wizardProjectId
                    ? <Suspense fallback={null}><ProjectSetupWizard projectId={wizardProjectId} onClose={closeWizard} /></Suspense>
                    : !hasTabs &&
                      (isHomePath(activeWorkspacePath)
                        ? <HomeEmptyState onNewTask={handleNewTask} onAddProject={handleAddProject} onOpenPaletteView={handleOpenPaletteView} />
                        : hasProjects
                          ? <WorkspaceEmptyState onOpenPaletteView={handleOpenPaletteView} onNewWorkspace={handleNewWorkspace} />
                          : <WelcomeEmptyState onAddProject={handleAddProject} onDropFolder={handleDropFolder} />)}
                </div>
              </>
            )}
            {/* Hidden: keep non-active workspace terminals alive */}
            {Object.entries(workspaceLayouts)
              .filter(([wpath]) => wpath !== activeWorkspacePath)
              .flatMap(([wpath, wsLayout]) =>
                Object.values(wsLayout.panels).flatMap((panel) =>
                  panel.tabs.map((tab) => (
                    <div key={tab.id} style={TAB_HIDDEN_STYLE}>
                      <PaneLayout node={tab.rootNode} workspacePath={wpath} />
                    </div>
                  ))
                )
              )}
            <StatusBar
              onNewWorkspace={handleNewWorkspace}
              onNewTaskWithPrompt={handleNewTaskWithPrompt}
            />
          </div>
        </PaneDragProvider>
      </div>
      <Suspense fallback={null}>
        <CommandPalette
          open={paletteOpen}
          onClose={closePalette}
          onOpenSettings={handleOpenSettings}
          onOpenFeedback={handleOpenFeedback}
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
          initialPage={settingsPage}
        />
        <FeedbackModal open={feedbackOpen} onOpenChange={setFeedbackOpen} />
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
          onSubmit={async (projectId, name, branch, baseBranch, useExistingBranch) => {
            let agentCommand: string | undefined;
            const prompt = agentPromptRef.current;
            if (prompt) {
              const project = projects.find((p) => p.id === projectId);
              const baseCommand =
                project?.agentCommand ?? DEFAULT_AGENT_COMMAND;
              const escaped = prompt
                .replace(/\\/g, "\\\\")
                .replace(/"/g, '\\"')
                .replace(/\$/g, "\\$")
                .replace(/`/g, "\\`")
                .replace(/!/g, "\\!");
              agentCommand = `${baseCommand} "${escaped}"`;
            }
            const result = await createWorktree(
              projectId,
              name,
              branch,
              agentCommand,
              pendingLinkedIssueRef.current ?? undefined,
              baseBranch,
              useExistingBranch,
            );
            if (result) {
              // Ensure the project is selected so the new workspace is visible
              const projIdx = useProjectStore.getState().projects.findIndex((p) => p.id === projectId);
              if (projIdx >= 0) selectProject(projIdx);
              setNewWorkspaceOpen(false);
            }
            return !!result;
          }}
        />
      </Suspense>
      <CloseAgentPaneDialog
        open={pendingCloseConfirmPaneId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingCloseConfirmPaneId(null);
        }}
        onConfirm={() => {
          if (pendingCloseConfirmPaneId !== null) {
            closePaneById(pendingCloseConfirmPaneId);
            setPendingCloseConfirmPaneId(null);
          }
        }}
      />
      <CloseAgentPaneDialog
        open={pendingCloseConfirmTabId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingCloseConfirmTabId(null);
        }}
        onConfirm={() => {
          if (pendingCloseConfirmTabId !== null) {
            closeTab(pendingCloseConfirmTabId);
            setPendingCloseConfirmTabId(null);
          }
        }}
      />
      <ToastContainer />
    </div>
    </TooltipProvider>
  );
}

export default App;

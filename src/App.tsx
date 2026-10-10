import {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  lazy,
  Suspense,
  type CSSProperties,
  type ReactNode,
} from "react";
import { PaneDragProvider } from "./components/workspace-panes/PaneDragContext";
import { StatusBar } from "./components/statusbar/StatusBar/StatusBar";
import { WorkspaceStack } from "./components/panels/WorkspaceStack";
import { Sidebar } from "./components/sidebar/Sidebar/Sidebar";
import { SidebarRail } from "./components/sidebar/SidebarRail/SidebarRail";
import { WindowLead } from "./components/window-lead/WindowLead/WindowLead";
import type { PaletteOrigin, PaletteView } from "./components/command-palette/types";
import type { AddProjectMode } from "./components/sidebar/AddProjectDialog/AddProjectDialog";
import { onPaletteViewRequest } from "./utils/palette-request";
import { onUiRequest } from "./utils/ui-request";
import { GhostsOverlay } from "./components/GhostsOverlay/GhostsOverlay";
import { WorkspaceEmptyState } from "./components/sidebar/WorkspaceEmptyState";
import { HomeEmptyState } from "./components/sidebar/HomeEmptyState";
import { TasksView } from "./components/tasks/TasksView";
import { Onboarding } from "./components/onboarding/Onboarding";
import { ManorLogo } from "./components/ui/ManorLogo";
import { CloseAgentPaneDialog } from "./components/CloseAgentPaneDialog";
import { ToastContainer } from "./components/ui/Toast/Toast";
import { TooltipProvider } from "./components/ui/Tooltip/Tooltip";
import {
  SIDEBAR_MODE_TRANSITION_MS,
  useSidebarModeTransition,
} from "./hooks/useSidebarModeTransition";

const CommandPalette = lazy(() => import("./components/command-palette/CommandPalette").then(m => ({ default: m.CommandPalette })));
const SettingsModal = lazy(() => import("./components/settings/SettingsModal/SettingsModal").then(m => ({ default: m.SettingsModal })));
type SettingsPageId = import("./components/settings/SettingsModal/SettingsModal").SettingsPageId;
const NewWorkspaceDialog = lazy(() => import("./components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog").then(m => ({ default: m.NewWorkspaceDialog })));
const AddProjectDialog = lazy(() => import("./components/sidebar/AddProjectDialog/AddProjectDialog").then(m => ({ default: m.AddProjectDialog })));
const TransferDialogHost = lazy(() => import("./components/hosts/TransferDialogHost").then(m => ({ default: m.TransferDialogHost })));
const ProjectSetupWizard = lazy(() => import("./components/sidebar/ProjectSetupWizard/ProjectSetupWizard").then(m => ({ default: m.ProjectSetupWizard })));
const AgentsModal = lazy(() => import("./components/sidebar/AgentsView/AgentsView").then(m => ({ default: m.AgentsModal })));
const FeedbackModal = lazy(() => import("./components/statusbar/FeedbackModal/FeedbackModal").then(m => ({ default: m.FeedbackModal })));
import {
  useAppStore,
  selectActiveWorkspace,
  selectActiveWorkspaceKey,
  getPersistedActiveWorkspacePath,
  OWN_CLAIM,
} from "./store/app-store";
import {
  useProjectStore,
  runWorkspaceSetupScript,
  type ProjectInfo,
} from "./store/project-store";
import { ownerOf } from "./lib/workspace-directory";
import { workspaceDisplayName } from "./lib/workspace-display-name";
import { parseWorkspaceKey, type WorkspaceKey } from "./lib/workspace-key";
import { appCommandHandlers } from "./lib/app-commands";
import { handleRecordingCommand } from "./lib/webview-recorder";
import {
  dispatchKeybinding,
  runForwardedCommand,
  startNewAgent,
} from "./lib/keybinding-commands";
import { sidebarColumnWidth, windowLeadInset } from "./lib/window-lead";
import {
  createMenuHandlers,
  dispatchMenuCommand,
  type MenuHandler,
} from "./lib/menu-handlers";
import { MAIN_WINDOW_KEYBINDINGS } from "./lib/menu-commands";
import { findPanelWithTab } from "./lib/layout/workspace-layout";
import { PanelLayout } from "./components/panels/PanelLayout";
import { useThemeStore } from "./store/theme-store";
import { useAgentStore } from "./store/agent-store";
import { useMountEffect } from "./hooks/useMountEffect";
import { startAgentActivitySync } from "./store/agent-activity-store";
import { useMenuContextSync } from "./hooks/useMenuContextSync";
import { useUpdaterToasts } from "./hooks/useUpdaterToasts";
import { useToastStore } from "./store/toast-store";
import { useRemoteRecovery } from "./hooks/useRemoteRecovery";
import { useAgentContextRepair } from "./hooks/useAgentContextRepair";
import {
  useNavigationHistory,
  navigateBack,
  navigateForward,
} from "./hooks/useNavigationHistory";
import type { AgentInfo } from "./electron.d";
import { agentWorkspaceKey, navigateToAgent } from "./utils/agent-navigation";
import { paneHasNoAgent, resumeAgentInPane } from "./lib/agent-resume-in-pane";
import { hasPaneId } from "./lib/layout/pane-tree";
import { DEFAULT_AGENT_COMMAND, getAgentKindForCommand } from "./agent-defaults";
import { isHomePath, HOME_PATH } from "./lib/home";
import { isWebApp } from "./lib/platform";
import { useLayoutMode } from "./hooks/useLayoutMode";
import { PhoneChrome } from "./components/phone/PhoneChrome";
import "./App.css";

function App() {
  const loadTheme = useThemeStore((s) => s.loadTheme);
  const applyProjectTheme = useThemeStore((s) => s.applyProjectTheme);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const loadPersistedLayout = useAppStore((s) => s.loadPersistedLayout);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const [appReady, setAppReady] = useState(false);
  // ADR-181 D2: one hook decides phone vs. desk for every renderer. A
  // detached window (OWN_CLAIM below) holds a claim, and the hook always
  // answers "desk" for one, so both render paths below can share this single
  // call.
  const layoutMode = useLayoutMode();

  // Mirror main's persisted agent activity for Home's timeline and sparklines (ADR-199).
  useMountEffect(() => startAgentActivitySync());

  useMountEffect(() => {
    loadTheme();
    // `layout.getAll()` is a read of the Manor server's layout, and the
    // subscription that keeps it current is installed when `app-store.ts` is
    // imported — well before this runs, so a change that lands in the gap is
    // delivered rather than lost (ADR-179 D1).
    Promise.all([loadProjects(), loadPersistedLayout()]).then(() => {
      // A detached window opens on the workspace holding the tab it claims,
      // whatever this renderer would otherwise have reopened on (ADR-179 D4).
      // Its claim names the workspace by key, so it opens on the right host.
      if (OWN_CLAIM) {
        const { path, hostId } = parseWorkspaceKey(OWN_CLAIM.workspacePath);
        setActiveWorkspace(path, hostId);
        // No sidebar in a detached window: plain setState, not the persisting
        // action, so the primary's mode is untouched (ADR-195). Its tab bar
        // clears the macOS traffic lights through the `:root` default of
        // `--window-lead-inset` (ADR-196).
        useProjectStore.setState({ sidebarMode: "hidden" });
        setAppReady(true);
        window.electronAPI.agents.reconcileStale().catch(console.error);
        return;
      }
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
          if (ws) setActiveWorkspace(ws.path, project.hostId);
        }
      }
      setAppReady(true);
      window.electronAPI.agents.reconcileStale().catch(console.error);
    });
  });

  useUpdaterToasts();
  useNavigationHistory();
  useRemoteRecovery();
  useAgentContextRepair();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteOrigin, setPaletteOrigin] = useState<PaletteOrigin>("shortcut");
  const [paletteInitialView, setPaletteInitialView] = useState<PaletteView | undefined>();
  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    setPaletteInitialView(undefined);
  }, []);
  const openPalette = useCallback(() => {
    setPaletteOrigin("search");
    setPaletteOpen(true);
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(
    null,
  );
  const [settingsPage, setSettingsPage] = useState<SettingsPageId | null>(null);
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsProjectId(null);
    setSettingsPage(null);
    setSettingsSection(null);
    // Revert to the active surface's theme in case settings was previewing a
    // different theme. Home and the Tasks view have no project override —
    // they inherit the global theme (null).
    const appState = useAppStore.getState();
    const activeTheme =
      isHomePath(appState.activeWorkspacePath) || appState.activeSurface === "tasks"
      ? null
      : useProjectStore.getState().projects[
          useProjectStore.getState().selectedProjectIndex
        ]?.themeName ?? null;
    applyProjectTheme(activeTheme);
  }, [applyProjectTheme]);
  // Help > "Ghosts!?" easter egg (ADR-170 §8). Owned here rather than the
  // palette so it stays visible with the palette closed, and so both the
  // palette and the native menu can trigger the same overlay.
  const [showGhosts, setShowGhosts] = useState(false);
  const triggerGhosts = useCallback(() => {
    setShowGhosts(true);
    setTimeout(() => setShowGhosts(false), 5000);
  }, []);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const closeAgents = useCallback(() => setAgentsOpen(false), []);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [preselectedProjectId, setPreselectedProjectId] = useState<
    string | null
  >(null);
  const [initialName, setInitialName] = useState("");
  const [initialBranch, setInitialBranch] = useState("");
  const [agentPrompt, setAgentPrompt] = useState<string | null>(null);
  const [_pendingLinkedIssue, setPendingLinkedIssue] = useState<import("./store/project-store").LinkedIssue | null>(null);
  const pendingLinkedIssueRef = useRef<import("./store/project-store").LinkedIssue | null>(null);
  const closeNewWorkspace = useCallback(() => {
    setNewWorkspaceOpen(false);
    setPreselectedProjectId(null);
    setInitialName("");
    setInitialBranch("");
    setAgentPrompt(null);
    setPendingLinkedIssue(null);
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

  const openWizardForProject = useCallback(
    (projectId: string) => {
      const newProjects = useProjectStore.getState().projects;
      const newIndex = newProjects.findIndex((p) => p.id === projectId);
      const newProject = newProjects[newIndex];
      if (newProject) {
        selectProject(newIndex);
        if (newProject.workspaces[0]) {
          selectWorkspace(newProject.id, 0);
        }
        setWizardProjectId(newProject.id);
        setWizardOpen(true);
      }
    },
    [selectProject, selectWorkspace],
  );

  const openWizardForLatestProject = useCallback(() => {
    const newProjects = useProjectStore.getState().projects;
    const newProject = newProjects[newProjects.length - 1];
    if (newProject) openWizardForProject(newProject.id);
  }, [openWizardForProject]);

  const handleAddLocalProject = useCallback(async () => {
    // No filesystem picker in a browser tab (ADR-178). The buttons that call
    // this are hidden on web (`Onboarding`, `HomeEmptyState`); this
    // guard covers any other route to it (the sidebar's context menu among
    // them) so it is a no-op rather than an unhandled `dialog.openDirectory`
    // rejection.
    if (isWebApp()) return;
    const selected = await window.electronAPI.dialog.openDirectory();
    if (selected) {
      const name = selected.split("/").pop() || "Untitled";
      await addProject(name, selected);

      openWizardForLatestProject();
    }
  }, [addProject, openWizardForLatestProject]);

  const [addProjectDialogOpen, setAddProjectDialogOpen] = useState(false);
  const [addProjectDialogMode, setAddProjectDialogMode] = useState<AddProjectMode>("folder");
  const handleAddProject = useCallback(() => {
    setAddProjectDialogMode("folder");
    setAddProjectDialogOpen(true);
  }, []);
  // ADR-194: the palette's "Clone Repository…" opens straight onto cloning.
  const handleCloneRepository = useCallback(() => {
    setAddProjectDialogMode("clone");
    setAddProjectDialogOpen(true);
  }, []);
  // A clone onto this machine gets the same setup wizard as "Open folder".
  const handleLocalProjectCloned = useCallback(
    (project: ProjectInfo) => openWizardForProject(project.id),
    [openWizardForProject],
  );
  const closeAddProjectDialog = useCallback(() => {
    setAddProjectDialogOpen(false);
  }, []);
  const handleRemoteProjectAdded = useCallback(
    (project: ProjectInfo) => {
      const newIndex = useProjectStore
        .getState()
        .projects.findIndex((p) => p.id === project.id);
      if (newIndex >= 0) {
        selectProject(newIndex);
        if (project.workspaces[0]) {
          selectWorkspace(project.id, 0);
        }
      }
    },
    [selectProject, selectWorkspace],
  );

  const handleOpenSettings = useCallback((page?: SettingsPageId) => {
    setSettingsPage(page ?? null);
    setSettingsOpen(true);
  }, []);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const handleOpenFeedback = useCallback(() => setFeedbackOpen(true), []);
  const handleOpenProjectSettings = useCallback(
    (projectId: string, section?: string) => {
      setSettingsProjectId(projectId);
      setSettingsSection(section ?? null);
      setSettingsOpen(true);
    },
    [],
  );
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
      setPaletteOrigin("shortcut");
      setPaletteOpen(true);
    },
    [],
  );

  const handleOpenStats = useCallback(
    () => handleOpenPaletteView("stats"),
    [handleOpenPaletteView],
  );

  useEffect(
    () => onPaletteViewRequest(handleOpenPaletteView),
    [handleOpenPaletteView],
  );

  // The palette's "Ghosts!?" item requests the overlay through the same bus
  // the native menu uses, so both paths share this one trigger.
  useEffect(
    () =>
      onUiRequest((request) => {
        if (request.type === "ghosts") triggerGhosts();
        if (request.type === "clone-repository") handleCloneRepository();
        // Host indicators (sidebar cloud, status-bar chip) open the host section.
        if (request.type === "open-project-settings") {
          handleOpenProjectSettings(request.projectId, request.section);
        }
        if (request.type === "open-remote-settings") handleOpenSettings("remote");
      }),
    [
      triggerGhosts,
      handleOpenProjectSettings,
      handleCloneRepository,
      handleOpenSettings,
    ],
  );

  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const activeWorkspaceKey = useAppStore(selectActiveWorkspaceKey);
  // The workspace's host travels with its key (ADR-191); Home is local.
  const activeWorkspaceHostId = useAppStore((s) => s.activeWorkspaceHostId);
  const activePanelHasTabs = useAppStore(
    (s) => (selectActiveWorkspace(s)?.tabs.length ?? 0) > 0,
  );

  const addTab = useAppStore((s) => s.addTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const pendingCloseConfirmPaneId = useAppStore((s) => s.pendingCloseConfirmPaneId);
  const setPendingCloseConfirmPaneId = useAppStore((s) => s.setPendingCloseConfirmPaneId);
  const closePaneById = useAppStore((s) => s.closePaneById);
  const pendingCloseConfirmTabId = useAppStore((s) => s.pendingCloseConfirmTabId);
  const setPendingCloseConfirmTabId = useAppStore((s) => s.setPendingCloseConfirmTabId);
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const createWorktree = useProjectStore((s) => s.createWorktree);

  // Clean up wizard state if the project is removed while wizard is open
  const wizardStillValid = wizardOpen && wizardProjectId && projects.some((p) => p.id === wizardProjectId);

  const tasksViewShown = useAppStore((s) => s.activeSurface === "tasks");

  // Reactively apply the active surface's theme. Projects carry an optional
  // theme override; Home and the Tasks view have no owning project, so they
  // inherit the global theme (null override) — switching to/from either
  // re-applies here.
  // A detached window paints in its claimed workspace's theme (ADR-179 D4):
  // it has no sidebar selection of its own to read one from.
  const effectiveThemeName = OWN_CLAIM
    ? (ownerOf(projects, OWN_CLAIM.workspacePath as WorkspaceKey)?.themeName ?? null)
    : isHomePath(activeWorkspacePath) || tasksViewShown
      ? null
      : projects[selectedProjectIndex]?.themeName ?? null;
  const prevThemeRef = useRef(effectiveThemeName);
  if (effectiveThemeName !== prevThemeRef.current) {
    prevThemeRef.current = effectiveThemeName;
    applyProjectTheme(effectiveThemeName);
  }
  const sidebarMode = useProjectStore((s) => s.sidebarMode);
  const sidebarWidth = useProjectStore((s) => s.sidebarWidth);
  const sidebarAnimating = useSidebarModeTransition(sidebarMode);

  const hasProjects = projects.length > 0;
  // How far the top-left panel's tab bar starts in to clear the WindowLead
  // (ADR-196). With no projects there is no sidebar and no lead; the
  // `:root` default in App.css still clears the traffic lights.
  const appBodyStyle = hasProjects
    ? ({
        "--window-lead-inset": `${windowLeadInset(sidebarMode, sidebarWidth)}px`,
        "--sidebar-mode-transition": `${SIDEBAR_MODE_TRANSITION_MS}ms`,
      } as CSSProperties)
    : undefined;
  // Home is the Dashboard and never shows tabs (ADR-197 §1): its view is
  // always rendered, even if a stale layout were somehow keyed to it.
  const hasTabs = !isHomePath(activeWorkspacePath) && activePanelHasTabs;
  // With zero projects the onboarding screen (ADR-194 §3) replaces everything.
  const showOnboarding = !hasProjects;
  // The Tasks view (ADR-198) covers the active workspace, which stays active
  // (and mounted) underneath.
  const showTasksView = tasksViewShown && hasProjects;

  // Keep the prewarmed session in sync with the active workspace.
  // Derive the agent command outside the effect so it only re-fires when the
  // command actually changes, not on every unrelated project mutation.
  // By key: a local and a remote project can share a path (ADR-191).
  const activeProject = ownerOf(projects, activeWorkspaceKey);
  // The launch command for the active project workspace. Shared by prewarming
  // and both new-agent handlers below.
  const activeWorkspaceCommand =
    activeProject?.agentCommand ?? DEFAULT_AGENT_COMMAND;
  useEffect(() => {
    // The Dashboard hosts no panes (ADR-197 §1), so there is nothing to prewarm
    // for; the session keeps the last project workspace's cwd.
    if (!activeWorkspacePath || isHomePath(activeWorkspacePath)) return;
    const prewarmKind = getAgentKindForCommand(activeWorkspaceCommand);
    window.electronAPI.pty.updatePrewarmCwd(
      activeWorkspacePath,
      activeWorkspaceHostId,
      activeWorkspaceCommand,
      prewarmKind,
    );
  }, [activeWorkspacePath, activeWorkspaceHostId, activeWorkspaceCommand]);

  // Projects mutated outside the renderer (MCP, CLI) — the store never saw the
  // result, so refetch it. Creating a workspace this way must show up in the
  // sidebar without a manual refresh.
  useEffect(() => window.electronAPI.projects.onChanged(() => {
    void loadProjects();
  }), [loadProjects]);

  // Backstop for worktree changes main can't watch — a remote project's git
  // lives on another machine. Coming back to the window is when a stale
  // sidebar would be noticed. Local projects are left to the worktree
  // watcher, and the store throttles repeated focuses.
  useMountEffect(() => {
    const onFocus = () => void useProjectStore.getState().refreshRemoteProjects();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  });

  // Webview recording (ADR-158). Main owns the file and the lifecycle, but only
  // a renderer can call `getUserMedia`, so it drives the `MediaRecorder` here.
  // The store mirrors the same state so the pane can show a "Recording"
  // indicator — a capture the user cannot see running is not acceptable, so
  // this has to track both ends of the lifecycle:
  //  - "stop" clears immediately (covers a clean agent stop AND the
  //    `maxDurationSec` auto-stop, both of which arrive as "stop").
  //  - "start" only lights up once `handleRecordingCommand` confirms the
  //    renderer's `MediaRecorder` actually started; a setup failure
  //    (missing mediaSourceId, getUserMedia rejection) must never show a red
  //    dot for a capture that never happened.
  useEffect(
    () =>
      window.electronAPI.webview.onRecordingCommand((command) => {
        if (command.cmd === "stop") {
          useAppStore.getState().setPaneRecordingStartedAt(command.paneId, null);
        }
        void handleRecordingCommand(command).then((result) => {
          if (command.cmd === "start") {
            useAppStore
              .getState()
              .setPaneRecordingStartedAt(
                command.paneId,
                result.ok ? Date.now() : null,
              );
          }
        });
      }),
    [],
  );

  // App-commands from the main process (e.g. MCP start_agent). Main cannot
  // create panes directly, so it round-trips over the "app-command" channel.
  // Payloads carrying a `requestId` are answered by `appCommandHandlers`;
  // `run-setup-script` is the last fire-and-forget straggler, kept here
  // because it needs this component's `runWorkspaceSetupScript`.
  useEffect(() => {
    const cleanup = window.electronAPI.appCommands.onCommand(
      async ({ cmd, requestId, workspacePath, hostId, script, args }) => {
        if (cmd === "run-setup-script" && workspacePath && script) {
          await loadProjects(); // ensure a freshly-created workspace is visible
          setActiveWorkspace(workspacePath, hostId);
          // Main names the workspace's project host: the path alone may be
          // on two hosts.
          runWorkspaceSetupScript(workspacePath, script, hostId);
          return;
        }

        if (!requestId) return;
        try {
          const handler = appCommandHandlers[cmd];
          // Must reject before an optional-chained call yields `undefined`:
          // replying `ok: true` to an unknown cmd hangs main until its timeout.
          if (!handler) throw new Error(`Unknown command: ${cmd}`);
          const data = await handler(args ?? {});
          void window.electronAPI.appCommands.result({ requestId, ok: true, data });
        } catch (err) {
          void window.electronAPI.appCommands.result({
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
  // One command ID → action map for the keyboard, the native menu AND the
  // command palette — `run` over the command table (ADR-170, ADR-182 D10).
  // The window-agnostic half is shared with the detached-window renderer (see
  // `keybinding-commands`); the rest needs this window's chrome — the
  // callbacks below. The primary window is the one that owns the prewarmed
  // session, so it is also the only window that consumes it for a new agent.
  //
  // A detached window shows one tab and none of the primary's chrome (D4), so
  // its map holds only the table's `scope: "any"` commands, and a combo bound
  // to the sidebar, the palette or settings runs in the primary window
  // instead of silently doing nothing here: the dispatcher finds no handler
  // and the fallback forwards the command.
  const menuHandlersRef = useRef<Record<string, MenuHandler>>({});
  menuHandlersRef.current = createMenuHandlers(
    {
      openSettings: (page) => {
        // Deep links open the page they name; the bare command (⌘, and the
        // app menu's Settings… item) keeps toggling, as the keybinding always
        // did.
        if (page) {
          handleOpenSettings(page);
          return;
        }
        setSettingsPage(null);
        setSettingsOpen((v) => !v);
      },
      togglePalette: () => {
        setPaletteOrigin("shortcut");
        setPaletteOpen((v) => !v);
      },
      openPaletteView: handleOpenPaletteView,
      openNewWorkspace: () => setNewWorkspaceOpen(true),
      addProject: () => void handleAddProject(),
      openFeedback: handleOpenFeedback,
      openAgents: () => setAgentsOpen(true),
      openProjectSettings: handleOpenProjectSettings,
      resumeAgent: (agentId) => {
        // The menu only carries the id; resuming needs the whole record.
        const agent = useAgentStore
          .getState()
          .agents.find((a) => a.id === agentId);
        if (agent) void handleResumeAgent(agent);
      },
      showGhosts: triggerGhosts,
    },
    { primary: !OWN_CLAIM },
  );

  const localHandlers = useCallback(() => menuHandlersRef.current, []);
  const dispatchOptions = useMemo(
    () =>
      OWN_CLAIM
        ? {
            fallback: (commandId: string) => {
              if (!MAIN_WINDOW_KEYBINDINGS.has(commandId)) return false;
              window.electronAPI.keybindings.runInMainWindow(commandId);
              return true;
            },
          }
        : {},
    [],
  );
  // The palette runs its table items through the same map.
  const runCommand = useCallback(
    (commandId: string, args?: Record<string, unknown>) =>
      dispatchMenuCommand({ commandId, args }, localHandlers()),
    [localHandlers],
  );

  useMountEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      dispatchKeybinding(e, localHandlers(), dispatchOptions);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  // Bound combos pressed inside a web page, or primary-only shortcuts pressed
  // in a popout, arrive from main and run like a local key press (ADR-175).
  useMountEffect(() =>
    window.electronAPI.keybindings.onForwardedCommand((payload) =>
      runForwardedCommand(payload, localHandlers(), dispatchOptions),
    ),
  );

  // Native menu clicks land on the same map. Main has already routed the
  // command here, so nothing is filtered on this side.
  useMountEffect(() =>
    window.electronAPI.menu.onMenuCommand((payload) =>
      dispatchMenuCommand(payload, localHandlers()),
    ),
  );

  useMenuContextSync();

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

  const handleResumeAgent = useCallback(
    async (agent: AgentInfo) => {
      // The agent's workspace, on its host (ADR-191).
      const agentKey = agentWorkspaceKey(agent, projects);
      // If the agent is active and has a pane, switch to it instead of opening a new tab
      if (agent.status === "active" && agent.paneId && agentKey) {
        const wsLayout = useAppStore.getState().workspaceLayouts[agentKey];
        if (wsLayout) {
          const paneExists = Object.values(wsLayout.panels).some((panel) =>
            panel.tabs.some((tab) => hasPaneId(tab.rootNode, agent.paneId!)),
          );
          if (paneExists) {
            navigateToAgent(agent);
            // Its pane came back as a bare shell (the terminal session was
            // lost): bring the agent back there rather than show it empty.
            const paneStatus = useAppStore.getState().paneAgentStatus[agent.paneId];
            if (paneHasNoAgent(paneStatus)) void resumeAgentInPane(agent);
            return;
          }
        }
      }

      const wsPath = agent.workspacePath;
      // The Dashboard hosts no panes (ADR-197 §2), so a Home agent has
      // nowhere to resume into.
      if (isHomePath(wsPath)) {
        useToastStore.getState().addToast({
          id: `resume-home-agent-${agent.id}`,
          message: "Dashboard agents can't be resumed",
          status: "info",
        });
        return;
      }
      if (wsPath && agentKey) {
        setActiveWorkspace(wsPath, parseWorkspaceKey(agentKey).hostId);
      }
      const activePath = wsPath ?? useAppStore.getState().activeWorkspacePath;
      if (activePath) {
        const agentProject = ownerOf(projects, agentKey);
        const agentCommand =
          agent.agentCommand ??
          agentProject?.agentCommand ??
          DEFAULT_AGENT_COMMAND;
        // Don't consume prewarmed — resume needs a specific --resume command.
        // The line is queued on the server (ADR-179 ticket 11).
        useAppStore
          .getState()
          .addTerminalTab(`${agentCommand} --resume ${agent.agentSessionId}`, {
            kind: "agent-startup",
          });
      } else {
        addTab();
      }
    },
    [setActiveWorkspace, addTab, projects],
  );

  const handleNewAgent = useCallback(async () => {
    // Every surface — Home and project workspaces alike — consumes a prewarmed
    // session when one is ready. On a cold start (no prewarm, or the command
    // hadn't been injected yet) seed the surface's launch command; the pty
    // boundary resolves the cwd, so Home needs no special casing here.
    await startNewAgent({ prewarm: true });
  }, []);

  // A detached window's one panel: the one holding the tab it claims, in this
  // window's replica of the shared layout (ADR-179 D4). A string, so the
  // selector is stable across unrelated layout changes.
  const claimPanelId = useAppStore((s) => {
    if (!OWN_CLAIM) return null;
    const layout = s.workspaceLayouts[OWN_CLAIM.workspacePath];
    return layout ? (findPanelWithTab(layout, OWN_CLAIM.tabId)?.panel.id ?? null) : null;
  });

  if (!appReady) {
    return (
      <div className="app splash-screen">
        <div className="splash-logo">
          <ManorLogo />
        </div>
      </div>
    );
  }

  // A detached window: one panel, one tab, and none of the primary's chrome
  // (ADR-179 D4). The tab bar it renders is the claimed tab's own — which is
  // where "Move Back to Main Window" lives — and the panel tree around it
  // belongs to the primary, which is still showing every other tab of the
  // same workspace.
  let content: ReactNode;
  if (OWN_CLAIM) {
    content = claimPanelId ? (
      <div className="app-body">
        <PaneDragProvider>
          <div className="main-content main-content--gutter-left main-content--gutter-bottom">
            <PanelLayout
              node={{ type: "leaf", panelId: claimPanelId }}
              workspaceKey={OWN_CLAIM.workspacePath as WorkspaceKey}
              onNewAgent={handleNewAgent}
            />
          </div>
        </PaneDragProvider>
      </div>
    ) : (
      // The tab is not here yet (the first broadcast is in flight) or
      // not here any more — in which case the store has already asked
      // this window to close.
      <div className="splash-screen" style={{ flex: 1 }}>
        <div className="drag-region" />
        <div className="splash-logo">
          <ManorLogo />
        </div>
      </div>
    );
  } else {
    content = (
      <>
          <div
            className="app-body"
            style={layoutMode === "desk" ? appBodyStyle : undefined}
            data-sidebar-animating={sidebarAnimating || undefined}
          >
            {/* One column for every sidebar mode, so a mode change animates its
                width instead of swapping views at a new size. ADR-181 D3: in
                phone mode the sidebar is a drawer instead, never rendered inline
                — it would eat the whole screen at phone width. */}
            {hasProjects && layoutMode === "desk" && (
              <div
                className="sidebar-column"
                style={{ width: sidebarColumnWidth(sidebarMode, sidebarWidth) }}
              >
                {sidebarMode === "rail" && (
                  <SidebarRail
                    onShowAgents={() => setAgentsOpen(true)}
                    onOpenProjectSettings={handleOpenProjectSettings}
                    onOpenSearch={openPalette}
                  />
                )}
                {sidebarMode === "full" && (
                  <Sidebar
                    onShowAgents={() => setAgentsOpen(true)}
                    onOpenProjectSettings={handleOpenProjectSettings}
                    onAddProject={handleAddProject}
                    onOpenSearch={openPalette}
                  />
                )}
              </div>
            )}
            <PaneDragProvider>
              <div
                className={`main-content ${hasProjects && layoutMode === "desk" ? "" : "main-content--gutter-left"}`}
              >
                {/* ADR-181 D3: the phone shell — top bar, sidebar drawer and pane
                    switcher — sits around the workspace stack, not inside it. */}
                {layoutMode === "phone" && (
                  <PhoneChrome
                    onShowAgents={() => setAgentsOpen(true)}
                    onOpenProjectSettings={handleOpenProjectSettings}
                    onAddProject={handleAddProject}
                    onOpenPalette={() => {
                      // The phone's command surface (ADR-181 D5), so it opens
                      // scoped like the keyboard shortcut, not the search box.
                      setPaletteOrigin("shortcut");
                      setPaletteOpen(true);
                    }}
                  />
                )}
                {/* Every workspace renders through the same PanelLayout in a single
                    positioned stack, active or not. Inactive ones are only hidden,
                    never unmounted or re-parented, so their terminals keep the exact
                    pixel box the active workspace has. Any geometry difference here
                    resizes the PTY on every workspace switch, and a SIGWINCH makes
                    full-screen TUIs repaint their frame into the scrollback — which
                    shows up as the same output duplicated over and over. */}
                <div className="workspace-stack">
                  {/* `workspaceLayouts` is keyed by `WorkspaceKey` (ADR-191). */}
                  <WorkspaceStack
                    visibleKey={
                      hasTabs && !showOnboarding && !showTasksView ? activeWorkspaceKey : null
                    }
                    onNewAgent={handleNewAgent}
                  />
                  {(showOnboarding || showTasksView || !(activeWorkspacePath && hasTabs)) && (
                    <div className="empty-surface">
                      <div className="surface-header">
                        <span className="surface-title">
                          {wizardStillValid && wizardProjectId
                            ? "Project setup"
                            : showOnboarding
                            ? "Welcome"
                            : showTasksView
                            ? "Tasks"
                            : workspaceDisplayName(activeWorkspaceKey, projects)}
                        </span>
                      </div>
                      <div className="terminal-container">
                        {wizardStillValid && wizardProjectId
                          ? <Suspense fallback={null}><ProjectSetupWizard projectId={wizardProjectId} onClose={closeWizard} /></Suspense>
                          : showOnboarding
                          ? <Onboarding onAddLocal={handleAddLocalProject} onClone={handleCloneRepository} />
                          : showTasksView
                          ? <TasksView onNewWorkspace={handleNewWorkspace} />
                          : !hasTabs &&
                            (isHomePath(activeWorkspacePath)
                              ? (
                                  <HomeEmptyState onNewWorkspace={handleNewWorkspace} />
                                )
                              : <WorkspaceEmptyState onNewWorkspace={handleNewWorkspace} />)}
                      </div>
                    </div>
                  )}
                </div>
                {/* ADR-181 D3: no status bar in phone mode — the top bar and the
                    palette are the phone's chrome. */}
                {layoutMode === "desk" && (
                  <StatusBar
                    onNewWorkspace={handleNewWorkspace}
                    onOpenStats={handleOpenStats}
                  />
                )}
              </div>
            </PaneDragProvider>
            {/* The top-left and top-right controls (ADR-196). Not shown before the first
                project: the onboarding overview has no sidebar to toggle or
                history to walk, and its drag region clears the traffic lights.
                Rendered last on purpose: Electron resolves overlapping
                `-webkit-app-region`s in DOM order, so when the lead overlaps the
                top-left tab bar (rail and hidden modes) its buttons must come
                after the bar's drag region or clicks on them never arrive. */}
            {hasProjects && layoutMode === "desk" && <WindowLead />}
          </div>
          <Suspense fallback={null}>
            <CommandPalette
              open={paletteOpen}
              origin={paletteOrigin}
              onClose={closePalette}
              onOpenSettings={handleOpenSettings}
              onNewWorkspace={handleNewWorkspace}
              initialView={paletteInitialView}
              onResumeAgent={handleResumeAgent}
              onViewAllAgents={() => setAgentsOpen(true)}
              onNewAgent={handleNewAgent}
              onRunCommand={runCommand}
            />
            <SettingsModal
              open={settingsOpen}
              onClose={closeSettings}
              initialProjectId={settingsProjectId}
              initialPage={settingsPage}
              initialSection={settingsSection}
            />
            <FeedbackModal open={feedbackOpen} onOpenChange={setFeedbackOpen} />
            <AgentsModal
              open={agentsOpen}
              onClose={closeAgents}
              onResumeAgent={handleResumeAgent}
            />
            <AddProjectDialog
              open={addProjectDialogOpen}
              onClose={closeAddProjectDialog}
              initialMode={addProjectDialogMode}
              onAddLocal={handleAddLocalProject}
              onLocalProjectCloned={handleLocalProjectCloned}
              onRemoteProjectAdded={handleRemoteProjectAdded}
            />
            <TransferDialogHost />
            <NewWorkspaceDialog
              open={newWorkspaceOpen}
              onClose={closeNewWorkspace}
              projects={projects}
              selectedProjectIndex={selectedProjectIndex}
              preselectedProjectId={preselectedProjectId}
              initialName={initialName}
              initialBranch={initialBranch}
              initialAgentPrompt={agentPrompt ?? undefined}
              onSubmit={async (projectId, name, branch, baseBranch, useExistingBranch, folderId, prompt) => {
                // From the Tasks view, stay there: the workspace is made behind it.
                const background = useAppStore.getState().activeSurface === "tasks";
                const result = await createWorktree(projectId, name, {
                  branch,
                  agentPrompt: prompt,
                  linkedIssue: pendingLinkedIssueRef.current ?? undefined,
                  baseBranch,
                  useExistingBranch,
                  folderId,
                  background,
                });
                if (result) {
                  // Ensure the project is selected so the new workspace is visible
                  if (!background) {
                    const projIdx = useProjectStore.getState().projects.findIndex((p) => p.id === projectId);
                    if (projIdx >= 0) selectProject(projIdx);
                  }
                  setNewWorkspaceOpen(false);
                }
                return !!result;
              }}
            />
          </Suspense>
      </>
    );
  }

  return (
    <TooltipProvider>
    <div className="app" data-layout={layoutMode}>
      {content}
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
      {!OWN_CLAIM && showGhosts && <GhostsOverlay />}
    </div>
    </TooltipProvider>
  );
}

export default App;

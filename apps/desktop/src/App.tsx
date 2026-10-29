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
import { MoveToWorkspacePicker } from "./components/move-to-workspace/MoveToWorkspacePicker";
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
import { UnsavedEditsDialog } from "./components/unsaved-edits/UnsavedEditsDialog";
import { useOpenFileStore, unsavedFilesIn } from "./store/open-file-store";
import { allPaneIds } from "./lib/layout/pane-tree";
import { ToastContainer } from "./components/ui/Toast/Toast";
import { UnlockToast } from "./components/achievements/UnlockToast";
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
import { RemoveFromHostDialog } from "./components/sidebar/RemoveFromHostDialog";
import { DeletePodDialogHost } from "./components/hosts/DeletePodDialogHost";
import { ProfileEditorDialog } from "./components/settings/HostsPage/ProfileEditorDialog";
import { useHostProfileStore } from "./store/host-profile-store";
const TransferDialogHost = lazy(() => import("./components/hosts/TransferDialogHost").then(m => ({ default: m.TransferDialogHost })));
const ProjectSetupWizard = lazy(() => import("./components/sidebar/ProjectSetupWizard/ProjectSetupWizard").then(m => ({ default: m.ProjectSetupWizard })));
const AgentsModal = lazy(() => import("./components/sidebar/AgentsView/AgentsView").then(m => ({ default: m.AgentsModal })));
const FeedbackModal = lazy(() => import("./components/statusbar/FeedbackModal/FeedbackModal").then(m => ({ default: m.FeedbackModal })));
import {
  useAppStore,
  selectActiveWorkspace,
  selectActiveWorkspaceKey,
  selectAgentRunningIn,
  OWN_CLAIM,
} from "./store/app-store";
import { useShallow } from "zustand/react/shallow";

/** No panes: one array, so a selector that finds none returns the same one. */
const NO_PANES: readonly string[] = [];
import { useProjectStore, type ProjectInfo } from "./store/project-store";
import { ownerOf } from "./lib/workspace-directory";
import { workspaceDisplayName } from "./lib/workspace-display-name";
import { type WorkspaceKey } from "./lib/workspace-key";
import { appCommandHandlers } from "./lib/app-commands";
import { handleRecordingCommand } from "./lib/webview-recorder";
import {
  dispatchKeybinding,
  newAgent,
  runForwardedCommand,
} from "./lib/keybinding-commands";
import {
  lightsWidth,
  sidebarColumnWidth,
  windowLeadInset,
} from "./lib/window-lead";
import {
  createMenuHandlers,
  dispatchMenuCommand,
  type MenuHandler,
} from "./lib/menu-handlers";
import { MAIN_WINDOW_KEYBINDINGS } from "./lib/menu-commands";
import { findPanelWithTab } from "./lib/layout/workspace-layout";
import { PanelLayout } from "./components/panels/PanelLayout";
import { useThemeStore, startThemeSync } from "./store/theme-store";
import { onBridgeResync } from "./bridge/resync";
import { launch, resyncAfterReconnect, retryLoadProjects } from "./lib/launch";
import { useAgentStore } from "./store/agent-store";
import { useMountEffect } from "./hooks/useMountEffect";
import { startAgentActivitySync } from "./store/agent-activity-store";
import { useMenuContextSync } from "./hooks/useMenuContextSync";
import { useUpdaterToasts } from "./hooks/useUpdaterToasts";
import { useRemoteRecovery } from "./hooks/useRemoteRecovery";
import { useTerminalResync } from "./hooks/useTerminalResync";
import { useAgentContextRepair } from "./hooks/useAgentContextRepair";
import {
  useNavigationHistory,
  navigateBack,
  navigateForward,
} from "./hooks/useNavigationHistory";
import { resumeAgent } from "./lib/agent-resume";
import { DEFAULT_AGENT_COMMAND, getAgentKindForCommand } from "./agent-defaults";
import { isHomePath } from "./lib/home";
import { isWebApp } from "./lib/platform";
import { useConnection } from "./bridge/connection";
import { useLayoutMode } from "./hooks/useLayoutMode";
import { WorkspaceWatchers } from "./components/WorkspaceWatchers";
import { PhoneNewAgentComposer } from "./components/phone/NewAgent/PhoneNewAgentComposer";
import { PhoneChrome } from "./components/phone/PhoneChrome";
import { FallbackScreen } from "./components/ui/ErrorBoundary/FallbackScreen";
import { DetachedWindowPending } from "./components/DetachedWindowPending";
import { Button } from "./components/ui/Button/Button";
import { installUnhandledRejectionToasts } from "./lib/unhandled-rejection";
import "./App.css";

function App() {
  const applyProjectTheme = useThemeStore((s) => s.applyProjectTheme);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const projectsLoadError = useProjectStore((s) => s.loadError);
  const [appReady, setAppReady] = useState(false);
  // One hook decides phone vs. desk for every renderer. A
  // detached window (OWN_CLAIM below) holds a claim, and the hook always
  // answers "desk" for one, so both render paths below can share this single
  // call.
  const layoutMode = useLayoutMode();

  // Mirror main's persisted agent activity for Home's timeline and sparklines.
  useMountEffect(() => startAgentActivitySync());

  // The host profiles "In a new pod" offers; kept current by
  // the store's own change subscription.
  useMountEffect(() => void useHostProfileStore.getState().refresh());

  // The selected theme, kept live, and re-read on a bridge resync.
  useMountEffect(() => startThemeSync());

  // A rejection nothing caught reaches the user as a toast.
  useMountEffect(() => installUnhandledRejectionToasts());

  // A reconnected browser re-reads what it missed, or launches again if its
  // boot could not read anything.
  useMountEffect(() => onBridgeResync(resyncAfterReconnect));

  useMountEffect(() => {
    void launch().then(() => setAppReady(true));
  });

  useUpdaterToasts();
  useNavigationHistory();
  useRemoteRecovery();
  useTerminalResync();
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
  // The phone's command surface: the drawer's Search row and the
  // top bar's menu open the same palette, scoped like the keyboard shortcut.
  const openPhonePalette = useCallback(() => {
    setPaletteOrigin("shortcut");
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
      isHomePath(appState.activeWorkspacePath) ||
      appState.activeSurface === "tasks" ||
      appState.activeSurface === "composer"
      ? null
      : useProjectStore.getState().projects[
          useProjectStore.getState().selectedProjectIndex
        ]?.themeName ?? null;
    applyProjectTheme(activeTheme);
  }, [applyProjectTheme]);
  // Help > "Ghosts!?" easter egg. Owned here rather than the
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
    // No filesystem picker in a browser tab. The buttons that call
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
  // The palette's "Clone Repository…" opens straight onto cloning.
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
        // The switch lives on This Mac's row of Settings → Hosts.
        if (request.type === "open-hosts-settings") {
          setSettingsPage("hosts");
          if (request.hostId) setSettingsSection(`host-${request.hostId}`);
          setSettingsOpen(true);
        }
        if (request.type === "open-remote-settings") {
          setSettingsPage("hosts");
          setSettingsSection("host-local");
          setSettingsOpen(true);
        }
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
  // The workspace's host travels with its key; Home is local.
  const activeWorkspaceHostId = useAppStore((s) => s.activeWorkspaceHostId);
  const activePanelHasTabs = useAppStore(
    (s) => (selectActiveWorkspace(s)?.tabs.length ?? 0) > 0,
  );

  const closeTab = useAppStore((s) => s.closeTab);
  const pendingCloseConfirmPaneId = useAppStore((s) => s.pendingCloseConfirmPaneId);
  const setPendingCloseConfirmPaneId = useAppStore((s) => s.setPendingCloseConfirmPaneId);
  const closePaneById = useAppStore((s) => s.closePaneById);
  const pendingCloseConfirmTabId = useAppStore((s) => s.pendingCloseConfirmTabId);
  const setPendingCloseConfirmTabId = useAppStore((s) => s.setPendingCloseConfirmTabId);
  // What the close confirms are about: whether an agent is running in the
  // panes closing, and every file with unsaved edits among them.
  const closingPaneIds = useMemo(
    () => (pendingCloseConfirmPaneId ? [pendingCloseConfirmPaneId] : []),
    [pendingCloseConfirmPaneId],
  );
  const closingTabPaneIds = useAppStore(
    useShallow((s) => {
      if (!pendingCloseConfirmTabId) return NO_PANES;
      const tab = selectActiveWorkspace(s)?.tabs.find((t) => t.id === pendingCloseConfirmTabId);
      return tab ? allPaneIds(tab.rootNode) : NO_PANES;
    }),
  );
  const agentInClosingPane = useAppStore((s) => selectAgentRunningIn(s, closingPaneIds));
  const agentInClosingTab = useAppStore((s) => selectAgentRunningIn(s, closingTabPaneIds));
  const unsavedInClosingPane = useOpenFileStore(
    useShallow((s) => unsavedFilesIn(s, closingPaneIds)),
  );
  const unsavedInClosingTab = useOpenFileStore(
    useShallow((s) => unsavedFilesIn(s, closingTabPaneIds)),
  );
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const createWorktree = useProjectStore((s) => s.createWorktree);

  // Clean up wizard state if the project is removed while wizard is open
  const wizardStillValid = wizardOpen && wizardProjectId && projects.some((p) => p.id === wizardProjectId);

  const tasksViewShown = useAppStore((s) => s.activeSurface === "tasks");
  // The phone new-agent composer covers the workspace. It is a
  // phone surface: a renderer that widens out of phone layout goes back to
  // the workspace, so every reader of the surface agrees.
  const composerShown = useAppStore((s) => s.activeSurface === "composer");
  useEffect(() => {
    if (layoutMode !== "phone" && useAppStore.getState().activeSurface === "composer") {
      useAppStore.getState().closeComposer();
    }
  }, [layoutMode]);

  // Reactively apply the active surface's theme. Projects carry an optional
  // theme override; Home and the Tasks view have no owning project, so they
  // inherit the global theme (null override) — switching to/from either
  // re-applies here.
  // A detached window paints in its claimed workspace's theme:
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
  // How far the top-left panel's tab bar starts in to clear the WindowLead.
  // With no projects there is no sidebar and no lead; the
  // `:root` default in App.css still clears the traffic lights.
  const appBodyStyle = hasProjects
    ? ({
        "--window-lead-inset": `${windowLeadInset(sidebarMode, sidebarWidth, lightsWidth())}px`,
        "--sidebar-mode-transition": `${SIDEBAR_MODE_TRANSITION_MS}ms`,
      } as CSSProperties)
    : undefined;
  // Home is the Dashboard and never shows tabs: its view is
  // always rendered, even if a stale layout were somehow keyed to it.
  const hasTabs = !isHomePath(activeWorkspacePath) && activePanelHasTabs;
  // With zero projects the onboarding screen replaces everything.
  // A failed load is not a fresh install: it gets a retry
  // screen in onboarding's place.
  const projectsLoadFailed = projectsLoadError !== null && !hasProjects;
  const showOnboarding = !hasProjects && !projectsLoadFailed;
  // The Tasks view covers the active workspace, which stays active
  // (and mounted) underneath.
  const showTasksView = tasksViewShown && hasProjects;

  // Keep the prewarmed session in sync with the active workspace.
  // Derive the agent command outside the effect so it only re-fires when the
  // command actually changes, not on every unrelated project mutation.
  // By key: a local and a remote project can share a path.
  const activeProject = ownerOf(projects, activeWorkspaceKey);
  // The launch command for the active project workspace. Shared by prewarming
  // and both new-agent handlers below.
  const activeWorkspaceCommand =
    activeProject?.agentCommand ?? DEFAULT_AGENT_COMMAND;
  useEffect(() => {
    // The Dashboard hosts no panes, so there is nothing to prewarm
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

  // Webview recording. Main owns the file and the lifecycle, but only
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

  // App-commands from the main process, answered by `appCommandHandlers`.
  // A new workspace's setup script no longer comes this way: the server runs
  // it itself, in a tab of its own.
  useEffect(() => {
    const cleanup = window.electronAPI.appCommands.onCommand(
      async ({ cmd, requestId, args }) => {
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
  }, []);

  // Keybindings
  // One command ID → action map for the keyboard, the native menu AND the
  // command palette — `run` over the command table.
  // The window-agnostic half is shared with the detached-window renderer (see
  // `keybinding-commands`); the rest needs this window's chrome — the
  // callbacks below. The primary window is the one that owns the prewarmed
  // session, so it is also the only window that consumes it for a new agent.
  //
  // A detached window shows one tab and none of the primary's chrome, so
  // its map holds only the table's `scope: "any"` commands, and a combo bound
  // to the sidebar, the palette or settings runs in the primary window
  // instead of silently doing nothing here: the dispatcher finds no handler
  // and the fallback forwards the command.
  const menuHandlersRef = useRef<Record<string, MenuHandler>>({});
  const { isHostServer: onHostServer } = useConnection();
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
        if (agent) resumeAgent(agent);
      },
      showGhosts: triggerGhosts,
    },
    // Rebuilt when the hello says this is a host server, which
    // drops the commands it cannot serve.
    { primary: !OWN_CLAIM, hostServer: onHostServer },
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
  // in a popout, arrive from main and run like a local key press.
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

  // Every surface — Home and project workspaces alike — consumes a prewarmed
  // session when one is ready. On a cold start (no prewarm, or the command
  // hadn't been injected yet) seed the surface's launch command; the pty
  // boundary resolves the cwd, so Home needs no special casing here. A phone
  // opens the new-agent composer instead (`newAgent`).
  const handleNewAgent = useCallback(() => newAgent({ prewarm: true }), []);

  // A detached window's one panel: the one holding the tab it claims, in this
  // window's replica of the shared layout. A string, so the
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

  // A detached window: one panel, one tab, and none of the primary's chrome.
  // The tab bar it renders is the claimed tab's own — which is
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
      // this window to close. If it never comes, this says so.
      <DetachedWindowPending />
    );
  } else {
    content = (
      <>
          <WorkspaceWatchers />
          <div
            className="app-body"
            style={layoutMode === "desk" ? appBodyStyle : undefined}
            data-sidebar-animating={sidebarAnimating || undefined}
          >
            {/* One column for every sidebar mode, so a mode change animates its
                width instead of swapping views at a new size. In phone mode the
                sidebar is a drawer instead, never rendered inline — it would
                eat the whole screen at phone width. */}
            {/* Around the sidebar too: its workspace rows take a pane or
                tab dropped on them (`useWorkspaceMoveDrop`). */}
            <PaneDragProvider>
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
              <div
                className={`main-content ${hasProjects && layoutMode === "desk" ? "" : "main-content--gutter-left"}`}
              >
                {/* The phone shell — top bar, sidebar drawer and pane
                    switcher — sits around the workspace stack, not inside it. */}
                {layoutMode === "phone" && (
                  <PhoneChrome
                    onNewAgent={handleNewAgent}
                    onOpenSettings={() => handleOpenSettings()}
                    onOpenSearch={openPhonePalette}
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
                  {/* `workspaceLayouts` is keyed by `WorkspaceKey`. */}
                  <WorkspaceStack
                    visibleKey={
                      hasTabs && !showOnboarding && !projectsLoadFailed && !showTasksView && !composerShown
                        ? activeWorkspaceKey
                        : null
                    }
                    onNewAgent={handleNewAgent}
                  />
                  {(showOnboarding || projectsLoadFailed || showTasksView || composerShown || !(activeWorkspacePath && hasTabs)) && (
                    <div className="empty-surface">
                      <div className="surface-header">
                        <span className="surface-title">
                          {wizardStillValid && wizardProjectId
                            ? "Project setup"
                            : projectsLoadFailed
                            ? "Projects"
                            : showOnboarding
                            ? "Welcome"
                            : showTasksView
                            ? "Tasks"
                            : composerShown
                            ? "New agent"
                            : workspaceDisplayName(activeWorkspaceKey, projects)}
                        </span>
                      </div>
                      <div className="terminal-container">
                        {wizardStillValid && wizardProjectId
                          ? <Suspense fallback={null}><ProjectSetupWizard projectId={wizardProjectId} onClose={closeWizard} /></Suspense>
                          : projectsLoadFailed
                          ? (
                              <FallbackScreen
                                data-testid="projects-load-failed"
                                title="Couldn't load your projects"
                                message={projectsLoadError}
                                actions={
                                  <Button variant="primary" onClick={() => void retryLoadProjects()}>
                                    Retry
                                  </Button>
                                }
                              />
                            )
                          : showOnboarding
                          ? <Onboarding onAddLocal={handleAddLocalProject} onClone={handleCloneRepository} />
                          : showTasksView
                          ? <TasksView onNewWorkspace={handleNewWorkspace} />
                          : composerShown
                          ? <PhoneNewAgentComposer closable />
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
                {/* No status bar in phone mode — the top bar and the
                    palette are the phone's chrome. */}
                {layoutMode === "desk" && (
                  <StatusBar
                    onNewWorkspace={handleNewWorkspace}
                    onOpenStats={handleOpenStats}
                  />
                )}
              </div>
            </PaneDragProvider>
            {/* The top-left and top-right controls. Not shown before the first
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
              onResumeAgent={resumeAgent}
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
              onResumeAgent={resumeAgent}
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
            {layoutMode === "desk" && <MoveToWorkspacePicker />}
            <RemoveFromHostDialog />
            <DeletePodDialogHost />
            <ProfileEditorDialog />
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
        agentRunning={agentInClosingPane}
        unsavedFiles={unsavedInClosingPane}
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
        agentRunning={agentInClosingTab}
        unsavedFiles={unsavedInClosingTab}
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
      <UnsavedEditsDialog />
      {/* No toasts in phone mode. */}
      {layoutMode !== "phone" && (
        <>
          <ToastContainer />
          <UnlockToast />
        </>
      )}
      {!OWN_CLAIM && showGhosts && <GhostsOverlay />}
    </div>
    </TooltipProvider>
  );
}

export default App;

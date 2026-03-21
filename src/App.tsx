import { useEffect, useState, useCallback } from "react";
import { TabBar } from "./components/TabBar";
import { PaneLayout } from "./components/PaneLayout";
import { Sidebar } from "./components/Sidebar";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsModal } from "./components/SettingsModal";
import { WorkspaceEmptyState } from "./components/WorkspaceEmptyState";
import { WelcomeEmptyState } from "./components/WelcomeEmptyState";
import { NewWorkspaceDialog } from "./components/NewWorkspaceDialog";
import { ToastContainer } from "./components/Toast";
import { useAppStore, selectActiveWorkspace } from "./store/app-store";
import { useProjectStore } from "./store/project-store";
import { useThemeStore } from "./store/theme-store";
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
  useEffect(() => {
    loadTheme();
  }, [loadTheme]);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
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

  const addSession = useAppStore((s) => s.addSession);
  const closeSession = useAppStore((s) => s.closeSession);
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
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.metaKey) return;

      if (e.key === "," && !e.shiftKey) {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      } else if (e.key === "k" && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "t" && !e.shiftKey) {
        e.preventDefault();
        addSession();
      } else if (e.key === "d" && !e.shiftKey) {
        e.preventDefault();
        splitPane("horizontal");
      } else if (e.key === "D" || (e.key === "d" && e.shiftKey)) {
        e.preventDefault();
        splitPane("vertical");
      } else if (e.key === "w" && !e.shiftKey) {
        e.preventDefault();
        closePane();
      } else if (e.key === "W" || (e.key === "w" && e.shiftKey)) {
        e.preventDefault();
        if (activeSession) closeSession(activeSession.id);
      } else if (e.key === "]" && e.shiftKey) {
        e.preventDefault();
        selectNextSession();
      } else if (e.key === "[" && e.shiftKey) {
        e.preventDefault();
        selectPrevSession();
      } else if (e.key === "]" && !e.shiftKey) {
        e.preventDefault();
        focusNextPane();
      } else if (e.key === "[" && !e.shiftKey) {
        e.preventDefault();
        focusPrevPane();
      } else if (e.key === "\\") {
        e.preventDefault();
        toggleSidebar();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    addSession,
    closeSession,
    closePane,
    selectNextSession,
    selectPrevSession,
    splitPane,
    focusNextPane,
    focusPrevPane,
    toggleSidebar,
    activeSession,
  ]);

  return (
    <div className="app">
      <div className="app-body">
        {sidebarVisible && <Sidebar />}
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
      />
      <SettingsModal open={settingsOpen} onClose={closeSettings} />
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

import { useEffect, useState, useCallback } from "react";
import { TabBar } from "./components/TabBar";
import { PaneLayout } from "./components/PaneLayout";
import { Sidebar } from "./components/Sidebar";
import { CommandPalette } from "./components/CommandPalette";
import { useAppStore, selectActiveWorkspace } from "./store/app-store";
import { useProjectStore } from "./store/project-store";
import { useThemeStore } from "./store/theme-store";
import "./App.css";

function App() {
  const loadTheme = useThemeStore((s) => s.loadTheme);
  useEffect(() => { loadTheme(); }, [loadTheme]);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

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
  const zoomIn = useAppStore((s) => s.zoomIn);
  const zoomOut = useAppStore((s) => s.zoomOut);
  const resetZoom = useAppStore((s) => s.resetZoom);
  const sidebarVisible = useProjectStore((s) => s.sidebarVisible);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);

  const activeSession = ws?.sessions.find((s) => s.id === selectedSessionId);

  // Keybindings
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.metaKey) return;

      if (e.key === "k" && !e.shiftKey) {
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
      } else if (e.key === "]" && !e.shiftKey && e.altKey) {
        e.preventDefault();
        focusNextPane();
      } else if (e.key === "\\") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === "=" && !e.shiftKey) {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" && !e.shiftKey) {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0" && !e.shiftKey) {
        e.preventDefault();
        resetZoom();
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
    toggleSidebar,
    zoomIn,
    zoomOut,
    resetZoom,
    activeSession,
  ]);

  return (
    <div className="app">
      <div className="app-body">
        {sidebarVisible && <Sidebar />}
        <div className="main-content">
          <TabBar />
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
                    style={{
                      display: isVisible ? "flex" : "none",
                      width: "100%",
                      height: "100%",
                      overflow: "hidden",
                    }}
                  >
                    <PaneLayout node={session.rootNode} workspacePath={wpath} />
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </div>
  );
}

export default App;

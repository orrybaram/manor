import { useEffect, useState, useCallback } from "react";
import { TabBar } from "./components/TabBar";
import { PaneLayout } from "./components/PaneLayout";
import { Sidebar } from "./components/Sidebar";
import { CommandPalette } from "./components/CommandPalette";
import { useAppStore } from "./store/app-store";
import { useProjectStore } from "./store/project-store";
import { useThemeStore } from "./store/theme-store";
import "./App.css";

function App() {
  const loadTheme = useThemeStore((s) => s.loadTheme);
  useEffect(() => { loadTheme(); }, [loadTheme]);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  const tabs = useAppStore((s) => s.tabs);
  const selectedTabId = useAppStore((s) => s.selectedTabId);
  const addTab = useAppStore((s) => s.addTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const selectNextTab = useAppStore((s) => s.selectNextTab);
  const selectPrevTab = useAppStore((s) => s.selectPrevTab);
  const splitPane = useAppStore((s) => s.splitPane);
  const closePane = useAppStore((s) => s.closePane);
  const focusNextPane = useAppStore((s) => s.focusNextPane);
  const sidebarVisible = useProjectStore((s) => s.sidebarVisible);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);

  const activeTab = tabs.find((t) => t.id === selectedTabId);

  // Keybindings
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.metaKey) return;

      if (e.key === "k" && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "t" && !e.shiftKey) {
        e.preventDefault();
        addTab();
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
        const tab = tabs.find((t) => t.id === selectedTabId);
        if (tab) closeTab(tab.id);
      } else if (e.key === "]" && e.shiftKey) {
        e.preventDefault();
        selectNextTab();
      } else if (e.key === "[" && e.shiftKey) {
        e.preventDefault();
        selectPrevTab();
      } else if (e.key === "]" && !e.shiftKey && e.altKey) {
        e.preventDefault();
        focusNextPane();
      } else if (e.key === "\\") {
        e.preventDefault();
        toggleSidebar();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    addTab,
    closeTab,
    closePane,
    selectNextTab,
    selectPrevTab,
    splitPane,
    focusNextPane,
    toggleSidebar,
    tabs,
    selectedTabId,
  ]);

  return (
    <div className="app">
      <TabBar />
      <div className="app-body">
        {sidebarVisible && <Sidebar />}
        <div className="terminal-container">
          {activeTab && <PaneLayout node={activeTab.rootNode} />}
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </div>
  );
}

export default App;

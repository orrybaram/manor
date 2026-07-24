import { useEffect, useState } from "react";
import { PaneDragProvider } from "./components/workspace-panes/PaneDragContext";
import { PanelLayout } from "./components/panels/PanelLayout";
import { TooltipProvider } from "./components/ui/Tooltip/Tooltip";
import { ToastContainer } from "./components/ui/Toast/Toast";
import { ManorLogo } from "./components/ui/ManorLogo";
import { useAppStore } from "./store/app-store";
import { useThemeStore } from "./store/theme-store";
import { useMountEffect } from "./hooks/useMountEffect";
import { allPaneIds } from "./store/pane-tree";
import "./App.css";

/**
 * Renderer entry point for a detached popup window (ADR-156).
 *
 * A detached window is just a window whose store contains exactly one panel with
 * one tab. Instead of the normal workspace load, it pulls its one-shot handoff
 * payload over `window.getDetachPayload()`, hydrates it into the store, and
 * reuses the ordinary `PanelLayout` render path — so terminals re-attach and
 * webviews re-mount by `paneId` exactly like the primary window.
 *
 * The primary-only chrome (project sidebar, workspace switcher, status bar,
 * command palette, modals) is intentionally omitted: a detached window only
 * hosts its single tab's tab-bar + panes.
 */
type BootState = "loading" | "ready" | "empty";

export default function DetachedApp() {
  const loadTheme = useThemeStore((s) => s.loadTheme);
  const hydrateDetachedTab = useAppStore((s) => s.hydrateDetachedTab);
  const addTab = useAppStore((s) => s.addTab);
  const [bootState, setBootState] = useState<BootState>("loading");

  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);

  useMountEffect(() => {
    loadTheme();
    let cancelled = false;
    window.electronAPI.window
      .getDetachPayload()
      .then((payload) => {
        if (cancelled) return;
        if (!payload) {
          // No payload — e.g. a reload after the one-shot handoff was already
          // consumed. There is nothing to render; show a neutral empty state.
          setBootState("empty");
          return;
        }
        hydrateDetachedTab(payload);
        setBootState("ready");
      })
      .catch((err) => {
        console.error("Failed to load detach payload", err);
        if (!cancelled) setBootState("empty");
      });
    return () => {
      cancelled = true;
    };
  });

  // Ephemeral lifecycle: a clean close of this window terminates the panes it
  // owns (this window took ownership of them at detach time). We kill the
  // backends directly here rather than via `closeTab`, whose kills run on a
  // grace timer that would never fire once the window is gone — so a clean close
  // never orphans a live daemon session. (Ticket 7 later adds an explicit
  // reattach that preserves the tab instead.)
  useEffect(() => {
    const handler = () => {
      const state = useAppStore.getState();
      const layout = state.workspaceLayouts[state.activeWorkspacePath ?? ""];
      if (!layout) return;
      for (const panel of Object.values(layout.panels)) {
        for (const tab of panel.tabs) {
          for (const pid of allPaneIds(tab.rootNode)) {
            const type = state.paneContentType[pid];
            if (type === "browser") {
              window.electronAPI.webview.unregister(pid);
            } else if (type !== "diff") {
              // Terminal (default): kill the daemon session outright.
              window.electronAPI.pty.close(pid);
            }
          }
        }
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  if (bootState === "loading") {
    return (
      <div className="app splash-screen">
        <div className="splash-logo">
          <ManorLogo />
        </div>
      </div>
    );
  }

  const hasLayout =
    bootState === "ready" &&
    activeWorkspacePath !== null &&
    workspaceLayouts[activeWorkspacePath] !== undefined;

  if (!hasLayout) {
    return (
      <div className="app splash-screen">
        <div className="drag-region" />
        <div className="splash-logo" style={{ opacity: 0.5 }}>
          <ManorLogo />
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="app">
        <div className="app-body">
          <PaneDragProvider>
            <div className="main-content">
              <PanelLayout
                key={activeWorkspacePath}
                node={workspaceLayouts[activeWorkspacePath].panelTree}
                workspacePath={activeWorkspacePath}
                onNewTask={() => addTab()}
              />
            </div>
          </PaneDragProvider>
        </div>
        <ToastContainer />
      </div>
    </TooltipProvider>
  );
}

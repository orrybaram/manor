import { useEffect, useState } from "react";
import { PaneDragProvider } from "./components/workspace-panes/PaneDragContext";
import { PanelLayout } from "./components/panels/PanelLayout";
import { TooltipProvider } from "./components/ui/Tooltip/Tooltip";
import { ToastContainer } from "./components/ui/Toast/Toast";
import { ManorLogo } from "./components/ui/ManorLogo";
import { CloseAgentPaneDialog } from "./components/CloseAgentPaneDialog";
import { useAppStore } from "./store/app-store";
import { useProjectStore } from "./store/project-store";
import { useThemeStore } from "./store/theme-store";
import {
  createSharedKeybindingHandlers,
  dispatchKeybinding,
  startNewTask,
} from "./lib/keybinding-commands";
import { countTabsInWindow } from "./lib/window-handoff";
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
  const applyProjectTheme = useThemeStore((s) => s.applyProjectTheme);
  const hydrateDetachedTab = useAppStore((s) => s.hydrateDetachedTab);
  const [bootState, setBootState] = useState<BootState>("loading");

  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);

  const pendingCloseConfirmPaneId = useAppStore(
    (s) => s.pendingCloseConfirmPaneId,
  );
  const setPendingCloseConfirmPaneId = useAppStore(
    (s) => s.setPendingCloseConfirmPaneId,
  );
  const pendingCloseConfirmTabId = useAppStore(
    (s) => s.pendingCloseConfirmTabId,
  );
  const setPendingCloseConfirmTabId = useAppStore(
    (s) => s.setPendingCloseConfirmTabId,
  );

  // A detached window is disposable: once its last tab is gone there is nothing
  // to show, so close the OS window. A store subscription (below) is the single
  // source of truth — it fires no matter HOW the last tab was closed (the tab's
  // × button, Cmd+W, closing its last pane, reattaching it, …).
  useEffect(() => {
    let sawTabs = false;
    let closing = false;
    const maybeClose = () => {
      const total = countTabsInWindow();
      if (total > 0) {
        sawTabs = true;
      } else if (sawTabs && !closing) {
        // Was populated, now empty — nothing left to render.
        closing = true;
        window.electronAPI.window.closeSelf();
      }
    };
    maybeClose();
    return useAppStore.subscribe(maybeClose);
  }, []);

  useMountEffect(() => {
    loadTheme();
    // A detached window has no sidebar. Marking it hidden makes the tab bar
    // apply its `.noSidebar` inset (padding-left: 78px) so the tabs clear the
    // macOS traffic lights instead of hiding beneath them. This store is
    // per-renderer and not persisted, so it never affects the primary window.
    useProjectStore.setState({ sidebarVisible: false });
    // The popout renders no sidebar, but it still needs the project list: the
    // new-agent command reads the workspace's `agentCommand` from it, and
    // copy-branch reads the workspace's branch.
    void useProjectStore.getState().loadProjects();
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
        // Paint in the source workspace's theme, not the global default.
        void applyProjectTheme(payload.themeName);
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

  // Keyboard shortcuts. A detached window runs `DetachedApp`, which does not
  // mount the primary window's global key handler — so without this, Cmd+W and
  // the other tab/pane shortcuts would be dead here. It gets the same
  // window-agnostic command map as the primary window (new tab, new agent, new
  // browser, pane/panel/browser commands); the primary-only commands (command
  // palette, settings, sidebar, new workspace, navigation history) are absent
  // by design and simply fall through. Closing the window when it empties is
  // handled by the store subscription above, no matter which command emptied it.
  useMountEffect(() => {
    // Popouts never consume the prewarmed session: its cwd tracks the PRIMARY
    // window's active workspace, so a popout on a different workspace would
    // inherit the wrong directory.
    const handlers = createSharedKeybindingHandlers({ prewarmNewTask: false });

    function handleKeyDown(e: KeyboardEvent) {
      dispatchKeybinding(e, handlers);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  // A tab dragged out of another window and dropped onto this one. If this
  // window already holds a layout the tab is appended to it; if it is still
  // empty (payload consumed by an earlier reload) the dropped tab becomes its
  // layout, which is exactly what the boot-time hydration does.
  useEffect(
    () =>
      window.electronAPI.window.onTabReceived((payload) => {
        const state = useAppStore.getState();
        const hasLayout =
          state.activeWorkspacePath !== null &&
          state.workspaceLayouts[state.activeWorkspacePath] !== undefined;
        if (hasLayout) state.receiveReattachedTab(payload);
        else hydrateDetachedTab(payload);
        // Match the incoming tab's workspace theme.
        void applyProjectTheme(payload.themeName);
        setBootState("ready");
      }),
    [hydrateDetachedTab, applyProjectTheme],
  );

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

  const hasLayout =
    bootState === "ready" &&
    activeWorkspacePath !== null &&
    workspaceLayouts[activeWorkspacePath] !== undefined;

  // Loading (payload in flight) and empty (no payload) both render a splash.
  // A full-width `.drag-region` strip at the top keeps the window movable even
  // before any tab bar exists — otherwise a centering flex collapses the strip
  // to zero width and the window can't be dragged.
  if (bootState === "loading" || !hasLayout) {
    return (
      <div className="app">
        <div className="drag-region" />
        <div className="splash-screen" style={{ flex: 1 }}>
          <div
            className="splash-logo"
            style={{ opacity: bootState === "loading" ? 1 : 0.5 }}
          >
            <ManorLogo />
          </div>
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
                onNewTask={() => void startNewTask()}
              />
            </div>
          </PaneDragProvider>
        </div>
        <CloseAgentPaneDialog
          open={pendingCloseConfirmPaneId !== null}
          onOpenChange={(open) => {
            if (!open) setPendingCloseConfirmPaneId(null);
          }}
          onConfirm={() => {
            if (pendingCloseConfirmPaneId !== null) {
              useAppStore.getState().closePaneById(pendingCloseConfirmPaneId);
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
              useAppStore.getState().closeTab(pendingCloseConfirmTabId);
              setPendingCloseConfirmTabId(null);
            }
          }}
        />
        <ToastContainer />
      </div>
    </TooltipProvider>
  );
}

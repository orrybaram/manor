import { useAppStore } from "../store/app-store";
import { useAgentStore } from "../store/agent-store";

export function useTabTitle(tabId: string): string {
  const focusedPaneId = useAppStore((s) => {
    const wsPath = s.activeWorkspacePath;
    if (!wsPath) return null;
    const layout = s.workspaceLayouts[wsPath];
    if (!layout) return null;
    for (const panel of Object.values(layout.panels)) {
      const tab = panel.tabs.find((t) => t.id === tabId);
      if (tab) return tab.focusedPaneId;
    }
    return null;
  });

  const title = useAppStore((s) =>
    focusedPaneId ? (s.paneTitle[focusedPaneId] ?? null) : null,
  );
  const cwd = useAppStore((s) =>
    focusedPaneId ? (s.paneCwd[focusedPaneId] ?? null) : null,
  );
  const contentType = useAppStore((s) =>
    focusedPaneId ? (s.paneContentType[focusedPaneId] ?? null) : null,
  );
  const paneUrl = useAppStore((s) =>
    focusedPaneId ? (s.paneUrl[focusedPaneId] ?? null) : null,
  );
  // A user-pinned agent name (rename in the Agents list) labels the tab too,
  // so the sidebar and tab bar never disagree about what a pane is called.
  const pinnedAgentName = useAgentStore((s) => {
    if (!focusedPaneId) return null;
    const agent = s.agents.find(
      (a) => a.paneId === focusedPaneId && a.namePinned && a.name,
    );
    return agent?.name ?? null;
  });

  if (contentType === "diff") {
    return "Diff";
  }

  if (pinnedAgentName && contentType !== "browser") {
    return pinnedAgentName;
  }

  // For browser panes, prefer the page title; fall back to URL
  if (contentType === "browser") {
    if (title) return title;
    if (paneUrl) return paneUrl.replace(/^https?:\/\//, "");
  }

  if (title) {
    const cwdMatch = title.match(/^.+@.+:(.+)$/);
    if (cwdMatch) {
      const path = cwdMatch[1];
      const parts = path.replace(/\/+$/, "").split("/");
      return parts[parts.length - 1] || title;
    }
    return title;
  }

  // Fall back to CWD of the focused pane
  if (cwd) {
    const parts = cwd.split("/");
    return parts[parts.length - 1] || parts[parts.length - 2] || cwd;
  }

  return "Terminal";
}

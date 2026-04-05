import { useAppStore } from "../store/app-store";

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

  if (contentType === "diff") {
    return "Diff";
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

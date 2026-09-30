import { useAppStore } from "../store/app-store";
import { useAgentStore } from "../store/agent-store";
import { shellTitlePath } from "../utils/agent-title";

/**
 * The title a tab shows for its focused pane. Reads the pane's raw live title,
 * so it changes on every spinner frame: call it only from the component that
 * renders the title text.
 */
export function useTabTitle(focusedPaneId: string | undefined): string {
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
    const path = shellTitlePath(title);
    if (path !== null) {
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

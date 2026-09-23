import type { AgentInfo } from "../electron.d";
import {
  selectPaneContentType,
  selectPaneUrl,
  type AppState,
} from "../store/app-store";

/** The store fields a pane's title is derived from. */
export type PaneTitleState = Pick<
  AppState,
  "paneTitle" | "paneCwd" | "paneLiveUrl" | "workspaceLayouts"
>;

/** The agent fields a pane's title reads: a user-pinned name labels it. */
export type PaneTitleAgent = Pick<AgentInfo, "paneId" | "name" | "namePinned">;

/**
 * A pane's displayed title — the one the tab bar, the tab drag chip and the
 * phone's pane switcher all show, so none of them disagree about what a pane
 * is called.
 *
 * - A diff pane is "Diff".
 * - A user-pinned agent name (rename in the Agents list) wins for anything
 *   but a browser pane.
 * - A browser pane shows its page title, else its URL without the scheme.
 * - A shell's "user@host:path" title shortens to the path's last segment.
 * - Otherwise the last segment of the pane's cwd, else "Terminal".
 */
export function paneTitle(
  paneId: string,
  state: PaneTitleState,
  agents: readonly PaneTitleAgent[],
): string {
  const contentType = selectPaneContentType(state, paneId);
  if (contentType === "diff") return "Diff";

  const title = state.paneTitle[paneId] ?? null;

  if (contentType === "browser") {
    if (title) return title;
    const url = selectPaneUrl(state, paneId);
    if (url) return url.replace(/^https?:\/\//, "");
  } else {
    const pinned = agents.find(
      (a) => a.paneId === paneId && a.namePinned && a.name,
    );
    if (pinned?.name) return pinned.name;
  }

  if (title) {
    const cwdMatch = title.match(/^.+@.+:(.+)$/);
    if (cwdMatch) {
      const parts = cwdMatch[1].replace(/\/+$/, "").split("/");
      return parts[parts.length - 1] || title;
    }
    return title;
  }

  const cwd = state.paneCwd[paneId] ?? null;
  if (cwd) {
    const parts = cwd.split("/");
    return parts[parts.length - 1] || parts[parts.length - 2] || cwd;
  }

  return "Terminal";
}

import { shellTitlePath, stripTitleMarkers } from "../utils/agent-title";
import type { AppState } from "../store/app-store";
import type { AgentInfo } from "../electron.d";

/** The pane side-maps a displayed title reads. */
type PaneTitleState = Pick<
  AppState,
  "paneTitle" | "paneCwd" | "paneContentType" | "paneUrl"
>;

/**
 * A terminal's live title with its spinner frames and done markers stripped,
 * so successive frames of one title compare equal in a selector. Empty when
 * nothing is left.
 */
function terminalTitle(raw: string | undefined): string {
  return raw ? stripTitleMarkers(raw) : "";
}

/** The last segment of a cwd ("/repo/app/" gives "app"). */
function cwdName(cwd: string): string {
  const parts = cwd.split("/");
  return parts[parts.length - 1] || parts[parts.length - 2] || cwd;
}

/**
 * The title a pane's header shows: its live terminal title, cleaned, minus the
 * "user@host:" prefix of default shell titles, else the last segment of its
 * cwd, else "Terminal".
 */
export function paneHeaderTitle(state: PaneTitleState, paneId: string): string {
  const title = terminalTitle(state.paneTitle[paneId]);
  if (title) return shellTitlePath(title) ?? title;
  const cwd = state.paneCwd[paneId];
  return cwd ? cwdName(cwd) : "Terminal";
}

/** The name the user pinned on the agent in `paneId` (a rename), if any. */
export function pinnedAgentName(
  agents: readonly AgentInfo[],
  paneId: string,
): string | null {
  const agent = agents.find((a) => a.paneId === paneId && a.namePinned && a.name);
  return agent?.name ?? null;
}

/**
 * The title a tab shows for its focused pane: "Diff" for a diff, the pinned
 * agent name, a browser page's title or URL, the cleaned terminal title (just
 * the last path segment of a default shell title), else the cwd's last segment.
 */
export function tabTitle(
  state: PaneTitleState,
  paneId: string,
  pinnedName: string | null,
): string {
  const contentType = state.paneContentType[paneId];
  if (contentType === "diff") return "Diff";
  // A user-pinned agent name (rename in the Agents list) labels the tab too,
  // so the sidebar and tab bar never disagree about what a pane is called.
  if (pinnedName && contentType !== "browser") return pinnedName;

  if (contentType === "browser") {
    const title = state.paneTitle[paneId];
    if (title) return title;
    const url = state.paneUrl[paneId];
    if (url) return url.replace(/^https?:\/\//, "");
  }

  const title = terminalTitle(state.paneTitle[paneId]);
  if (title) {
    const path = shellTitlePath(title);
    return path !== null ? cwdName(path.replace(/\/+$/, "")) || title : title;
  }
  const cwd = state.paneCwd[paneId];
  return cwd ? cwdName(cwd) : "Terminal";
}

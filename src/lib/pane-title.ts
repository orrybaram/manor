import { shellTitlePath } from "../utils/agent-title";

/**
 * The title a pane's header shows: its live terminal title as-is (spinner
 * frames included) minus the "user@host:" prefix of default shell titles,
 * else the last segment of its cwd, else "Terminal".
 */
export function paneHeaderTitle(
  raw: string | undefined,
  cwd: string | undefined,
): string {
  if (raw) return shellTitlePath(raw) ?? raw;
  return (cwd ? cwd.split("/").pop() : "") || "Terminal";
}

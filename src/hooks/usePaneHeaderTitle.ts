import { useAppStore } from "../store/app-store";
import { stripTitleMarkers } from "../utils/agent-title";

/**
 * A pane's live title as its header shows it: spinner frames and done markers
 * stripped, and the "user@host:" prefix of default shell titles dropped.
 * Empty when the pane has no title.
 */
function paneHeaderTitle(raw: string | undefined): string {
  if (!raw) return "";
  return stripTitleMarkers(raw).replace(/^.+@.+:/, "");
}

/**
 * `paneHeaderTitle` of the pane's live title. Cleaned in the selector, so a
 * new spinner frame of the same title does not re-render the pane.
 */
export function usePaneHeaderTitle(paneId: string): string {
  return useAppStore((s) => paneHeaderTitle(s.paneTitle[paneId]));
}

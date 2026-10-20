import { useAppStore } from "../store/app-store";
import { useAgentStore } from "../store/agent-store";
import { pinnedAgentName, tabTitle } from "../lib/pane-title";

/**
 * The title a tab shows for its focused pane (`tabTitle`). Cleaned in the
 * selector, so a new spinner frame of the same title does not re-render the
 * caller.
 */
export function useTabTitle(focusedPaneId: string | undefined): string {
  const pinnedName = useAgentStore((s) =>
    focusedPaneId ? pinnedAgentName(s.agents, focusedPaneId) : null,
  );
  return useAppStore((s) =>
    focusedPaneId ? tabTitle(s, focusedPaneId, pinnedName) : "Terminal",
  );
}

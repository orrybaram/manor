import { useAppStore, useFocusedPane } from "../store/app-store";
import { useAgentStore } from "../store/agent-store";
import { paneTitle } from "../lib/pane-title";

/** A tab's displayed title: its focused pane's `paneTitle`. */
export function useTabTitle(tabId: string): string {
  const focusedPaneId = useFocusedPane(tabId);
  const agents = useAgentStore((s) => s.agents);

  return useAppStore((s) =>
    focusedPaneId ? paneTitle(focusedPaneId, s, agents) : "Terminal",
  );
}

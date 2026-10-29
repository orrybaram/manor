import { useMemo } from "react";
import { useAppStore } from "../store/app-store";
import { allPaneIds } from "../lib/layout/pane-tree";

/**
 * Every pane open in any workspace layout right now. An agent whose pane is
 * in here is on screen somewhere in Manor, whatever its persisted lifecycle
 * says.
 */
export function useOpenPaneIds(enabled = true): ReadonlySet<string> {
  const workspaceLayouts = useAppStore((s) => (enabled ? s.workspaceLayouts : undefined));
  return useMemo(() => {
    const ids = new Set<string>();
    for (const layout of Object.values(workspaceLayouts ?? {})) {
      for (const panel of Object.values(layout.panels)) {
        for (const tab of panel.tabs) {
          for (const id of allPaneIds(tab.rootNode)) ids.add(id);
        }
      }
    }
    return ids;
  }, [workspaceLayouts]);
}

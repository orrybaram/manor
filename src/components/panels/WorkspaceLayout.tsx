import { memo } from "react";
import { useAppStore } from "../../store/app-store";
import type { WorkspaceKey } from "../../lib/workspace-key";
import { TAB_HIDDEN_STYLE, TAB_VISIBLE_STYLE } from "../../lib/tab-styles";
import { PanelLayout } from "./PanelLayout";

type WorkspaceLayoutProps = {
  workspaceKey: WorkspaceKey;
  visible: boolean;
  onNewAgent: () => void;
};

/**
 * One workspace's panel tree. It selects its own tree so a layout change in
 * one workspace re-renders only that workspace, not every mounted one.
 */
export const WorkspaceLayout = memo(function WorkspaceLayout(
  props: WorkspaceLayoutProps,
) {
  const { workspaceKey, visible, onNewAgent } = props;

  const panelTree = useAppStore(
    (s) => s.workspaceLayouts[workspaceKey]?.panelTree,
  );
  if (!panelTree) return null;
  return (
    <div style={visible ? TAB_VISIBLE_STYLE : TAB_HIDDEN_STYLE}>
      <PanelLayout
        node={panelTree}
        workspaceKey={workspaceKey}
        onNewAgent={onNewAgent}
      />
    </div>
  );
});

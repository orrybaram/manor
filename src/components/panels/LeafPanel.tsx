import { memo } from "react";
import { useAppStore } from "../../store/app-store";
import type { WorkspaceKey } from "../../lib/workspace-key";
import { TabBar } from "../tabbar/TabBar/TabBar";
import { PaneLayout } from "../workspace-panes/PaneLayout/PaneLayout";
import { TAB_VISIBLE_STYLE, TAB_HIDDEN_STYLE } from "../../lib/tab-styles";
import styles from "./PanelLayout.module.css";

type LeafPanelProps = {
  panelId: string;
  workspaceKey: WorkspaceKey;
  onNewAgent: () => void;
};

export const LeafPanel = memo(function LeafPanel(props: LeafPanelProps) {
  const { panelId, workspaceKey, onNewAgent } = props;
  const panel = useAppStore((s) => s.workspaceLayouts[workspaceKey]?.panels[panelId]);
  const isActivePanel = useAppStore(
    (s) => s.workspaceLayouts[workspaceKey]?.activePanelId === panelId,
  );
  const focusPanel = useAppStore((s) => s.focusPanel);

  if (!panel) return null;

  return (
    <div
      className={`${styles.panel} ${isActivePanel ? styles.panelActive : ""}`}
      onClick={() => focusPanel(panelId)}
    >
      <TabBar panelId={panelId} workspaceKey={workspaceKey} onNewAgent={onNewAgent} />
      <div className={`terminal-container ${styles.panelBody}`} data-focus-region="pane">
        {panel.tabs.map((tab) => (
          <div
            key={tab.id}
            style={tab.id === panel.selectedTabId ? TAB_VISIBLE_STYLE : TAB_HIDDEN_STYLE}
          >
            <PaneLayout node={tab.rootNode} workspaceKey={workspaceKey} />
          </div>
        ))}
      </div>
    </div>
  );
});

import { memo } from "react";
import {
  useAppStore,
  useActivePanel,
  useSelectedTab,
  useVisibleTabs,
} from "../../store/app-store";
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
  const isActivePanel = useActivePanel(workspaceKey) === panelId;
  const selectedTabId = useSelectedTab(panelId, workspaceKey);
  const focusPanel = useAppStore((s) => s.focusPanel);
  // A tab another window has popped out is not rendered here at all (D4):
  // mounting its panes would give the same session two desktop viewers and
  // put an invisible tab's terminal on this window's winsize.
  const tabs = useVisibleTabs(workspaceKey, panel);

  if (!panel) return null;

  return (
    <div
      className={`${styles.panel} ${isActivePanel ? styles.panelActive : ""}`}
      onClick={() => focusPanel(panelId)}
    >
      <TabBar panelId={panelId} workspaceKey={workspaceKey} onNewAgent={onNewAgent} />
      <div className={`terminal-container ${styles.panelBody}`} data-focus-region="pane">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            style={tab.id === selectedTabId ? TAB_VISIBLE_STYLE : TAB_HIDDEN_STYLE}
          >
            <PaneLayout node={tab.rootNode} workspaceKey={workspaceKey} />
          </div>
        ))}
      </div>
    </div>
  );
});

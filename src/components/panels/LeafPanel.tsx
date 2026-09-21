import {
  useAppStore,
  useActivePanel,
  useSelectedTab,
  useVisibleTabs,
} from "../../store/app-store";
import { TabBar } from "../tabbar/TabBar/TabBar";
import { PaneLayout } from "../workspace-panes/PaneLayout/PaneLayout";
import { TAB_VISIBLE_STYLE, TAB_HIDDEN_STYLE } from "../../lib/tab-styles";
import styles from "./PanelLayout.module.css";

interface LeafPanelProps {
  panelId: string;
  workspacePath: string;
  onNewAgent: () => void;
}

export function LeafPanel({ panelId, workspacePath, onNewAgent }: LeafPanelProps) {
  const panel = useAppStore((s) => s.workspaceLayouts[workspacePath]?.panels[panelId]);
  const isActivePanel = useActivePanel(workspacePath) === panelId;
  const selectedTabId = useSelectedTab(panelId, workspacePath);
  const focusPanel = useAppStore((s) => s.focusPanel);
  // A tab another window has popped out is not rendered here at all (D4):
  // mounting its panes would give the same session two desktop viewers and
  // put an invisible tab's terminal on this window's winsize.
  const tabs = useVisibleTabs(workspacePath, panel);

  if (!panel) return null;

  return (
    <div
      className={`${styles.panel} ${isActivePanel ? styles.panelActive : ""}`}
      onClick={() => focusPanel(panelId)}
    >
      <TabBar panelId={panelId} workspacePath={workspacePath} onNewAgent={onNewAgent} />
      <div className="terminal-container" data-focus-region="pane">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            style={tab.id === selectedTabId ? TAB_VISIBLE_STYLE : TAB_HIDDEN_STYLE}
          >
            <PaneLayout node={tab.rootNode} workspacePath={workspacePath} />
          </div>
        ))}
      </div>
    </div>
  );
}

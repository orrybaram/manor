import { useAppStore } from "../../store/app-store";
import { TabBar } from "../tabbar/TabBar/TabBar";
import { PaneLayout } from "../workspace-panes/PaneLayout/PaneLayout";
import { TAB_VISIBLE_STYLE, TAB_HIDDEN_STYLE } from "../../lib/tab-styles";
import styles from "./PanelLayout.module.css";

interface LeafPanelProps {
  panelId: string;
  workspacePath: string;
  onNewTask: () => void;
}

export function LeafPanel({ panelId, workspacePath, onNewTask }: LeafPanelProps) {
  const panel = useAppStore((s) => s.workspaceLayouts[workspacePath]?.panels[panelId]);
  const isActivePanel = useAppStore(
    (s) => s.workspaceLayouts[workspacePath]?.activePanelId === panelId,
  );
  const focusPanel = useAppStore((s) => s.focusPanel);

  if (!panel) return null;

  return (
    <div
      className={`${styles.panel} ${isActivePanel ? styles.panelActive : ""}`}
      onClick={() => focusPanel(panelId)}
    >
      <TabBar panelId={panelId} workspacePath={workspacePath} onNewTask={onNewTask} />
      <div className="terminal-container">
        {panel.tabs.map((tab) => (
          <div
            key={tab.id}
            style={tab.id === panel.selectedTabId ? TAB_VISIBLE_STYLE : TAB_HIDDEN_STYLE}
          >
            <PaneLayout node={tab.rootNode} workspacePath={workspacePath} />
          </div>
        ))}
      </div>
    </div>
  );
}

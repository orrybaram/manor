import type { PanelNode } from "../../store/panel-tree";
import { LeafPanel } from "./LeafPanel";
import { SplitPanelLayout } from "./SplitPanelLayout";

interface PanelLayoutProps {
  node: PanelNode;
  workspacePath: string;
  onNewTask: () => void;
}

export function PanelLayout({ node, workspacePath, onNewTask }: PanelLayoutProps) {
  if (node.type === "leaf") {
    return <LeafPanel panelId={node.panelId} workspacePath={workspacePath} onNewTask={onNewTask} />;
  }
  return (
    <SplitPanelLayout
      direction={node.direction}
      ratio={node.ratio}
      first={node.first}
      second={node.second}
      workspacePath={workspacePath}
      onNewTask={onNewTask}
    />
  );
}

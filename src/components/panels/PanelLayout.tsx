import type { PanelNode } from "../../store/panel-tree";
import { LeafPanel } from "./LeafPanel";
import { SplitPanelLayout } from "./SplitPanelLayout";

interface PanelLayoutProps {
  node: PanelNode;
  workspacePath: string;
  onNewAgent: () => void;
}

export function PanelLayout({ node, workspacePath, onNewAgent }: PanelLayoutProps) {
  if (node.type === "leaf") {
    return <LeafPanel panelId={node.panelId} workspacePath={workspacePath} onNewAgent={onNewAgent} />;
  }
  return (
    <SplitPanelLayout
      direction={node.direction}
      ratio={node.ratio}
      first={node.first}
      second={node.second}
      workspacePath={workspacePath}
      onNewAgent={onNewAgent}
    />
  );
}

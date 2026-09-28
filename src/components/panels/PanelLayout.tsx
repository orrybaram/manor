import type { PanelNode } from "../../store/panel-tree";
import { LeafPanel } from "./LeafPanel";
import { SplitPanelLayout } from "./SplitPanelLayout";

interface PanelLayoutProps {
  node: PanelNode;
  workspaceKey: string;
  onNewAgent: () => void;
}

export function PanelLayout({ node, workspaceKey, onNewAgent }: PanelLayoutProps) {
  if (node.type === "leaf") {
    return <LeafPanel panelId={node.panelId} workspaceKey={workspaceKey} onNewAgent={onNewAgent} />;
  }
  return (
    <SplitPanelLayout
      direction={node.direction}
      ratio={node.ratio}
      first={node.first}
      second={node.second}
      workspaceKey={workspaceKey}
      onNewAgent={onNewAgent}
    />
  );
}

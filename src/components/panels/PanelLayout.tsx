import type { PanelNode } from "../../store/panel-tree";
import type { WorkspaceKey } from "../../lib/workspace-key";
import { LeafPanel } from "./LeafPanel";
import { SplitPanelLayout } from "./SplitPanelLayout";

type PanelLayoutProps = {
  node: PanelNode;
  workspaceKey: WorkspaceKey;
  onNewAgent: () => void;
};

export function PanelLayout(props: PanelLayoutProps) {
  const { node, workspaceKey, onNewAgent } = props;
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

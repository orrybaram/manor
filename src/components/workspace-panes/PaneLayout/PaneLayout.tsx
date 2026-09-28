import type { PaneNode } from "../../../store/pane-tree";
import { LeafPane } from "../LeafPane";
import { SplitLayout } from "../SplitLayout";

interface PaneLayoutProps {
  node: PaneNode;
  workspaceKey?: string;
}

export function PaneLayout(props: PaneLayoutProps) {
  const { node, workspaceKey } = props;

  if (node.type === "leaf") {
    return (
      <LeafPane
        key={node.paneId}
        paneId={node.paneId}
        workspaceKey={workspaceKey}
      />
    );
  }

  return (
    <SplitLayout
      direction={node.direction}
      ratio={node.ratio}
      first={node.first}
      second={node.second}
      workspaceKey={workspaceKey}
    />
  );
}

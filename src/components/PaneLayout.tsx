import type { PaneNode } from "../store/pane-tree";
import { LeafPane } from "./LeafPane";
import { SplitLayout } from "./SplitLayout";

interface PaneLayoutProps {
  node: PaneNode;
  workspacePath?: string;
}

export function PaneLayout({ node, workspacePath }: PaneLayoutProps) {
  if (node.type === "leaf") {
    return <LeafPane key={node.paneId} paneId={node.paneId} workspacePath={workspacePath} />;
  }

  return (
    <SplitLayout
      direction={node.direction}
      ratio={node.ratio}
      first={node.first}
      second={node.second}
      workspacePath={workspacePath}
    />
  );
}

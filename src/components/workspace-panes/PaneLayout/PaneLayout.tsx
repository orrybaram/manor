import type { PaneNode } from "../../../lib/layout/pane-tree";
import { LeafPane } from "../LeafPane";
import { SplitLayout } from "../SplitLayout";

interface PaneLayoutProps {
  node: PaneNode;
  /** The tab whose pane tree this is. */
  tabId: string;
  workspacePath?: string;
}

export function PaneLayout(props: PaneLayoutProps) {
  const { node, tabId, workspacePath } = props;

  if (node.type === "leaf") {
    return (
      <LeafPane
        key={node.paneId}
        paneId={node.paneId}
        workspacePath={workspacePath}
      />
    );
  }

  return (
    <SplitLayout
      direction={node.direction}
      ratio={node.ratio}
      first={node.first}
      second={node.second}
      tabId={tabId}
      workspacePath={workspacePath}
    />
  );
}

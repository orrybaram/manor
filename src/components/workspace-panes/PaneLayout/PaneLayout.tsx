import { memo } from "react";
import type { PaneNode } from "../../../lib/layout/pane-tree";
import type { WorkspaceKey } from "../../../lib/workspace-key";
import { LeafPane } from "../LeafPane";
import { SplitLayout } from "../SplitLayout";

type PaneLayoutProps = {
  node: PaneNode;
  /** The tab whose pane tree this is. */
  tabId: string;
  workspaceKey?: WorkspaceKey;
};

export const PaneLayout = memo(function PaneLayout(props: PaneLayoutProps) {
  const { node, tabId, workspaceKey } = props;

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
      tabId={tabId}
      workspaceKey={workspaceKey}
    />
  );
});

import { memo } from "react";
import type { PaneNode } from "../../../store/pane-tree";
import type { WorkspaceKey } from "../../../lib/workspace-key";
import { LeafPane } from "../LeafPane";
import { SplitLayout } from "../SplitLayout";

type PaneLayoutProps = {
  node: PaneNode;
  workspaceKey?: WorkspaceKey;
};

export const PaneLayout = memo(function PaneLayout(props: PaneLayoutProps) {
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
});

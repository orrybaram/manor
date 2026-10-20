import { memo } from "react";
import type { PaneNode } from "../../../lib/layout/pane-tree";
import type { WorkspaceKey } from "../../../lib/workspace-key";
import { LeafPane } from "../LeafPane";
import { PaneErrorBoundary } from "../PaneErrorBoundary";
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
      <PaneErrorBoundary key={node.paneId} paneId={node.paneId}>
        <LeafPane paneId={node.paneId} workspaceKey={workspaceKey} />
      </PaneErrorBoundary>
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

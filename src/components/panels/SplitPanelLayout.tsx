import { useCallback } from "react";
import type { PanelNode } from "../../lib/layout/panel-tree";
import { panelTreeContains } from "../../lib/layout/panel-tree";
import type { SplitDirection } from "../../lib/layout/pane-tree";
import { useLayoutMode } from "../../hooks/useLayoutMode";
import { activePanelIdOf, useAppStore } from "../../store/app-store";
import { SplitFrame } from "../workspace-panes/SplitFrame";
import { PanelLayout } from "./PanelLayout";

/** Walk to the first (leftmost/topmost) leaf in a PanelNode tree. */
function firstLeafPanelId(node: PanelNode): string {
  if (node.type === "leaf") return node.panelId;
  return firstLeafPanelId(node.first);
}

type SplitPanelLayoutProps = {
  direction: SplitDirection;
  ratio: number;
  first: PanelNode;
  second: PanelNode;
  workspacePath: string;
  onNewAgent: () => void;
};

export function SplitPanelLayout(props: SplitPanelLayoutProps) {
  const { direction, ratio, first, second, workspacePath, onNewAgent } = props;

  const isPhone = useLayoutMode() === "phone";

  // ADR-181 D1: in phone mode only the child containing this workspace's
  // active panel is shown. A boolean, and only computed in phone mode, so the
  // desk layout never re-renders on a focus change it did not before.
  const focusInSecond = useAppStore(
    (s) => isPhone && panelTreeContains(second, activePanelIdOf(s, workspacePath)),
  );

  const handleCommitRatio = useCallback(
    (newRatio: number) => {
      useAppStore.getState().updatePanelSplitRatio(firstLeafPanelId(first), newRatio);
    },
    [first],
  );

  return (
    <SplitFrame
      direction={direction}
      ratio={ratio}
      focusInSecond={focusInSecond}
      onCommitRatio={handleCommitRatio}
      first={<PanelLayout node={first} workspacePath={workspacePath} onNewAgent={onNewAgent} />}
      second={<PanelLayout node={second} workspacePath={workspacePath} onNewAgent={onNewAgent} />}
    />
  );
}

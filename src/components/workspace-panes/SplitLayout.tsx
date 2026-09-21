import type { PaneNode } from "../../lib/layout/pane-tree";
import { paneTreeContains } from "../../lib/layout/pane-tree";
import { useLayoutMode } from "../../hooks/useLayoutMode";
import { useAppStore } from "../../store/app-store";
import { PaneLayout } from "./PaneLayout/PaneLayout";
import { SplitFrame } from "./SplitFrame";

type SplitLayoutProps = {
  direction: "horizontal" | "vertical";
  ratio: number;
  first: PaneNode;
  second: PaneNode;
  /** The tab this split belongs to, whose focused pane a phone shows. */
  tabId: string;
  workspacePath?: string;
};

export function SplitLayout(props: SplitLayoutProps) {
  const { direction, ratio, first, second, tabId, workspacePath } = props;

  const isPhone = useLayoutMode() === "phone";

  // ADR-181 D1: in phone mode only the child containing the tab's focused
  // pane is shown. A boolean, and only computed in phone mode, so the desk
  // layout never re-renders on a focus change it did not before. A tab with
  // no focus recorded falls back to its first pane, which is never in
  // `second`, so an unset entry reads the same as that fallback.
  const focusInSecond = useAppStore((s) => {
    if (!isPhone) return false;
    const path = workspacePath ?? s.activeWorkspacePath;
    if (!path) return false;
    return paneTreeContains(second, s.viewports[path]?.focusedPaneIds[tabId]);
  });

  return (
    <SplitFrame
      direction={direction}
      ratio={ratio}
      focusInSecond={focusInSecond}
      first={<PaneLayout node={first} tabId={tabId} workspacePath={workspacePath} />}
      second={<PaneLayout node={second} tabId={tabId} workspacePath={workspacePath} />}
    />
  );
}

import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../store/app-store";
import type { WorkspaceKey } from "../../lib/workspace-key";
import { TAB_HIDDEN_STYLE, TAB_VISIBLE_STYLE } from "../../lib/tab-styles";
import { PanelLayout } from "./PanelLayout";

type WorkspaceStackProps = {
  /** The workspace to show, or null to hide them all. */
  visibleKey: WorkspaceKey | null;
  onNewAgent: () => void;
};

/**
 * Every workspace this window has opened, its panel tree one hidden layer
 * each — only an opened one renders at all, because mounting a pane creates
 * its PTY (ADR-182 D9: the layout map holds every workspace the server has
 * told this window about, `mountedWorkspaces` which of them it renders).
 * Selects only the keys:
 * each layer selects its own tree, so a layout change in one workspace
 * re-renders only that workspace, not every mounted one.
 */
export const WorkspaceStack = memo(function WorkspaceStack(
  props: WorkspaceStackProps,
) {
  const { visibleKey, onNewAgent } = props;

  const keys = useAppStore(
    useShallow((s) =>
      (Object.keys(s.mountedWorkspaces) as WorkspaceKey[]).filter(
        (key) => s.workspaceLayouts[key] !== undefined,
      ),
    ),
  );
  return keys.map((key) => (
    <WorkspacePanelTree
      key={key}
      workspaceKey={key}
      visible={key === visibleKey}
      onNewAgent={onNewAgent}
    />
  ));
});

type WorkspacePanelTreeProps = {
  workspaceKey: WorkspaceKey;
  visible: boolean;
  onNewAgent: () => void;
};

const WorkspacePanelTree = memo(function WorkspacePanelTree(
  props: WorkspacePanelTreeProps,
) {
  const { workspaceKey, visible, onNewAgent } = props;

  const panelTree = useAppStore(
    (s) => s.workspaceLayouts[workspaceKey]?.panelTree,
  );
  if (!panelTree) return null;
  return (
    <div style={visible ? TAB_VISIBLE_STYLE : TAB_HIDDEN_STYLE}>
      <PanelLayout
        node={panelTree}
        workspaceKey={workspaceKey}
        onNewAgent={onNewAgent}
      />
    </div>
  );
});

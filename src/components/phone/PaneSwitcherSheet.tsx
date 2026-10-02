import * as Dialog from "@radix-ui/react-dialog";
import { useShallow } from "zustand/react/shallow";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import Globe from "lucide-react/dist/esm/icons/globe";
import GitCompareArrows from "lucide-react/dist/esm/icons/git-compare-arrows";
import { allPaneIds } from "../../lib/layout/pane-tree";
import { allPanelIds } from "../../lib/layout/panel-tree";
import type { Panel } from "../../lib/layout/workspace-layout";
import {
  leafOf,
  useAppStore,
  selectActiveLayout,
  selectFocusedPaneOfActiveTab,
} from "../../store/app-store";
import { useAgentStore } from "../../store/agent-store";
import { selectAgentRollup } from "../../store/agent-rollup";
import { paneTitle } from "../../lib/pane-title";
import { AgentDot } from "../ui/AgentDot/AgentDot";
import { Button } from "../ui/Button/Button";
import styles from "./PaneSwitcherSheet.module.css";

type PaneSwitcherSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function PaneIcon({ contentType }: { contentType: "terminal" | "browser" | "diff" }) {
  if (contentType === "diff") return <GitCompareArrows size={16} className={styles.rowIcon} />;
  if (contentType === "browser") return <Globe size={16} className={styles.rowIcon} />;
  return <Terminal size={16} className={styles.rowIcon} />;
}

/**
 * ADR-181 D3/D4: with no swipe between panes, this sheet and the
 * tab strip are the phone's only way to move. It lists the active
 * workspace's panels → tabs → panes, in layout order — every pane, not just
 * the ones a desktop window hasn't claimed, since a browser is never a
 * claimant and sees the whole workspace (ADR-179 D4).
 *
 * Tapping a row sets *no new state*: "which pane the phone shows" is the
 * viewport (ADR-179 D3), so a tap goes straight through `focusPane`, the
 * same action the desk uses to move focus to any pane in any panel — it
 * already activates the pane's panel and selects its tab, so nothing else
 * needs to run before the sheet closes.
 */
export function PaneSwitcherSheet(props: PaneSwitcherSheetProps) {
  const { open, onOpenChange } = props;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.sheet}
          data-testid="pane-switcher"
          aria-label="Switch pane"
          aria-describedby={undefined}
        >
          {/* Radix requires an accessible title; the rows themselves carry
              the visual content, so this one is hidden. */}
          <Dialog.Title className="sr-only">Switch pane</Dialog.Title>
          <PaneSwitcherList onSelect={() => onOpenChange(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type PaneSwitcherListProps = {
  /** Fires after a row has moved the viewport. */
  onSelect: () => void;
};

/**
 * The rows. A child of `Dialog.Content`, which mounts only while the sheet is
 * open, so none of these store subscriptions run while it is closed.
 */
function PaneSwitcherList(props: PaneSwitcherListProps) {
  const { onSelect } = props;

  const layout = useAppStore(selectActiveLayout);
  const titleState = useAppStore(
    useShallow((s) => ({
      paneTitle: s.paneTitle,
      paneCwd: s.paneCwd,
      paneLiveUrl: s.paneLiveUrl,
      workspaceLayouts: s.workspaceLayouts,
    })),
  );
  // What every agent dot reads (`selectAgentRollup`), so a row's dot says
  // what the pane's tab says.
  const rollupApp = useAppStore(
    useShallow((s) => ({
      paneAgentStatus: s.paneAgentStatus,
      workspaceLayouts: s.workspaceLayouts,
      activeWorkspacePath: s.activeWorkspacePath,
      activeWorkspaceHostId: s.activeWorkspaceHostId,
      viewports: s.viewports,
      claims: s.claims,
    })),
  );
  const currentPaneId = useAppStore(selectFocusedPaneOfActiveTab);
  const rollupAgents = useAgentStore(
    useShallow((s) => ({
      agents: s.agents,
      unseenRespondedAgentIds: s.unseenRespondedAgentIds,
      unseenInputAgentIds: s.unseenInputAgentIds,
    })),
  );
  const agents = rollupAgents.agents;

  const panels: Panel[] = layout
    ? allPanelIds(layout.panelTree)
        .map((panelId) => layout.panels[panelId])
        .filter((p): p is Panel => !!p)
    : [];

  function selectPane(paneId: string): void {
    useAppStore.getState().focusPane(paneId);
    onSelect();
  }

  return (
    <div className={styles.list}>
      {panels.map((panel, panelIndex) =>
        panel.tabs.map((tab, tabIndex) => {
          const paneIds = allPaneIds(tab.rootNode);
          return paneIds.map((paneId, paneIndex) => {
            const contentType = leafOf(layout, paneId)?.contentType ?? "terminal";
            const title = paneTitle(paneId, titleState, agents);
            const { status, pulse } = selectAgentRollup(
              { app: rollupApp, agents: rollupAgents },
              [paneId],
            );
            const isCurrent = paneId === currentPaneId;
            // Where it is, so two shells in the same directory — the usual
            // case — are still two different rows.
            const where = [
              panels.length > 1 ? `Panel ${panelIndex + 1}` : null,
              `Tab ${tabIndex + 1}`,
              paneIds.length > 1 ? `pane ${paneIndex + 1} of ${paneIds.length}` : null,
            ]
              .filter(Boolean)
              .join(" · ");

            return (
              <Button
                key={paneId}
                variant="ghost"
                className={`${styles.row} ${isCurrent ? styles.rowCurrent : ""}`}
                data-testid="pane-switcher-row"
                data-pane-id={paneId}
                aria-current={isCurrent ? "true" : undefined}
                onClick={() => selectPane(paneId)}
              >
                <PaneIcon contentType={contentType} />
                <span className={styles.rowText}>
                  <span className={styles.rowTitle}>{title}</span>
                  <span className={styles.rowWhere}>{where}</span>
                </span>
                <AgentDot status={status ?? undefined} size="tab" pulse={pulse} />
              </Button>
            );
          });
        }),
      )}
    </div>
  );
}

import * as Dialog from "@radix-ui/react-dialog";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import Globe from "lucide-react/dist/esm/icons/globe";
import GitCompareArrows from "lucide-react/dist/esm/icons/git-compare-arrows";
import { allPaneIds } from "../../lib/layout/pane-tree";
import { allPanelIds } from "../../lib/layout/panel-tree";
import type { Panel } from "../../lib/layout/workspace-layout";
import {
  useAppStore,
  selectActiveLayout,
  selectFocusedPaneOfActiveTab,
} from "../../store/app-store";
import { useAgentStore } from "../../store/agent-store";
import { selectAgentRollup } from "../../store/agent-rollup";
import { pinnedAgentName, tabTitle } from "../../lib/pane-title";
import { AgentDot } from "../ui/AgentDot/AgentDot";
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
 * ADR-181 D3/D4/ticket 5: with no swipe between panes, this sheet and the
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
        >
          {/* Radix requires an accessible title; the rows themselves carry
              the visual content, so this one is hidden. */}
          <Dialog.Title className="sr-only">Switch pane</Dialog.Title>
          <PaneList onSelected={() => onOpenChange(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The rows. Mounted only while the sheet is open (Radix unmounts closed
 * content), so it reads the whole app and agent stores rather than picking
 * fields: titles (`tabTitle`, the tab bar's own rule) and dots
 * (`selectAgentRollup`, every dot's rule) come from the same state the desk
 * reads them from, and a closed sheet subscribes to nothing.
 */
function PaneList({ onSelected }: { onSelected: () => void }) {
  const app = useAppStore();
  const agentState = useAgentStore();
  const layout = selectActiveLayout(app);
  const currentPaneId = selectFocusedPaneOfActiveTab(app);

  const panels: Panel[] = layout
    ? allPanelIds(layout.panelTree)
        .map((panelId) => layout.panels[panelId])
        .filter((p): p is Panel => !!p)
    : [];

  function selectPane(paneId: string): void {
    useAppStore.getState().focusPane(paneId);
    onSelected();
  }

  return (
    <div className={styles.list}>
      {panels.map((panel) =>
        panel.tabs.map((tab) =>
          allPaneIds(tab.rootNode).map((paneId) => {
            const contentType = app.paneContentType[paneId] ?? "terminal";
            const title = tabTitle(
              app,
              paneId,
              pinnedAgentName(agentState.agents, paneId),
            );
            const { status, pulse } = selectAgentRollup(
              { app, agents: agentState },
              [paneId],
            );
            const isCurrent = paneId === currentPaneId;

            return (
              <div
                key={paneId}
                role="button"
                tabIndex={0}
                className={`${styles.row} ${isCurrent ? styles.rowCurrent : ""}`}
                data-testid="pane-switcher-row"
                data-pane-id={paneId}
                aria-current={isCurrent ? "true" : undefined}
                onClick={() => selectPane(paneId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selectPane(paneId);
                  }
                }}
              >
                <PaneIcon contentType={contentType} />
                <span className={styles.rowTitle}>{title}</span>
                <AgentDot status={status ?? undefined} size="tab" pulse={pulse} />
              </div>
            );
          }),
        ),
      )}
    </div>
  );
}

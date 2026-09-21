import * as Dialog from "@radix-ui/react-dialog";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import Globe from "lucide-react/dist/esm/icons/globe";
import GitCompareArrows from "lucide-react/dist/esm/icons/git-compare-arrows";
import { allPaneIds } from "../../lib/layout/pane-tree";
import { allPanelIds } from "../../lib/layout/panel-tree";
import type { Panel } from "../../lib/layout/workspace-layout";
import {
  useAppStore,
  selectFocusedPaneOfActiveTab,
} from "../../store/app-store";
import { useAgentStore } from "../../store/agent-store";
import { pickBestPaneStatus } from "../../hooks/useTabAgentStatus";
import { AgentDot } from "../ui/AgentDot/AgentDot";
import styles from "./PaneSwitcherSheet.module.css";

type PaneSwitcherSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * A pane's title, from the same per-pane fields `useTabTitle` reads for the
 * tab bar — but keyed to *this* pane directly rather than a tab's focused
 * one, since the switcher lists every pane in a split tab, not just the one
 * on screen.
 */
function titleForPane(
  paneId: string,
  deps: {
    paneTitle: Record<string, string | undefined>;
    paneCwd: Record<string, string | undefined>;
    paneUrl: Record<string, string | undefined>;
    contentType: "terminal" | "browser" | "diff";
    pinnedAgentName: string | null;
  },
): string {
  const { paneTitle, paneCwd, paneUrl, contentType, pinnedAgentName } = deps;
  const title = paneTitle[paneId] ?? null;
  const cwd = paneCwd[paneId] ?? null;
  const url = paneUrl[paneId] ?? null;

  if (contentType === "diff") {
    return "Diff";
  }

  if (pinnedAgentName && contentType !== "browser") {
    return pinnedAgentName;
  }

  if (contentType === "browser") {
    if (title) return title;
    if (url) return url.replace(/^https?:\/\//, "");
  }

  if (title) {
    const cwdMatch = title.match(/^.+@.+:(.+)$/);
    if (cwdMatch) {
      const path = cwdMatch[1];
      const parts = path.replace(/\/+$/, "").split("/");
      return parts[parts.length - 1] || title;
    }
    return title;
  }

  if (cwd) {
    const parts = cwd.split("/");
    return parts[parts.length - 1] || parts[parts.length - 2] || cwd;
  }

  return "Terminal";
}

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

  const layout = useAppStore((s) =>
    s.activeWorkspacePath ? (s.workspaceLayouts[s.activeWorkspacePath] ?? null) : null,
  );
  const paneTitle = useAppStore((s) => s.paneTitle);
  const paneCwd = useAppStore((s) => s.paneCwd);
  const paneUrl = useAppStore((s) => s.paneUrl);
  const paneContentType = useAppStore((s) => s.paneContentType);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
  const currentPaneId = useAppStore(selectFocusedPaneOfActiveTab);
  const agents = useAgentStore((s) => s.agents);
  const unseenRespondedAgentIds = useAgentStore((s) => s.unseenRespondedAgentIds);
  const unseenInputAgentIds = useAgentStore((s) => s.unseenInputAgentIds);

  const panels: Panel[] = layout
    ? allPanelIds(layout.panelTree)
        .map((panelId) => layout.panels[panelId])
        .filter((p): p is Panel => !!p)
    : [];

  function selectPane(paneId: string): void {
    useAppStore.getState().focusPane(paneId);
    onOpenChange(false);
  }

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
          <div className={styles.list}>
            {panels.map((panel) =>
              panel.tabs.map((tab) =>
                allPaneIds(tab.rootNode).map((paneId) => {
                  const contentType = paneContentType[paneId] ?? "terminal";
                  const pinnedAgentName =
                    agents.find((a) => a.paneId === paneId && a.namePinned && a.name)
                      ?.name ?? null;
                  const title = titleForPane(paneId, {
                    paneTitle,
                    paneCwd,
                    paneUrl,
                    contentType,
                    pinnedAgentName,
                  });
                  const { status, pulse } = pickBestPaneStatus([paneId], {
                    paneAgentStatus,
                    agents,
                    unseenRespondedAgentIds,
                    unseenInputAgentIds,
                  });
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

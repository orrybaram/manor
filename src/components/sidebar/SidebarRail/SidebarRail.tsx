import { useCallback, useEffect, useMemo, useRef } from "react";
import House from "lucide-react/dist/esm/icons/house";
import Bot from "lucide-react/dist/esm/icons/bot";
import { Button } from "../../ui/Button/Button";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { useProjectStore } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { HOME_PATH, isHomePath } from "../../../lib/home";
import { handleSidebarRowKeyDown, useRovingRows } from "../../../lib/sidebar-row";
import { buildTopLevelEntries } from "../../../utils/sidebar-items";
import { useBranchWatcher } from "../../../hooks/useBranchWatcher";
import { useDiffWatcher } from "../../../hooks/useDiffWatcher";
import { usePrWatcher } from "../../../hooks/usePrWatcher";
import { useVisibleAgents } from "../../../hooks/useVisibleAgents";
import { NotificationsPopover } from "../../notifications/NotificationsPopover";
import { RailProjectTile } from "./RailProjectTile";
import { useRailPopover } from "./useRailPopover";
import { RailPopoverShell } from "./RailPopoverShell";
import { AgentsList } from "../AgentsList";
import styles from "./SidebarRail.module.css";

/** The Agents button's key in the rail's one open popover; never a project id. */
const AGENTS_POPOVER_KEY = "rail:agents";

type SidebarRailProps = {
  onShowAgents: () => void;
  onOpenProjectSettings?: (projectId: string) => void;
};

/**
 * The collapsed sidebar (ADR-195): a 52px strip with Home, one tile per
 * project or linked group carrying its agent status, and Agents and
 * Notifications at the bottom. A tile opens a popover with the entry as the
 * full sidebar shows it, on click or after resting the pointer on it.
 */
export function SidebarRail(props: SidebarRailProps) {
  const { onShowAgents, onOpenProjectSettings } = props;

  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const homeActive = isHomePath(activeWorkspacePath);
  const agentCount = useVisibleAgents().length;

  // The full sidebar runs these; the rail stands in for it, so branch names,
  // diff stats and PRs stay current while it's collapsed.
  useBranchWatcher();
  useDiffWatcher();
  usePrWatcher();

  const entries = useMemo(() => buildTopLevelEntries(projects), [projects]);
  const selectedProject = projects[selectedProjectIndex];

  const popover = useRailPopover();

  const railRef = useRef<HTMLDivElement>(null);
  useRovingRows(railRef);

  const goHome = () => setActiveWorkspace(HOME_PATH);

  const { setOpen } = popover;
  const onAgentsOpenChange = useCallback(
    (next: boolean) => setOpen(AGENTS_POPOVER_KEY, next),
    [setOpen],
  );
  // With no agents the button opens the Agents view instead; don't leave
  // its popover marked open to reappear with the next agent.
  const agentsPopoverStale = agentCount === 0 && popover.openKey === AGENTS_POPOVER_KEY;
  useEffect(() => {
    if (agentsPopoverStale) setOpen(AGENTS_POPOVER_KEY, false);
  }, [agentsPopoverStale, setOpen]);
  const agentsButtonProps = {
    variant: "ghost" as const,
    className: styles.iconButton,
    "data-testid": "rail-agents",
    "data-sidebar-row": "",
    tabIndex: -1,
    "aria-label": "Agents",
  };
  const agentsIcon = <Bot size={14} />;

  return (
    <div
      ref={railRef}
      className={styles.rail}
      data-focus-region="sidebar"
      data-testid="sidebar-rail"
    >
      <div className={styles.dragSpacer} />
      <Tooltip label="Home" side="right">
        <Button
          variant="ghost"
          className={`${styles.iconButton} ${homeActive ? styles.homeActive : ""}`}
          data-testid="rail-home"
          data-sidebar-row=""
          tabIndex={-1}
          aria-label="Home"
          aria-current={homeActive ? "true" : undefined}
          onClick={goHome}
          onKeyDown={(e) => handleSidebarRowKeyDown(e, { activate: goHome })}
        >
          <House size={14} />
        </Button>
      </Tooltip>
      <div className={styles.divider} />
      <div className={styles.tiles}>
        {entries.map((entry) => (
          <RailProjectTile
            key={entry.key}
            entry={entry}
            onOpenProjectSettings={onOpenProjectSettings}
            popover={popover}
            isSelected={
              !homeActive &&
              selectedProject !== undefined &&
              (entry.kind === "project"
                ? entry.project === selectedProject
                : entry.sections.some((s) => s.project === selectedProject))
            }
          />
        ))}
      </div>
      <div className={styles.footer}>
        {agentCount > 0 ? (
          // The full sidebar's Agents panel, on hover or click (ADR-195).
          <RailPopoverShell
            open={popover.openKey === AGENTS_POPOVER_KEY}
            onOpenChange={onAgentsOpenChange}
            focusOnOpen={popover.focusOnOpen}
            onContentPointerEnter={popover.onContentEnter}
            onContentPointerLeave={popover.onContentLeave}
            testId="rail-agents-popover"
            anchor={
              <Button
                {...agentsButtonProps}
                aria-haspopup="dialog"
                aria-expanded={popover.openKey === AGENTS_POPOVER_KEY}
                onPointerEnter={() => popover.onTileEnter(AGENTS_POPOVER_KEY)}
                onPointerLeave={popover.onTileLeave}
                onClick={() => popover.openNow(AGENTS_POPOVER_KEY, true)}
                onKeyDown={(e) =>
                  handleSidebarRowKeyDown(e, {
                    activate: () => popover.openNow(AGENTS_POPOVER_KEY, true),
                  })
                }
              >
                {agentsIcon}
              </Button>
            }
          >
            {(onNavigated) => (
              <AgentsList
                fitContent
                onAgentSelect={onNavigated}
                onShowAll={() => {
                  popover.setOpen(AGENTS_POPOVER_KEY, false);
                  onShowAgents();
                }}
              />
            )}
          </RailPopoverShell>
        ) : (
          <Tooltip label="Agents" side="right">
            <Button
              {...agentsButtonProps}
              onClick={onShowAgents}
              onKeyDown={(e) => handleSidebarRowKeyDown(e, { activate: onShowAgents })}
            >
              {agentsIcon}
            </Button>
          </Tooltip>
        )}
        <NotificationsPopover />
      </div>
    </div>
  );
}

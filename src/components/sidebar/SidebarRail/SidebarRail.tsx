import { useMemo, useRef } from "react";
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
import styles from "./SidebarRail.module.css";

type SidebarRailProps = {
  onShowAgents: () => void;
};

/**
 * The collapsed sidebar (ADR-195): a 52px strip with Home, one tile per
 * project or linked group carrying its agent status, and Agents and
 * Notifications at the bottom. A tile opens a popover of its workspaces.
 */
export function SidebarRail(props: SidebarRailProps) {
  const { onShowAgents } = props;

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

  const railRef = useRef<HTMLDivElement>(null);
  useRovingRows(railRef);

  const goHome = () => setActiveWorkspace(HOME_PATH);

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
        <Tooltip label="Agents" side="right">
          <Button
            variant="ghost"
            className={`${styles.iconButton} ${styles.agentsButton}`}
            data-testid="rail-agents"
            data-sidebar-row=""
            tabIndex={-1}
            aria-label={`Agents (${agentCount})`}
            onClick={onShowAgents}
            onKeyDown={(e) => handleSidebarRowKeyDown(e, { activate: onShowAgents })}
          >
            <Bot size={14} />
            {agentCount > 0 && <span className={styles.agentsCount}>{agentCount}</span>}
          </Button>
        </Tooltip>
        <NotificationsPopover />
      </div>
    </div>
  );
}

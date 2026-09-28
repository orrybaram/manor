import { useCallback, useMemo } from "react";
import { Button } from "../../ui/Button/Button";
import type { TopLevelEntry } from "../../../utils/sidebar-items";
import {
  useGroupAgentStatus,
  useProjectAgentStatus,
} from "../../../hooks/useProjectAgentStatus";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import { handleSidebarRowKeyDown } from "../../../lib/sidebar-row";
import { railTileLabel } from "../../../lib/sidebar-rail";
import {
  toWorkspaceIndicator,
  type WorkspaceIndicator,
} from "../../../lib/workspace-indicator";
import { WorkspaceIndicatorDot } from "../WorkspaceIndicatorDot";
import { RailWorkspacePopover } from "./RailWorkspacePopover";
import type { RailPopover } from "./useRailPopover";
import styles from "./SidebarRail.module.css";

type ProjectEntry = Extract<TopLevelEntry, { kind: "project" }>;
type GroupEntry = Extract<TopLevelEntry, { kind: "group" }>;

type RailProjectTileProps = {
  entry: TopLevelEntry;
  /** The entry holds the selected project and home isn't active. */
  isSelected: boolean;
  popover: RailPopover;
  onOpenProjectSettings?: (projectId: string) => void;
};

/** One rail tile per sidebar entry: a lone project or a linked group. */
export function RailProjectTile(props: RailProjectTileProps) {
  const { entry, isSelected, popover, onOpenProjectSettings } = props;

  return entry.kind === "project" ? (
    <RailSingleProjectTile
      entry={entry}
      isSelected={isSelected}
      popover={popover}
      onOpenProjectSettings={onOpenProjectSettings}
    />
  ) : (
    <RailGroupTile
      entry={entry}
      isSelected={isSelected}
      popover={popover}
      onOpenProjectSettings={onOpenProjectSettings}
    />
  );
}

function RailSingleProjectTile(props: { entry: ProjectEntry; isSelected: boolean; popover: RailPopover; onOpenProjectSettings?: (projectId: string) => void }) {
  const { entry, isSelected, popover, onOpenProjectSettings } = props;

  const { status, pulse } = useProjectAgentStatus(entry.project);

  return (
    <RailTile
      entry={entry}
      name={entry.project.name}
      color={entry.project.color ?? null}
      indicator={toWorkspaceIndicator(status, pulse)}
      isSelected={isSelected}
      popover={popover}
      onOpenProjectSettings={onOpenProjectSettings}
    />
  );
}

function RailGroupTile(props: { entry: GroupEntry; isSelected: boolean; popover: RailPopover; onOpenProjectSettings?: (projectId: string) => void }) {
  const { entry, isSelected, popover, onOpenProjectSettings } = props;

  const members = useMemo(
    () => entry.sections.map((section) => section.project),
    [entry.sections],
  );
  const { status, pulse } = useGroupAgentStatus(members);
  // The first member with a color stands for the group, as in ProjectGroupItem.
  const color = members.find((m) => m.color)?.color ?? null;

  return (
    <RailTile
      entry={entry}
      name={entry.group.name}
      color={color}
      indicator={toWorkspaceIndicator(status, pulse)}
      isSelected={isSelected}
      popover={popover}
      onOpenProjectSettings={onOpenProjectSettings}
    />
  );
}

type RailTileProps = {
  entry: TopLevelEntry;
  name: string;
  color: string | null;
  indicator: WorkspaceIndicator;
  isSelected: boolean;
  popover: RailPopover;
  onOpenProjectSettings?: (projectId: string) => void;
};

// No name tooltip: it would fight the hover popover, whose entry header
// already names the project.
function RailTile(props: RailTileProps) {
  const { entry, name, color, indicator, isSelected, popover, onOpenProjectSettings } = props;

  const open = popover.openKey === entry.key;
  const { setOpen } = popover;
  const onOpenChange = useCallback(
    (next: boolean) => setOpen(entry.key, next),
    [setOpen, entry.key],
  );

  return (
    <div className={styles.tileSlot} style={projectColorStyle(color)}>
      {isSelected && <span className={styles.activeMarker} aria-hidden />}
      <RailWorkspacePopover
        entry={entry}
        open={open}
        onOpenChange={onOpenChange}
        focusOnOpen={popover.focusOnOpen}
        onOpenProjectSettings={onOpenProjectSettings}
        onContentPointerEnter={popover.onContentEnter}
        onContentPointerLeave={popover.onContentLeave}
      >
        <Button
          variant="ghost"
          className={`${styles.tile} ${isSelected ? styles.tileSelected : ""}`}
          data-testid="rail-project-tile"
          data-entry-key={entry.key}
          data-sidebar-row=""
          tabIndex={-1}
          aria-label={name}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-current={isSelected ? "true" : undefined}
          onPointerEnter={() => popover.onTileEnter(entry.key)}
          onPointerLeave={popover.onTileLeave}
          onClick={() => popover.openNow(entry.key, true)}
          onKeyDown={(e) =>
            handleSidebarRowKeyDown(e, { activate: () => popover.openNow(entry.key, true) })
          }
        >
          {railTileLabel(name)}
          {indicator && (
            <span className={styles.badge}>
              <WorkspaceIndicatorDot indicator={indicator} />
            </span>
          )}
        </Button>
      </RailWorkspacePopover>
    </div>
  );
}

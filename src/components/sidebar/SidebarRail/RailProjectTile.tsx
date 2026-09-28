import { useMemo, useState } from "react";
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
import styles from "./SidebarRail.module.css";

type ProjectEntry = Extract<TopLevelEntry, { kind: "project" }>;
type GroupEntry = Extract<TopLevelEntry, { kind: "group" }>;

type RailProjectTileProps = {
  entry: TopLevelEntry;
  /** The entry holds the selected project and home isn't active. */
  isSelected: boolean;
};

/** One rail tile per sidebar entry: a lone project or a linked group. */
export function RailProjectTile(props: RailProjectTileProps) {
  const { entry, isSelected } = props;

  return entry.kind === "project" ? (
    <RailSingleProjectTile entry={entry} isSelected={isSelected} />
  ) : (
    <RailGroupTile entry={entry} isSelected={isSelected} />
  );
}

function RailSingleProjectTile(props: { entry: ProjectEntry; isSelected: boolean }) {
  const { entry, isSelected } = props;

  const { status, pulse } = useProjectAgentStatus(entry.project);

  return (
    <RailTile
      entry={entry}
      name={entry.project.name}
      color={entry.project.color ?? null}
      indicator={toWorkspaceIndicator(status, pulse)}
      isSelected={isSelected}
    />
  );
}

function RailGroupTile(props: { entry: GroupEntry; isSelected: boolean }) {
  const { entry, isSelected } = props;

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
    />
  );
}

type RailTileProps = {
  entry: TopLevelEntry;
  name: string;
  color: string | null;
  indicator: WorkspaceIndicator;
  isSelected: boolean;
};

function RailTile(props: RailTileProps) {
  const { entry, name, color, indicator, isSelected } = props;

  const [open, setOpen] = useState(false);

  return (
    <div className={styles.tileSlot} style={projectColorStyle(color)}>
      {isSelected && <span className={styles.activeMarker} aria-hidden />}
      <RailWorkspacePopover
        entry={entry}
        name={name}
        color={color}
        open={open}
        onOpenChange={setOpen}
      >
        <Button
          variant="ghost"
          className={`${styles.tile} ${isSelected ? styles.tileSelected : ""}`}
          data-testid="rail-project-tile"
          data-entry-key={entry.key}
          data-sidebar-row=""
          tabIndex={-1}
          aria-label={name}
          aria-current={isSelected ? "true" : undefined}
          onKeyDown={(e) =>
            handleSidebarRowKeyDown(e, { activate: () => setOpen(true) })
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

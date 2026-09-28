import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../ui/Button/Button";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
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
  onOpenProjectSettings?: (projectId: string) => void;
};

/** One rail tile per sidebar entry: a lone project or a linked group. */
export function RailProjectTile(props: RailProjectTileProps) {
  const { entry, isSelected, onOpenProjectSettings } = props;

  return entry.kind === "project" ? (
    <RailSingleProjectTile
      entry={entry}
      isSelected={isSelected}
      onOpenProjectSettings={onOpenProjectSettings}
    />
  ) : (
    <RailGroupTile
      entry={entry}
      isSelected={isSelected}
      onOpenProjectSettings={onOpenProjectSettings}
    />
  );
}

function RailSingleProjectTile(props: { entry: ProjectEntry; isSelected: boolean; onOpenProjectSettings?: (projectId: string) => void }) {
  const { entry, isSelected, onOpenProjectSettings } = props;

  const { status, pulse } = useProjectAgentStatus(entry.project);

  return (
    <RailTile
      entry={entry}
      name={entry.project.name}
      color={entry.project.color ?? null}
      indicator={toWorkspaceIndicator(status, pulse)}
      isSelected={isSelected}
      onOpenProjectSettings={onOpenProjectSettings}
    />
  );
}

function RailGroupTile(props: { entry: GroupEntry; isSelected: boolean; onOpenProjectSettings?: (projectId: string) => void }) {
  const { entry, isSelected, onOpenProjectSettings } = props;

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
      onOpenProjectSettings={onOpenProjectSettings}
    />
  );
}

/** How long the pointer rests on a tile before its popover opens. */
const HOVER_OPEN_DELAY_MS = 1000;
/** Grace for the pointer to cross from the tile to the popover and back. */
const HOVER_CLOSE_DELAY_MS = 300;

/**
 * Whether something opened from the popover — a context menu, a dialog, an
 * inline rename — still needs it. Closing would unmount it.
 */
function popoverInUse(): boolean {
  const content = document.querySelector('[data-testid="rail-workspace-popover"]');
  if (!content) return false;
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && content.contains(active)) return true;
  return Array.from(
    document.querySelectorAll('[role="menu"], [role="dialog"], [role="alertdialog"]'),
  ).some((layer) => layer !== content && !content.contains(layer));
}

type RailTileProps = {
  entry: TopLevelEntry;
  name: string;
  color: string | null;
  indicator: WorkspaceIndicator;
  isSelected: boolean;
  onOpenProjectSettings?: (projectId: string) => void;
};

function RailTile(props: RailTileProps) {
  const { entry, name, color, indicator, isSelected, onOpenProjectSettings } = props;

  const [open, setOpen] = useState(false);
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);

  const clearTimers = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  const openNow = (focus: boolean) => {
    clearTimers();
    setFocusOnOpen(focus);
    setOpen(true);
  };

  const scheduleClose = () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    const tryClose = () => {
      // Wait out a menu or dialog opened from the popover.
      if (popoverInUse()) closeTimer.current = window.setTimeout(tryClose, HOVER_CLOSE_DELAY_MS);
      else setOpen(false);
    };
    closeTimer.current = window.setTimeout(tryClose, HOVER_CLOSE_DELAY_MS);
  };

  const onOpenChange = useCallback(
    (next: boolean) => {
      clearTimers();
      setOpen(next);
    },
    [clearTimers],
  );

  return (
    <div className={styles.tileSlot} style={projectColorStyle(color)}>
      {isSelected && <span className={styles.activeMarker} aria-hidden />}
      <RailWorkspacePopover
        entry={entry}
        open={open}
        onOpenChange={onOpenChange}
        focusOnOpen={focusOnOpen}
        onOpenProjectSettings={onOpenProjectSettings}
        onContentPointerEnter={() => window.clearTimeout(closeTimer.current)}
        onContentPointerLeave={scheduleClose}
      >
        <Tooltip label={name} side="right" disabled={open}>
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
            onPointerEnter={() => {
              window.clearTimeout(closeTimer.current);
              if (!open) {
                openTimer.current = window.setTimeout(() => openNow(false), HOVER_OPEN_DELAY_MS);
              }
            }}
            onPointerLeave={() => {
              window.clearTimeout(openTimer.current);
              if (open) scheduleClose();
            }}
            onClick={() => openNow(true)}
            onKeyDown={(e) =>
              handleSidebarRowKeyDown(e, { activate: () => openNow(true) })
            }
          >
            {railTileLabel(name)}
            {indicator && (
              <span className={styles.badge}>
                <WorkspaceIndicatorDot indicator={indicator} />
              </span>
            )}
          </Button>
        </Tooltip>
      </RailWorkspacePopover>
    </div>
  );
}

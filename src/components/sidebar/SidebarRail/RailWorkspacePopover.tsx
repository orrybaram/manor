import type { ReactNode } from "react";
import type { TopLevelEntry } from "../../../utils/sidebar-items";
import { SidebarEntry } from "../SidebarEntry";
import sidebarStyles from "../Sidebar/Sidebar.module.css";
import { RailPopoverShell } from "./RailPopoverShell";

type RailWorkspacePopoverProps = {
  entry: TopLevelEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Move focus into the popover as it opens. False for a hover open. */
  focusOnOpen: boolean;
  onOpenProjectSettings?: (projectId: string) => void;
  /** The popover body's pointer enter/leave, for the rail's hover intent. */
  onContentPointerEnter: () => void;
  onContentPointerLeave: () => void;
  /** The tile, which the popover is anchored to. */
  children: ReactNode;
};

/**
 * The rail tile's popover (ADR-195): the entry exactly as the full sidebar
 * renders it — rows, badges, menus and actions — through `SidebarEntry`,
 * always expanded.
 */
export function RailWorkspacePopover(props: RailWorkspacePopoverProps) {
  const { entry, onOpenProjectSettings, children, ...shell } = props;

  return (
    <RailPopoverShell {...shell} anchor={children} testId="rail-workspace-popover">
      {() => (
        <div className={sidebarStyles.projects}>
          <SidebarEntry
            entry={entry}
            onOpenProjectSettings={onOpenProjectSettings}
            forceExpanded
          />
        </div>
      )}
    </RailPopoverShell>
  );
}

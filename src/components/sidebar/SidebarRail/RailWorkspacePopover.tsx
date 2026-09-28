import { useEffect, useRef, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useProjectStore } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { installRovingRows } from "../../../lib/sidebar-row";
import type { TopLevelEntry } from "../../../utils/sidebar-items";
import { SidebarEntry } from "../SidebarEntry";
import sidebarStyles from "../Sidebar/Sidebar.module.css";
import styles from "./SidebarRail.module.css";

/** Wider than the sidebar's default, so branch lines and badges fit. */
const POPOVER_MIN_WIDTH = 340;

type RailWorkspacePopoverProps = {
  entry: TopLevelEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Move focus into the popover as it opens. False for a hover open. */
  focusOnOpen: boolean;
  onOpenProjectSettings?: (projectId: string) => void;
  /** The popover body's pointer enter/leave, for the tile's hover intent. */
  onContentPointerEnter: () => void;
  onContentPointerLeave: () => void;
  /** The tile, which the popover is anchored to. */
  children: ReactNode;
};

/** A pointer or focus target inside another floating layer, not outside. */
function inOtherLayer(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      '[role="menu"], [role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]',
    ) !== null
  );
}

/**
 * The rail tile's popover (ADR-195): the entry exactly as the full sidebar
 * renders it — rows, badges, menus and actions — through `SidebarEntry`,
 * always expanded. Switching workspace from it closes it.
 */
export function RailWorkspacePopover(props: RailWorkspacePopoverProps) {
  const {
    entry,
    open,
    onOpenChange,
    focusOnOpen,
    onOpenProjectSettings,
    onContentPointerEnter,
    onContentPointerLeave,
    children,
  } = props;

  const sidebarWidth = useProjectStore((s) => s.sidebarWidth);
  const anchorRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Set when a switch closed the popover, so focus goes to the new pane
  // rather than back to the tile.
  const switchedRef = useRef(false);

  // The body mounts with the popover, so the roving tab stop installs on open.
  useEffect(() => {
    const root = bodyRef.current;
    if (!open || !root) return;
    return installRovingRows(root);
  }, [open]);

  // Picking a workspace in the popover navigates; close on it.
  useEffect(() => {
    if (!open) return;
    return useAppStore.subscribe((state, prev) => {
      if (
        state.activeWorkspacePath !== prev.activeWorkspacePath ||
        state.activeWorkspaceHostId !== prev.activeWorkspaceHostId
      ) {
        switchedRef.current = true;
        onOpenChange(false);
      }
    });
  }, [open, onOpenChange]);

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor asChild>
        <div ref={anchorRef} className={styles.anchor}>
          {children}
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          data-testid="rail-workspace-popover"
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          style={{ width: Math.max(sidebarWidth, POPOVER_MIN_WIDTH) }}
          onPointerEnter={onContentPointerEnter}
          onPointerLeave={onContentPointerLeave}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (!focusOnOpen) return;
            const rows = Array.from(
              bodyRef.current?.querySelectorAll<HTMLElement>("[data-sidebar-row]") ?? [],
            );
            (rows.find((row) => row.getAttribute("aria-current") === "true") ?? rows[0])?.focus();
          }}
          onCloseAutoFocus={(e) => {
            if (switchedRef.current) {
              switchedRef.current = false;
              e.preventDefault();
              useAppStore.getState().refocusActivePane();
              return;
            }
            // A hover open never took focus; leave it where it is (a
            // terminal, another tile's popover) rather than pulling it back.
            if (!bodyRef.current?.contains(document.activeElement)) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            const target = e.target as Node | null;
            // The tile toggles the popover itself; menus and dialogs opened
            // from inside the popover aren't "outside" it.
            if ((target && anchorRef.current?.contains(target)) || inOtherLayer(e.target)) {
              e.preventDefault();
            }
          }}
        >
          <div ref={bodyRef} className={sidebarStyles.projects}>
            <SidebarEntry
              entry={entry}
              onOpenProjectSettings={onOpenProjectSettings}
              forceExpanded
            />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

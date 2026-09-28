import { useCallback, useEffect, useRef, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useProjectStore } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { installRovingRows } from "../../../lib/sidebar-row";
import { RAIL_POPOVER_ATTR } from "./useRailPopover";
import styles from "./SidebarRail.module.css";

/** Wider than the sidebar's default, so branch lines and badges fit. */
const POPOVER_MIN_WIDTH = 340;

type RailPopoverShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Move focus into the popover as it opens. False for a hover open. */
  focusOnOpen: boolean;
  /** The popover body's pointer enter/leave, for the rail's hover intent. */
  onContentPointerEnter: () => void;
  onContentPointerLeave: () => void;
  /** The rail button the popover is anchored to. */
  anchor: ReactNode;
  /**
   * What the full sidebar shows for this button. Call `onNavigated` after
   * navigating somewhere a workspace switch wouldn't catch (another pane of
   * the same workspace) to close the popover onto it.
   */
  children: (onNavigated: () => void) => ReactNode;
  testId: string;
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
 * A rail popover (ADR-195): a piece of the full sidebar, opened beside the
 * rail button it belongs to, at the sidebar's width. Navigating from inside
 * it (to a workspace, to an agent's pane) closes it.
 */
export function RailPopoverShell(props: RailPopoverShellProps) {
  const {
    open,
    onOpenChange,
    focusOnOpen,
    onContentPointerEnter,
    onContentPointerLeave,
    anchor,
    children,
    testId,
  } = props;

  const sidebarWidth = useProjectStore((s) => s.sidebarWidth);
  const anchorRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Set when navigation closed the popover, so focus goes to the new pane
  // rather than back to the rail.
  const navigatedRef = useRef(false);

  // The body mounts with the popover, so the roving tab stop installs on open.
  useEffect(() => {
    const root = bodyRef.current;
    if (!open || !root) return;
    return installRovingRows(root);
  }, [open]);

  const onNavigated = useCallback(() => {
    navigatedRef.current = true;
    onOpenChange(false);
  }, [onOpenChange]);

  // Picking a workspace navigates; close on it.
  useEffect(() => {
    if (!open) return;
    return useAppStore.subscribe((state, prev) => {
      if (
        state.activeWorkspacePath !== prev.activeWorkspacePath ||
        state.activeWorkspaceHostId !== prev.activeWorkspaceHostId
      ) {
        onNavigated();
      }
    });
  }, [open, onNavigated]);

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor asChild>
        <div ref={anchorRef} className={styles.anchor}>
          {anchor}
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          data-testid={testId}
          {...{ [RAIL_POPOVER_ATTR]: "" }}
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
            if (navigatedRef.current) {
              navigatedRef.current = false;
              e.preventDefault();
              useAppStore.getState().refocusActivePane();
              return;
            }
            // A hover open never took focus; leave it where it is (a
            // terminal, another rail popover) rather than pulling it back.
            if (!bodyRef.current?.contains(document.activeElement)) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            const target = e.target as Node | null;
            // The rail button toggles the popover itself; menus and dialogs
            // opened from inside the popover aren't "outside" it.
            if ((target && anchorRef.current?.contains(target)) || inOtherLayer(e.target)) {
              e.preventDefault();
            }
          }}
        >
          <div ref={bodyRef}>{children(onNavigated)}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

import { useRef, type TouchEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Sidebar } from "../sidebar/Sidebar/Sidebar";
import styles from "./SidebarDrawer.module.css";

type SidebarDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowAgents?: () => void;
  onOpenProjectSettings?: (projectId: string) => void;
  onAddProject?: () => void;
  /** The nav group's Search row. */
  onOpenSearch?: () => void;
  /** The nav group's Notifications row (phone only). */
  onOpenNotifications?: () => void;
};

/**
 * ADR-181 D3: in phone mode the sidebar lives in a left-edge drawer
 * instead of inline — inline would eat the whole screen at phone width.
 * Radix `Dialog` supplies most of what a drawer needs: the overlay, Escape
 * and an overlay tap both closing it, a focus trap
 * while open, and — since this is a controlled dialog with no
 * `Dialog.Trigger` of its own — focus returned to whatever had it when the
 * drawer opened (`PhoneTopBar`'s drawer toggle) once it closes.
 *
 * The content is the very same `Sidebar` the desk layout renders inline;
 * moving it between parents remounts it, which costs nothing since it holds
 * no terminals. `onNavigate` is `Sidebar`'s existing workspace-select path —
 * choosing Home or a workspace closes the drawer because the user asked to
 * go somewhere, not because this duplicates that selection logic.
 */
/** A finger has to travel this far before the swipe picks an axis. */
const AXIS_SLOP_PX = 8;
/** Dragged further left than this, the drawer closes; short of it, it
 *  springs back. */
const CLOSE_DISTANCE_PX = 60;

/**
 * Swipe the drawer away: it follows a leftward drag and closes past
 * `CLOSE_DISTANCE_PX`. A gesture that starts out vertical is the project
 * list's scroll and is left alone. Touch events rather than pointer events:
 * the browser cancels a pointer the moment it starts scrolling.
 *
 * The offset is `--swipe-x` on the sheet, set straight on the element so a
 * drag re-renders nothing; the close animation starts from it
 * (`SidebarDrawer.module.css`), so the sheet leaves from where the finger
 * let go instead of jumping back first.
 */
function useSwipeToClose(onClose: () => void) {
  const gesture = useRef<{ x: number; y: number; axis: "x" | "y" | null } | null>(
    null,
  );

  const reset = (el: HTMLElement) => {
    el.removeAttribute("data-swiping");
    el.style.removeProperty("--swipe-x");
  };

  return {
    onTouchStart: (e: TouchEvent<HTMLElement>) => {
      const t = e.touches[0];
      gesture.current =
        e.touches.length === 1 ? { x: t.clientX, y: t.clientY, axis: null } : null;
    },
    onTouchMove: (e: TouchEvent<HTMLElement>) => {
      const g = gesture.current;
      if (!g) return;
      const t = e.touches[0];
      const dx = t.clientX - g.x;
      const dy = t.clientY - g.y;
      if (g.axis === null) {
        if (Math.abs(dx) < AXIS_SLOP_PX && Math.abs(dy) < AXIS_SLOP_PX) return;
        g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }
      if (g.axis !== "x") return;
      e.currentTarget.setAttribute("data-swiping", "");
      e.currentTarget.style.setProperty("--swipe-x", `${Math.min(0, dx)}px`);
    },
    onTouchEnd: (e: TouchEvent<HTMLElement>) => {
      const g = gesture.current;
      gesture.current = null;
      if (!g || g.axis !== "x") return;
      const el = e.currentTarget;
      const dx = e.changedTouches[0].clientX - g.x;
      if (dx < -CLOSE_DISTANCE_PX) {
        // `--swipe-x` stays: the close animation starts from it.
        el.removeAttribute("data-swiping");
        onClose();
      } else {
        reset(el);
      }
    },
    onTouchCancel: (e: TouchEvent<HTMLElement>) => {
      gesture.current = null;
      reset(e.currentTarget);
    },
  };
}

export function SidebarDrawer(props: SidebarDrawerProps) {
  const {
    open,
    onOpenChange,
    onShowAgents,
    onOpenProjectSettings,
    onAddProject,
    onOpenSearch,
    onOpenNotifications,
  } = props;
  const swipe = useSwipeToClose(() => onOpenChange(false));

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.sheet}
          data-testid="sidebar-drawer"
          aria-label="Sidebar"
          aria-describedby={undefined}
          {...swipe}
          // Focus the sheet, not its first button: on a phone that button's
          // focus ring (and tooltip) is the first thing the drawer shows.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus();
          }}
        >
          {/* Radix requires an accessible title; the sidebar's own content
              already carries the visual heading, so this one is hidden. */}
          <Dialog.Title className="sr-only">Sidebar</Dialog.Title>
          <Sidebar
            onShowAgents={onShowAgents}
            onOpenProjectSettings={onOpenProjectSettings}
            onAddProject={onAddProject}
            onOpenSearch={onOpenSearch}
            onOpenNotifications={onOpenNotifications}
            onNavigate={() => onOpenChange(false)}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

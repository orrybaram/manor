import * as Dialog from "@radix-ui/react-dialog";
import { PhoneAgentsPanel } from "./AgentsDrawer/PhoneAgentsPanel";
import { useSwipeToClose } from "./useDrawerSwipe";
import styles from "./SidebarDrawer.module.css";

type SidebarDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The agents view's "New agent" button. */
  onNewAgent: () => void;
  /** The agents view's settings button. */
  onOpenSettings: () => void;
  /** The nav group's Search row. */
  onOpenSearch: () => void;
  /** The nav group's Notifications row (phone only). */
  onOpenNotifications: () => void;
  /** The nav group's Hosts icon (a browser only). */
  onOpenHosts?: () => void;
};

/**
 * In phone mode the sidebar lives in a left-edge drawer
 * instead of inline — inline would eat the whole screen at phone width.
 * Radix `Dialog` supplies most of what a drawer needs: the overlay, Escape
 * and an overlay tap both closing it, a focus trap
 * while open, and — since this is a controlled dialog with no
 * `Dialog.Trigger` of its own — focus returned to whatever had it when the
 * drawer opened (`PhoneTopBar`'s drawer toggle) once it closes.
 *
 * The drawer holds the agents-first view (`PhoneAgentsPanel`).
 */
export function SidebarDrawer(props: SidebarDrawerProps) {
  const {
    open,
    onOpenChange,
    onNewAgent,
    onOpenSettings,
    onOpenSearch,
    onOpenNotifications,
    onOpenHosts,
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
          {/* Radix requires an accessible title; the panel's own content
              already carries the visual heading, so this one is hidden. */}
          <Dialog.Title className="sr-only">Sidebar</Dialog.Title>
          <PhoneAgentsPanel
            onNewAgent={onNewAgent}
            onOpenSettings={onOpenSettings}
            onOpenSearch={onOpenSearch}
            onOpenNotifications={onOpenNotifications}
            onOpenHosts={onOpenHosts}
            onNavigate={() => onOpenChange(false)}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

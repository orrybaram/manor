import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import { Button } from "../ui/Button/Button";
import { NotificationsPanel } from "../notifications/NotificationsPopover";
import styles from "./NotificationsSheet.module.css";

type NotificationsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * The phone's notification history: the desk popover's `NotificationsPanel`
 * in a full-height sheet, opened from the drawer's Notifications row (or a
 * pushed notification's `open-notifications` request). Radix `Dialog` gives
 * it the overlay, Escape and focus handling the drawer has. A row tap
 * navigates and closes the sheet.
 */
export function NotificationsSheet(props: NotificationsSheetProps) {
  const { open, onOpenChange } = props;

  const close = () => onOpenChange(false);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.sheet}
          data-testid="notifications-sheet"
          aria-describedby={undefined}
          // Focus the sheet, not its first button, whose focus ring and
          // tooltip would be the first thing it shows.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus();
          }}
        >
          <NotificationsPanel
            touch
            onNavigate={close}
            wrapTitle={(title) => <Dialog.Title asChild>{title}</Dialog.Title>}
            headerEnd={
              <Button
                variant="ghost"
                className={styles.close}
                aria-label="Close notifications"
                data-testid="notifications-sheet-close"
                onClick={close}
              >
                <X size={18} />
              </Button>
            }
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

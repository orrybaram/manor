import * as Dialog from "@radix-ui/react-dialog";
import { NotificationsPanel } from "../notifications/NotificationsPopover";
import { PhoneSheet, PhoneSheetClose } from "./PhoneSheet";

type NotificationsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * The phone's notification history: the desk popover's `NotificationsPanel`
 * in a full-height sheet, opened from the drawer's Notifications row (or a
 * pushed notification's `open-notifications` request). `NotificationsPanel`
 * fills it as a column, so its header stays put and only the list scrolls.
 * A row tap navigates and closes the sheet.
 */
export function NotificationsSheet(props: NotificationsSheetProps) {
  const { open, onOpenChange } = props;

  return (
    <PhoneSheet
      open={open}
      onOpenChange={onOpenChange}
      variant="full"
      data-testid="notifications-sheet"
    >
      <NotificationsPanel
        touch
        onNavigate={() => onOpenChange(false)}
        wrapTitle={(title) => <Dialog.Title asChild>{title}</Dialog.Title>}
        headerEnd={
          <PhoneSheetClose
            label="Close notifications"
            data-testid="notifications-sheet-close"
          />
        }
      />
    </PhoneSheet>
  );
}

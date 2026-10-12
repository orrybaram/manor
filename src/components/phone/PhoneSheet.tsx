import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import X from "lucide-react/dist/esm/icons/x";
import { Button } from "../ui/Button/Button";
import styles from "./PhoneSheet.module.css";

type PhoneSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `full` covers the screen; `bottom` rises from the bottom edge, up to 80svh. */
  variant: "full" | "bottom";
  /**
   * A title read to screen readers only, for content that shows none of its
   * own. Without it the children must render a `Dialog.Title`.
   */
  hiddenTitle?: string;
  "data-testid"?: string;
  children: ReactNode;
};

/**
 * A phone sheet that slides up over a dimmed backdrop: the notifications
 * history and the chat's PR drawer. Radix `Dialog` gives it the overlay,
 * Escape and focus handling the sidebar drawer has. The content lays itself
 * out in the sheet's column.
 */
export function PhoneSheet(props: PhoneSheetProps) {
  const { open, onOpenChange, variant, hiddenTitle, children } = props;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.sheet}
          data-variant={variant}
          data-phone-sheet=""
          data-testid={props["data-testid"]}
          aria-describedby={undefined}
          // Focus the sheet, not its first button, whose focus ring and
          // tooltip would be the first thing it shows.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus();
          }}
        >
          {hiddenTitle !== undefined && (
            <VisuallyHidden asChild>
              <Dialog.Title>{hiddenTitle}</Dialog.Title>
            </VisuallyHidden>
          )}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The sheet's close button: an X with a 44px touch target. */
export function PhoneSheetClose(props: { label: string; "data-testid"?: string }) {
  return (
    <Dialog.Close asChild>
      <Button
        variant="ghost"
        className={styles.close}
        aria-label={props.label}
        data-testid={props["data-testid"]}
      >
        <X size={18} />
      </Button>
    </Dialog.Close>
  );
}

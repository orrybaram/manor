import { useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import type { PrInfo } from "../../../lib/pr-info";
import { fetchPrs } from "../../../hooks/usePrWatcher";
import { PrDetails } from "../../sidebar/PrPopover";
import { Button } from "../../ui/Button/Button";
import { Link } from "../../ui/Link/Link";
import styles from "./PhonePrSheet.module.css";

type PhonePrSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pr: PrInfo;
  workspacePath?: string;
  hostId?: string;
};

/**
 * The chat status line's PR drawer: the desk hover card's `PrDetails` in a
 * bottom sheet, with a link out to GitHub. Refetches PRs on open so the
 * checks and comments are fresh.
 */
export function PhonePrSheet(props: PhonePrSheetProps) {
  const { open, onOpenChange, pr, workspacePath, hostId } = props;

  useEffect(() => {
    if (open) void fetchPrs();
  }, [open]);

  const close = () => onOpenChange(false);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.sheet}
          data-testid="phone-pr-sheet"
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus();
          }}
        >
          <div className={styles.header}>
            <Dialog.Title className={styles.srOnly}>{pr.title}</Dialog.Title>
            <Button
              variant="ghost"
              className={styles.close}
              aria-label="Close pull request"
              data-testid="phone-pr-sheet-close"
              onClick={close}
            >
              <X size={18} />
            </Button>
          </div>
          <div className={styles.body}>
            <PrDetails
              pr={pr}
              workspacePath={workspacePath}
              hostId={hostId}
              onSendToAgentStart={close}
            />
            <Link href={pr.url} className={styles.githubLink}>
              Open on GitHub
            </Link>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

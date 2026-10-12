import { useEffect } from "react";
import type { PrInfo } from "../../../lib/pr-info";
import { fetchPrs } from "../../../hooks/usePrWatcher";
import { PrDetails } from "../../sidebar/PrPopover";
import { PhoneSheet, PhoneSheetClose } from "../PhoneSheet";
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
 * bottom sheet (its title links out to GitHub). Refetches PRs on open so the
 * checks and comments are fresh.
 */
export function PhonePrSheet(props: PhonePrSheetProps) {
  const { open, onOpenChange, pr, workspacePath, hostId } = props;

  useEffect(() => {
    if (open) void fetchPrs();
  }, [open]);

  return (
    <PhoneSheet
      open={open}
      onOpenChange={onOpenChange}
      variant="bottom"
      hiddenTitle={pr.title}
      data-testid="phone-pr-sheet"
    >
      <div className={styles.header}>
        <PhoneSheetClose label="Close pull request" data-testid="phone-pr-sheet-close" />
      </div>
      <div className={styles.body}>
        <PrDetails
          pr={pr}
          workspacePath={workspacePath}
          hostId={hostId}
          onSendToAgentStart={() => onOpenChange(false)}
        />
      </div>
    </PhoneSheet>
  );
}

import { useState, useSyncExternalStore } from "react";
import * as Popover from "@radix-ui/react-popover";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import { useConnection } from "../../bridge/connection";
import {
  listPairings,
  removePairing,
  selectPairing,
  subscribePairings,
} from "../../bridge/pairings";
import { Button } from "../ui/Button/Button";
import styles from "./Phone.module.css";

type PhoneHostSwitcherProps = {
  /** Reload the page against whatever is now last used. */
  onReload?: () => void;
};

/**
 * ADR-218 D7: with more than one pairing, the top bar's host switcher. Picking
 * a host marks it last used and reloads the page — a full reload of app state
 * is the slice-1 way to point the bridge at another room. Removing a pairing
 * asks in place (a row swaps to "Remove? Yes / No"); removing the host the
 * page is connected to reloads too, since there is nothing left to dial.
 * Nothing renders for fewer than two pairings.
 */
export function PhoneHostSwitcher(props: PhoneHostSwitcherProps) {
  const { onReload = () => location.reload() } = props;

  const { activeRoomId } = useConnection();
  const pairings = useSyncExternalStore(subscribePairings, listPairings, listPairings);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  if (pairings.length < 2) return null;
  const active = pairings.find((p) => p.roomId === activeRoomId);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setConfirming(null);
      }}
    >
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          className={styles.hostButton}
          aria-label="Switch host"
          aria-haspopup="menu"
          data-testid="phone-host-switcher"
        >
          <span className={styles.hostButtonLabel}>{active?.name ?? "Host"}</span>
          <ChevronDown size={14} />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={`${styles.phoneMenu} ${styles.hostMenu}`}
          data-testid="phone-host-menu"
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {pairings.map((p) => (
            <div className={styles.hostRow} key={p.roomId}>
              {confirming === p.roomId ? (
                <div className={styles.hostConfirm}>
                  <span className={styles.hostConfirmText}>Remove {p.name}?</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="phone-host-remove-confirm"
                    onClick={() => {
                      removePairing(p);
                      setConfirming(null);
                      if (p.roomId === activeRoomId) onReload();
                    }}
                  >
                    Remove
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="phone-host-remove-cancel"
                    onClick={() => setConfirming(null)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    className={`${styles.phoneMenuItem} ${styles.hostSelect}`}
                    aria-current={p.roomId === activeRoomId ? "true" : undefined}
                    data-testid="phone-host-option"
                    onClick={() => {
                      setOpen(false);
                      if (p.roomId === activeRoomId) return;
                      selectPairing(p.roomId);
                      onReload();
                    }}
                  >
                    {p.name}
                  </Button>
                  <Button
                    variant="ghost"
                    className={styles.iconButton}
                    aria-label={`Remove ${p.name}`}
                    data-testid="phone-host-remove"
                    onClick={() => setConfirming(p.roomId)}
                  >
                    <Trash2 size={16} />
                  </Button>
                </>
              )}
            </div>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

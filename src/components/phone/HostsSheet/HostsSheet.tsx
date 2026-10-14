import { useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import {
  declinePairing,
  listPairings,
  renamePairing,
  subscribePairings,
  type StoredPairing,
} from "../../../bridge/pairings";
import { servers, useServers, type ServerEntry } from "../../../bridge/server-set";
import { Button } from "../../ui/Button/Button";
import { EmojiInput } from "../../ui/EmojiAutocomplete";
import { PhoneSheet, PhoneSheetClose } from "../PhoneSheet";
import styles from "./HostsSheet.module.css";

type HostsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * ADR-228 D8: the phone's paired hosts, opened from the drawer's Hosts icon.
 * The page holds every pairing at once (`install-web.ts`), so there is
 * nothing to switch to; the sheet says how each one is doing, renames it,
 * and removes it with an in-place confirm. A removed pairing leaves the page
 * at once — its projects with it — and removing the last one reloads to the
 * pairing screen.
 */
export function HostsSheet(props: HostsSheetProps) {
  const { open, onOpenChange } = props;

  const pairings = useSyncExternalStore(subscribePairings, listPairings, listPairings);
  // Re-read as servers come and go, home moving among them.
  const entries = useServers();

  return (
    <PhoneSheet
      open={open}
      onOpenChange={onOpenChange}
      variant="bottom"
      data-testid="phone-hosts-sheet"
    >
      <div className={styles.header}>
        <Dialog.Title className={styles.title}>Hosts</Dialog.Title>
        <PhoneSheetClose label="Close hosts" data-testid="phone-hosts-close" />
      </div>
      <div className={styles.list}>
        {pairings.length === 0 ? (
          <p className={styles.empty}>This browser isn't paired with any host.</p>
        ) : (
          pairings.map((pairing) => (
            <HostRow
              key={pairing.roomId}
              pairing={pairing}
              server={entries.find((s) => s.id === pairing.roomId)}
              home={servers.homeId === pairing.roomId}
              last={pairings.length === 1}
            />
          ))
        )}
      </div>
    </PhoneSheet>
  );
}

/** How a pairing's server is doing, as the row's `data-state` says it. */
type PairingState = "refused" | "connected" | "unreachable" | "connecting";

/** How a pairing's server is doing, in words. */
function statusOf(server: ServerEntry | undefined): { label: string; state: PairingState } {
  if (server?.outcome === "unauthorized") return { label: "No longer paired", state: "refused" };
  if (server?.outcome === "key-mismatch") {
    return { label: "Pairing key changed", state: "refused" };
  }
  switch (server?.reachability) {
    case "connected":
      return { label: "Connected", state: "connected" };
    case "unreachable":
      return { label: "Not reachable", state: "unreachable" };
    default:
      return { label: "Connecting…", state: "connecting" };
  }
}

type HostRowProps = {
  pairing: StoredPairing;
  /** Its server in the page's set; absent for a moment after it joins. */
  server: ServerEntry | undefined;
  /** It is the page's home server (D1). */
  home: boolean;
  /** It is the only pairing: removing it leaves nothing to show. */
  last: boolean;
};

/** One pairing: its name and state, or its rename field, or the remove confirm. */
function HostRow(props: HostRowProps) {
  const { pairing, server, home, last } = props;

  const [mode, setMode] = useState<"view" | "rename" | "confirm">("view");
  const [name, setName] = useState(pairing.name);
  const status = statusOf(server);

  if (mode === "rename") {
    const save = () => {
      renamePairing(pairing.roomId, name);
      setMode("view");
    };
    return (
      <div className={styles.row} data-testid="phone-host-option" data-room-id={pairing.roomId}>
        <EmojiInput
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              // Cancel the rename, not the sheet.
              e.stopPropagation();
              setMode("view");
            }
          }}
          placeholder="Host name"
          aria-label={`Name for ${pairing.name}`}
          className={styles.nameInput}
          data-testid="phone-host-rename-input"
        />
        <Button
          size="sm"
          variant="ghost"
          data-testid="phone-host-rename-cancel"
          onClick={() => setMode("view")}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          data-testid="phone-host-rename-save"
          disabled={!name.trim()}
          onClick={save}
        >
          Save
        </Button>
      </div>
    );
  }

  if (mode === "confirm") {
    return (
      <div className={styles.row} data-testid="phone-host-option" data-room-id={pairing.roomId}>
        <span className={styles.confirmText}>
          {last ? `Remove ${pairing.name}? You'll need a new link.` : `Remove ${pairing.name}?`}
        </span>
        <Button
          size="sm"
          variant="ghost"
          data-testid="phone-host-remove-cancel"
          onClick={() => setMode("view")}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          variant="danger"
          data-testid="phone-host-remove-confirm"
          onClick={() => declinePairing(pairing)}
        >
          Remove
        </Button>
      </div>
    );
  }

  return (
    <div
      className={styles.row}
      data-testid="phone-host-option"
      data-room-id={pairing.roomId}
      data-state={status.state}
      aria-current={home ? "true" : undefined}
    >
      <span className={styles.dot} data-state={status.state} aria-hidden />
      <span className={styles.text}>
        <span className={styles.name}>{pairing.name}</span>
        <span className={styles.status} data-testid="phone-host-status">
          {status.label}
          {server?.hello.hostServer === false && " · Desktop"}
        </span>
      </span>
      <Button
        variant="ghost"
        className={styles.iconButton}
        aria-label={`Rename ${pairing.name}`}
        data-testid="phone-host-rename"
        onClick={() => {
          setName(pairing.name);
          setMode("rename");
        }}
      >
        <Pencil size={16} />
      </Button>
      <Button
        variant="ghost"
        className={styles.iconButton}
        aria-label={`Remove ${pairing.name}`}
        data-testid="phone-host-remove"
        onClick={() => setMode("confirm")}
      >
        <Trash2 size={16} />
      </Button>
    </div>
  );
}

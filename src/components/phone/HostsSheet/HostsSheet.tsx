import { useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import {
  connectRoomDirectly,
  declinePairing,
  listPairings,
  renamePairing,
  subscribePairings,
  type StoredPairing,
} from "../../../bridge/pairings";
import { servers, useServers, type ServerEntry } from "../../../bridge/server-set";
import { useHostStore, type HostStatusInfo } from "../../../store/host-store";
import { hostName, isRemoteHost } from "../../../lib/hosts";
import { ipcErrorMessage } from "../../../lib/ipc-error";
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
 *
 * ADR-229 D7: a host its desktop reports asleep reads **Asleep**, with
 * **Wake**, which asks the desktop to start it (`hosts.wake` on home). Only
 * a desktop can start a box, so with none reachable the row says so instead.
 */
export function HostsSheet(props: HostsSheetProps) {
  const { open, onOpenChange } = props;

  const pairings = useSyncExternalStore(subscribePairings, listPairings, listPairings);
  // Re-read as servers come and go, home moving among them.
  const entries = useServers();
  // Home's host list: on a phone each host goes by its room (ADR-228 D2).
  const hosts = useHostStore((s) => s.hosts);
  const homeEntry = entries.find((s) => s.id === servers.homeId);
  const desktopName = desktopNameOf(pairings, homeEntry);

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
              asleep={asleepOf(pairing, hosts, homeEntry, desktopName)}
            />
          ))
        )}
        {indirectHosts(hosts, pairings).map((host) => (
          <IndirectHostRow
            key={host.hostId}
            host={host}
            desktopName={desktopName}
            desktopReachable={homeEntry?.reachability === "connected"}
          />
        ))}
      </div>
    </PhoneSheet>
  );
}

/**
 * The desktop's remote hosts this browser holds no pairing of its own for:
 * reached only through the desktop, so gone whenever it sleeps. Usually a
 * room it declined — removed here, or refused once by the host.
 */
function indirectHosts(
  hosts: readonly HostStatusInfo[],
  pairings: readonly StoredPairing[],
): HostStatusInfo[] {
  return hosts.filter(
    (h) =>
      isRemoteHost(h.hostId) &&
      !pairings.some((p) => p.roomId === h.hostId || p.roomId === h.roomId),
  );
}

/**
 * A host reached only through the desktop. **Connect directly** asks the
 * desktop for a pairing of this browser's own there, so it stays reachable
 * with the desktop asleep. Only a desktop can mint one, and only for a host
 * with a relay room.
 */
function IndirectHostRow(props: {
  host: HostStatusInfo;
  desktopName: string;
  desktopReachable: boolean;
}) {
  const { host, desktopName, desktopReachable } = props;
  const [linking, setLinking] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  const roomId = host.roomId ?? null;
  const connect = () => {
    if (roomId === null) return;
    setLinking({ busy: true, error: null });
    connectRoomDirectly(roomId).then(
      // Linked, its pairing joins the list above and this row goes.
      () =>
        setLinking({
          busy: false,
          error: `${desktopName} couldn't pair this phone with it yet`,
        }),
      (err: unknown) => setLinking({ busy: false, error: ipcErrorMessage(err) }),
    );
  };
  const label = linking.busy
    ? "Connecting…"
    : (linking.error ??
      (roomId === null
        ? `Only through ${desktopName} · no relay`
        : `Only through ${desktopName}`));

  return (
    <div
      className={styles.row}
      data-testid="phone-host-indirect"
      data-host-id={host.hostId}
      data-state="indirect"
    >
      <span className={styles.dot} data-state="indirect" aria-hidden />
      <span className={styles.text}>
        <span className={styles.name}>{hostName(host)}</span>
        <span className={styles.status}>{label}</span>
      </span>
      {roomId !== null && (
        <Button
          size="sm"
          variant="secondary"
          data-testid="phone-host-connect-directly"
          disabled={linking.busy || !desktopReachable}
          onClick={connect}
        >
          Connect directly
        </Button>
      )}
    </div>
  );
}

/** What a desktop is called here: home's pairing when it is one, else any desktop's. */
function desktopNameOf(
  pairings: readonly StoredPairing[],
  home: ServerEntry | undefined,
): string {
  const homePairing = pairings.find((p) => p.roomId === home?.roomId);
  if (home && !home.hello.hostServer && homePairing) return homePairing.name;
  return pairings.find((p) => p.hostServer === false)?.name ?? "the desktop";
}

/**
 * A host asleep (ADR-229 D7), as home's host list says: whether home can
 * wake it — a desktop, reachable, that lists the host — and, when it
 * cannot, which desktop is away. Undefined for a pairing that is not asleep.
 */
type Asleep = { canWake: true } | { canWake: false; desktopName: string };

function asleepOf(
  pairing: StoredPairing,
  hosts: readonly HostStatusInfo[],
  home: ServerEntry | undefined,
  desktopName: string,
): Asleep | undefined {
  const host = hosts.find((h) => h.hostId === pairing.roomId);
  if (host?.status !== "sleeping") return undefined;
  const lists = home?.lists === "all" || home?.lists.has(pairing.roomId) === true;
  const reachable = home?.reachability === "connected" && !home.hello.hostServer;
  return reachable && lists ? { canWake: true } : { canWake: false, desktopName };
}

/** How a pairing's server is doing, as the row's `data-state` says it. */
type PairingState = "refused" | "connected" | "unreachable" | "connecting" | "asleep";

/** How a pairing's server is doing, in words. */
function statusOf(
  pairing: StoredPairing,
  server: ServerEntry | undefined,
  asleep: Asleep | undefined,
): { label: string; state: PairingState } {
  // Its own bridge answers: it is up, whatever home last said.
  if (asleep && server?.reachability !== "connected") {
    return {
      label: asleep.canWake ? "Asleep" : `${pairing.name} is asleep, and ${asleep.desktopName} is away`,
      state: "asleep",
    };
  }
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
  /** Its host is asleep, as home's host list says (ADR-229 D7). */
  asleep: Asleep | undefined;
};

/** One pairing: its name and state, or its rename field, or the remove confirm. */
function HostRow(props: HostRowProps) {
  const { pairing, server, home, last, asleep } = props;

  const [mode, setMode] = useState<"view" | "rename" | "confirm">("view");
  const [name, setName] = useState(pairing.name);
  const [waking, setWaking] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  const status = statusOf(pairing, server, asleep);
  const wake = () => {
    setWaking({ busy: true, error: null });
    window.electronAPI.hosts.wake(pairing.roomId).then(
      () => setWaking({ busy: false, error: null }),
      (err: unknown) => setWaking({ busy: false, error: ipcErrorMessage(err) }),
    );
  };

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
          {waking.busy ? "Waking…" : (waking.error ?? status.label)}
          {server?.hello.hostServer === false && " · Desktop"}
        </span>
      </span>
      {status.state === "asleep" && asleep?.canWake && (
        <Button
          size="sm"
          variant="secondary"
          data-testid="phone-host-wake"
          disabled={waking.busy}
          onClick={wake}
        >
          Wake
        </Button>
      )}
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

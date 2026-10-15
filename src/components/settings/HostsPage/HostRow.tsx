import { useState, type ReactNode } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Moon from "lucide-react/dist/esm/icons/moon";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import type { HostServerStatus, HostServerView } from "../../../electron.d";
import { useHostDisplay } from "../../../hooks/useHostDisplay";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { pendingDisplay, type HostTone } from "../../../lib/host-status";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { useHostStore, type HostStatusInfo } from "../../../store/host-store";
import { useRemoteControlStore } from "../../../store/remote-control-store";
import { Button } from "../../ui/Button/Button";
import { Collapse } from "../../ui/Collapse/Collapse";
import { Link } from "../../ui/Link/Link";
import { Switch } from "../../ui/Switch/Switch";
import { CopySshCommand } from "../../hosts/HostCard";
import { HostStateIcon } from "../../hosts/HostStateIcon";
import { HostRetryButton, HostWakeButton } from "../../hosts/HostStatusDetails";
import { ResetRelayDialog } from "../RemoteControlDialogs";
import { isSupervised } from "../reach";
import { SettingRow } from "../SettingRow";
import { useSettingsJump } from "../SettingsModal/settings-nav";
import { RemoveHostDialog } from "./RemoveHostDialog";
import { idleStopText, supervisionHint, supervisorStatusText } from "./host-settings-text";
import settingsStyles from "../SettingsModal/SettingsModal.module.css";
import styles from "./HostsPage.module.css";

/** How the Hosts page names this computer in "only while … is awake". */
const DESKTOP_NAME = "This Mac";

/** Where enabling systemd-creds on a host is explained (ADR-225 D6). */
const SECRETS_DOCS_URL =
  "https://github.com/orrybaram/manor/blob/main/docs/remote-hosts.md#encrypting-pairing-keys";

type HostRowProps = {
  host: HostStatusInfo;
  /** How the host is named (`hostName`). */
  name: string;
  /** A browser: the host's status and Wake, nothing that is the desktop's to do. */
  readOnly: boolean;
};

/**
 * One remote host on the Hosts page (ADR-233 D1): a header with its state
 * and device reach in one line, and behind it everything about the host —
 * whether devices can reach it, its supervision, its pairing-key warnings,
 * its integrations, and what its provider lets Manor do to it.
 *
 * Its section is `host-<id>`, so a link can open it.
 */
export function HostRow(props: HostRowProps) {
  const { host, name, readOnly } = props;

  const { hostId } = host;
  const sectionId = `host-${hostId}`;
  const reported = useHostDisplay(hostId);
  const display = reported ?? pendingDisplay(hostId);
  const view = useHostStore((s) => s.servers[hostId]) ?? null;
  const deviceCount = useRemoteControlStore((s) => s.status.devices.length);

  const [dialog, setDialog] = useState<"remove" | "reset" | null>(null);
  const [action, setAction] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  const { busy, error } = action;

  // Whether this computer has a Linear key to hand the host (ADR-227 D7).
  const [desktopLinear, setDesktopLinear] = useState(false);

  useMountEffect(() => {
    // The switches read the server's view; a browser can't ask.
    if (readOnly) return;
    void useHostStore.getState().refreshServer(hostId);
    const refresh = () => void window.electronAPI.linear.isConnected().then(setDesktopLinear);
    refresh();
    // The key was saved or cleared elsewhere (ADR-230 D8).
    return window.electronAPI.linear.onConnectionChanged(refresh);
  });

  const run = (work: () => Promise<void>) => {
    setAction({ busy: true, error: null });
    work().then(
      () => setAction({ busy: false, error: null }),
      (err: unknown) => setAction({ busy: false, error: ipcErrorMessage(err) }),
    );
  };

  const connected = host.status === "connected";
  const canStop = host.capabilities?.canStop === true && connected;
  const missing = host.status === "error" && host.missing === true;
  const status = view?.status ?? null;

  // `supervise` is the container's entrypoint: there is nothing to turn off.
  const inContainer = view?.supervisor?.kind === "container";
  const supervised = isSupervised(view);
  const supervisorLine = supervisorStatusText(view?.supervisor ?? null, name, host.spec);
  const hint = supervisionHint(view, name, connected);

  const summary = display.summary ?? display.detail;
  const asleep = display.tone === "asleep";

  return (
    <HostRowShell
      sectionId={sectionId}
      testId="host-entry"
      hostId={hostId}
      bodyTestId="host-phone-access"
      icon={<HostStateIcon display={display} size={15} />}
      tone={display.tone}
      name={name}
      status={
        <>
          {statusLine(display.status, readOnly ? null : view)}
          {keyWarnings(status).map((warning) => (
            <span key={warning} className={styles.rowWarning}>
              {" · "}
              {warning}
            </span>
          ))}
        </>
      }
      headerActions={
        (display.canRetry || asleep) && (
          <>
            {display.canRetry && <HostRetryButton hostId={hostId} />}
            {asleep && <HostWakeButton hostId={hostId} />}
          </>
        )
      }
      footer={
        !readOnly && (
          <>
            {status && (
              <Button
                size="sm"
                variant="ghost"
                data-testid="host-reset-keys"
                disabled={busy}
                onClick={() => setDialog("reset")}
              >
                Reset pairing keys…
              </Button>
            )}
            {display.sshTarget && <CopySshCommand target={display.sshTarget} />}
            {canStop && (
              <Button
                size="sm"
                variant="secondary"
                data-testid="host-stop"
                disabled={busy}
                onClick={() => run(() => useHostStore.getState().stop(hostId))}
              >
                <Moon size={11} aria-hidden className={styles.buttonIcon} />
                Stop
              </Button>
            )}
            {missing && (
              <Button
                size="sm"
                variant="primary"
                data-testid="host-start-again"
                disabled={busy}
                onClick={() => run(() => useHostStore.getState().wake(hostId))}
              >
                <RotateCcw size={11} aria-hidden className={styles.buttonIcon} />
                Start it again
              </Button>
            )}
            <span className={styles.spacer} />
            <Button
              size="sm"
              variant="ghost"
              data-testid="host-remove"
              disabled={busy}
              onClick={() => setDialog("remove")}
            >
              <Trash2 size={11} aria-hidden className={styles.buttonIcon} />
              Remove…
            </Button>
          </>
        )
      }
      dialogs={
        !readOnly && (
          <>
            <RemoveHostDialog
              open={dialog === "remove"}
              hostId={hostId}
              hostName={name}
              canDestroy={host.capabilities?.canDestroy === true}
              onRemove={(destroy) => useHostStore.getState().removeHost(hostId, destroy)}
              onClose={() => setDialog(null)}
            />
            <ResetRelayDialog
              open={dialog === "reset"}
              devices={view?.devices.length ?? 0}
              hostName={name}
              onCancel={() => setDialog(null)}
              onConfirm={() => {
                setDialog(null);
                run(async () => {
                  await window.electronAPI.hosts.resetPairingKeys(hostId);
                });
              }}
            />
          </>
        )
      }
    >
      {summary && (
        <div className={`${styles.rowSummary} ${styles[display.tone]}`}>{summary}</div>
      )}

      <div className={styles.group}>
        <div className={styles.groupLabel}>Device access</div>
        {!readOnly && view !== null && (
          <SettingRow
            label={`Devices can reach ${name}`}
            hint={`${devicesReach(deviceCount)} ${name} directly, so they keep working while this Mac sleeps.`}
          >
            <Switch
              data-testid="host-link-phones-toggle"
              checked={view.linkPhones}
              disabled={busy}
              onCheckedChange={(on) =>
                run(() => useHostStore.getState().setLinkPhones(hostId, on))
              }
            />
          </SettingRow>
        )}
        {!readOnly && (
          <SettingRow
            label={`Keep running when ${name} restarts`}
            hint={<span data-testid="host-supervisor-status">{supervisorLine ?? hint}</span>}
          >
            <Switch
              data-testid="host-supervise-toggle"
              checked={supervised}
              disabled={!connected || busy || view === null || inContainer}
              onCheckedChange={(on) =>
                run(() => useHostStore.getState().setSupervised(hostId, on))
              }
            />
          </SettingRow>
        )}
        {status && <KeyWarnings status={status} hostName={name} />}
        {host.idleStopNote && (
          <div className={settingsStyles.fieldHint} data-testid="host-idle-stop-note">
            {idleStopText(host.idleStopMinutes, DESKTOP_NAME)}
          </div>
        )}
        {!readOnly && status === null && (
          <div className={settingsStyles.fieldHint} data-testid="host-phone-access-state">
            {mutedLine(view?.state ?? null)}
          </div>
        )}
      </div>

      {!readOnly && status && (desktopLinear || status.linear) && (
        <div className={styles.group}>
          <div className={styles.groupLabel}>Integrations</div>
          <SettingRow
            label="Linear"
            hint={`Copies this Mac's Linear key to ${name}, so devices can browse and start issues there while this Mac sleeps.`}
          >
            <Switch
              data-testid="host-linear-toggle"
              checked={status.linear}
              disabled={busy}
              onCheckedChange={(on) =>
                run(async () => {
                  await window.electronAPI.hosts.setLinearOnHost(hostId, on);
                })
              }
            />
          </SettingRow>
        </div>
      )}

      {error && (
        <div className={settingsStyles.linearError} data-testid="host-entry-error">
          {error}
        </div>
      )}
    </HostRowShell>
  );
}

type HostRowShellProps = {
  /** The row's `data-settings-section`; a jump to it opens the row. */
  sectionId: string;
  testId: string;
  /** Set on the row as `data-host-id`, for a remote host. */
  hostId?: string;
  bodyTestId?: string;
  /** The header's tile. */
  icon: ReactNode;
  /** Colours the tile and the status dot; neutral when null. */
  tone: HostTone | null;
  name: string;
  /** The header's one line, after the dot. */
  status: ReactNode;
  /** Buttons that sit beside the header, outside the toggle. */
  headerActions?: ReactNode;
  /** The buttons along the bottom of the open row. */
  footer?: ReactNode;
  /** Dialogs the row opens; portalled, so outside the collapsing body. */
  dialogs?: ReactNode;
  /** The open row's groups. */
  children: ReactNode;
};

/**
 * What every row on the Hosts page shares (ADR-233 D1, D2): the header that
 * opens and closes it, the collapsing body and its footer. Collapsed until
 * opened, or until a link jumps to its section.
 */
export function HostRowShell(props: HostRowShellProps) {
  const {
    sectionId,
    testId,
    hostId,
    bodyTestId,
    icon,
    tone,
    name,
    status,
    headerActions,
    footer,
    dialogs,
    children,
  } = props;

  // A link to this row opens it, whether the page mounts with the jump or
  // already shows it.
  const jump = useSettingsJump();
  const [open, setOpen] = useState(jump === sectionId);
  const [seenJump, setSeenJump] = useState(jump);
  if (jump !== seenJump) {
    setSeenJump(jump);
    if (jump === sectionId) setOpen(true);
  }

  const toneClass = tone ? styles[tone] : "";

  return (
    <div className={styles.hostRow} data-testid={testId} data-host-id={hostId}>
      <div className={styles.rowHeader}>
        <Button
          variant="ghost"
          className={styles.rowToggle}
          aria-expanded={open}
          data-testid="host-row-toggle"
          data-settings-section={sectionId}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`${styles.rowIcon} ${toneClass}`}>{icon}</span>
          <span className={styles.rowText}>
            <span className={styles.rowName}>{name}</span>
            <span className={styles.rowStatus} data-testid="host-row-status">
              <span className={`${styles.statusDot} ${toneClass}`} aria-hidden />
              {status}
            </span>
          </span>
          <ChevronRight
            size={14}
            aria-hidden
            className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
          />
        </Button>
        {headerActions && <div className={styles.rowHeaderActions}>{headerActions}</div>}
      </div>
      <Collapse open={open}>
        <div className={styles.rowBody} data-testid={bodyTestId}>
          {children}
          {footer && <div className={styles.rowFooter}>{footer}</div>}
        </div>
      </Collapse>
      {dialogs}
    </div>
  );
}

/**
 * The header's line: the host's state, then whether devices reach it —
 * "anytime" only when its Manor survives a restart. Left out until the
 * server's view is known.
 */
function statusLine(state: string, view: HostServerView | null): string {
  if (!view) return state;
  const supervised = isSupervised(view);
  const reach = !view.linkPhones
    ? "devices off"
    : supervised
      ? "devices reach it anytime"
      : "devices reach it";
  return `${state} · ${reach}`;
}

/** The pairing-key warnings the header repeats, in a few words each. */
function keyWarnings(status: HostServerStatus | null): string[] {
  if (!status) return [];
  const warnings: string[] = [];
  if (status.secretBackend === "plaintext") warnings.push("pairing keys unencrypted");
  if (status.secretKeyOnVolume) warnings.push("pairing key stored on its disk");
  return warnings;
}

/** "Your 2 devices reach", or, with none paired yet, "Devices you pair reach". */
function devicesReach(count: number): string {
  if (count === 0) return "Devices you pair reach";
  return `Your ${count} device${count === 1 ? "" : "s"} reach`;
}

/** The one muted line for a host whose server cannot be asked right now. */
function mutedLine(state: HostServerView["state"] | null): string {
  if (state === null) return "Checking device access…";
  if (state === "idle" || state === "connecting") return "Updating…";
  return "Device access needs the host to reconnect";
}

type KeyWarningsProps = {
  status: HostServerStatus;
  hostName: string;
};

/**
 * What the host's server says about itself: its version and relay, and
 * where its pairing keys are kept when that is worth a warning (ADR-225 D6).
 */
function KeyWarnings(props: KeyWarningsProps) {
  const { status, hostName } = props;

  return (
    <>
      <div className={settingsStyles.fieldHint} data-testid="host-phone-summary">
        Manor {status.version} ·{" "}
        {status.relay.connected ? "relay connected" : "relay not connected"}
        {!status.relay.connected && status.relay.error ? ` (${status.relay.error})` : ""}
      </div>
      {status.secretKeyOnVolume && (
        <div className={settingsStyles.remoteWarning} data-testid="host-key-on-volume">
          <ShieldAlert size={14} />
          <span>
            The key sealing pairing keys on {hostName} is stored on its own disk.{" "}
            <Link href={SECRETS_DOCS_URL}>How to keep it elsewhere</Link>
          </span>
        </div>
      )}
      {status.identityReset === "cloned" && (
        <div className={settingsStyles.fieldHint} data-testid="host-identity-reset">
          {hostName} was copied from another machine, so it got new pairing keys. Devices
          paired with this Mac re-link on their own.
        </div>
      )}
      {status.secretBackend === "plaintext" && (
        <div className={settingsStyles.remoteWarning} data-testid="host-plaintext-keys">
          <ShieldAlert size={14} />
          <span>
            Pairing keys on {hostName} are stored unencrypted.{" "}
            <Link href={SECRETS_DOCS_URL}>How to encrypt them</Link>
          </span>
        </div>
      )}
    </>
  );
}

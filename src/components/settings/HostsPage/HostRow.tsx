import { useEffect, useRef, useState, type ReactNode } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Moon from "lucide-react/dist/esm/icons/moon";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import Shield from "lucide-react/dist/esm/icons/shield";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import type { HostServerStatus, HostServerView } from "../../../electron.d";
import { useHostDisplay } from "../../../hooks/useHostDisplay";
import { pendingDisplay, type HostTone } from "../../../lib/host-status";
import { useHostStore, type HostStatusInfo } from "../../../store/host-store";
import { useRemoteControlStore } from "../../../store/remote-control-store";
import { Button } from "../../ui/Button/Button";
import { Collapse } from "../../ui/Collapse/Collapse";
import { SpinnerLoader } from "../../ui/SpinnerLoader/SpinnerLoader";
import { Link } from "../../ui/Link/Link";
import { Switch } from "../../ui/Switch/Switch";
import { CopySshCommand } from "../../hosts/CopySshCommand";
import { HostStateIcon } from "../../hosts/HostStateIcon";
import { HostFailureAction, HostRawOutput, HostRetryButton, HostWakeButton } from "../../hosts/HostStatusDetails";
import { ResetRelayDialog } from "../RemoteControlDialogs";
import { isSupervised } from "../reach";
import { SettingRow } from "../SettingRow";
import { useSettingsJump } from "../SettingsModal/settings-nav";
import { RemoveHostDialog } from "./RemoveHostDialog";
import {
  blockedDevicesLine,
  devicesReachText,
  idleStopText,
  pairingKeysState,
  supervisionHint,
  supervisorStatusText,
  type KeyFix,
  type PairingKeysTone,
} from "./host-settings-text";
import { useHostAction, useHostSettings, type RunAction } from "./useHostSettings";
import settingsStyles from "../SettingsModal/SettingsModal.module.css";
import styles from "./HostsPage.module.css";

/** How the Hosts page names this computer in "only while … is awake". */
const DESKTOP_NAME = "This Mac";

/** Where enabling systemd-creds on a host is explained. */
const SECRETS_DOCS_URL =
  "https://github.com/orrybaram/manor/blob/main/docs/remote-hosts.md#encrypting-pairing-keys";

/** Where a recipe giving its host a key is explained. */
const RECIPE_SECRETS_DOCS_URL =
  "https://github.com/orrybaram/manor/blob/main/docs/hosts/recipes.md#pairing-key-encryption";

/** Where giving a container a key from its environment is explained. */
const CONTAINER_SECRETS_DOCS_URL =
  "https://github.com/orrybaram/manor/blob/main/docs/remote-hosts.md#a-key-from-outside-the-box";

type HostRowProps = {
  host: HostStatusInfo;
  /** How the host is named (`hostName`). */
  name: string;
  /** A browser: the host's status and Wake, nothing that is the desktop's to do. */
  readOnly: boolean;
};

/**
 * One remote host on the Hosts page: a header with its state
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
  const { view, desktopLinear } = useHostSettings(hostId, readOnly);
  const { busy, error, run } = useHostAction();

  const [dialog, setDialog] = useState<"remove" | "reset" | null>(null);

  const connected = host.status === "connected";
  const canStop = host.capabilities?.canStop === true && connected;
  const missing = host.status === "error" && host.missing === true;
  const status = view?.status ?? null;

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
      <HostFailureAction display={display} hostId={hostId} showRetry={false} />
      <HostRawOutput display={display} />

      <HostDeviceAccess host={host} name={name} readOnly={readOnly} view={view} busy={busy} run={run} />
      <HostIntegrations
        hostId={hostId}
        name={name}
        readOnly={readOnly}
        view={view}
        desktopLinear={desktopLinear}
        busy={busy}
        run={run}
      />

      {error && (
        <div className={settingsStyles.linearError} data-testid="host-entry-error">
          {error}
        </div>
      )}
    </HostRowShell>
  );
}

type HostDeviceAccessProps = {
  host: HostStatusInfo;
  name: string;
  readOnly: boolean;
  view: HostServerView | null;
  busy: boolean;
  run: RunAction;
  /**
   * Encrypt plaintext pairing keys without being asked, once, as soon as the
   * host can: the Add a host wizard's last step does this for a
   * host Manor just set up.
   */
  autoEncrypt?: boolean;
};

/**
 * A host's Device access group: whether devices reach it, what
 * keeps its Manor running, the state of its pairing keys. Shared by its row
 * and the Add a host wizard's last step.
 */
export function HostDeviceAccess(props: HostDeviceAccessProps) {
  const { host, name, readOnly, view, busy, run, autoEncrypt = false } = props;

  const { hostId } = host;
  const pairedDevices = useRemoteControlStore((s) => s.status.devices);
  // Devices removed on this host don't reach it, so they aren't counted.
  const blockedIds = new Set(view?.blockedDevices.map((d) => d.id));
  const deviceCount = pairedDevices.filter((d) => !blockedIds.has(d.id)).length;

  const connected = host.status === "connected";
  const status = view?.status ?? null;

  // Whether, and how, the plaintext warning can be fixed from here.
  const inContainer = view?.supervisor?.kind === "container";
  const fix: KeyFix =
    host.providerKind === "recipe"
      ? "recipe"
      : inContainer
        ? "container"
        : !readOnly && connected && view?.state === "connected"
          ? "button"
          : "none";

  // `supervise` is the container's entrypoint: there is nothing to turn off.
  const supervised = isSupervised(view);
  const supervisorLine = supervisorStatusText(view?.supervisor ?? null, name, host.spec);
  const hint = supervisionHint(view, name, connected);

  return (
    <div className={styles.group} data-testid="host-device-access">
      <div className={styles.groupLabel}>Device access</div>
      {!readOnly && view !== null && (
        <SettingRow
          label={`Devices can reach ${name}`}
          hint={`${devicesReachText(deviceCount)} ${name} directly, so they keep working while this Mac sleeps.`}
        >
          <Switch
            data-testid="host-link-phones-toggle"
            checked={view.linkPhones}
            disabled={busy}
            onCheckedChange={(on) => run(() => useHostStore.getState().setLinkPhones(hostId, on))}
          />
        </SettingRow>
      )}
      {!readOnly && view !== null && view.blockedDevices.length > 0 && (
        <p className={styles.blockedHint} data-testid="host-blocked-devices">
          {blockedDevicesLine(
            view.blockedDevices.map((d) => d.label),
            name,
          )}
        </p>
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
            onCheckedChange={(on) => run(() => useHostStore.getState().setSupervised(hostId, on))}
          />
        </SettingRow>
      )}
      {status && (
        <PairingKeys
          status={status}
          hostId={hostId}
          hostName={name}
          fix={fix}
          busy={busy}
          run={run}
          autoEncrypt={autoEncrypt && host.providerKind === "ssh"}
        />
      )}
      {host.idleStopNote && (
        <div className={settingsStyles.fieldHint} data-testid="host-idle-stop-note">
          {idleStopText(host.idleStopMinutes, DESKTOP_NAME)}
        </div>
      )}
      {!readOnly && status === null && (
        <div className={settingsStyles.fieldHint} data-testid="host-phone-access-state">
          {mutedLine(host.status, view?.state ?? null, name)}
        </div>
      )}
    </div>
  );
}

type HostIntegrationsProps = {
  hostId: string;
  name: string;
  readOnly: boolean;
  view: HostServerView | null;
  /** This computer has a Linear key to hand the host. */
  desktopLinear: boolean;
  busy: boolean;
  run: RunAction;
};

/**
 * A host's Integrations group: today only Linear, shown when
 * this computer has it or the host already holds a copy. Nothing otherwise.
 */
export function HostIntegrations(props: HostIntegrationsProps) {
  const { hostId, name, readOnly, view, desktopLinear, busy, run } = props;

  const status = view?.status ?? null;
  if (readOnly || !status || !(desktopLinear || status.linear)) return null;

  return (
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
  /** Open on mount, before any jump; a lone project's only row. */
  defaultOpen?: boolean;
  /** A third line under the status: the project's path on this host. */
  detail?: ReactNode;
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
 * What every row on the Hosts page shares: the header that
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
    defaultOpen = false,
    detail,
    headerActions,
    footer,
    dialogs,
    children,
  } = props;

  // A link to this row opens it, whether the page mounts with the jump or
  // already shows it.
  const jump = useSettingsJump();
  const [open, setOpen] = useState(defaultOpen || jump === sectionId);
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
            {detail && <span className={styles.rowDetail}>{detail}</span>}
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

/** The pairing-key warning the header repeats, in a few words. */
function keyWarnings(status: HostServerStatus | null): string[] {
  if (!status) return [];
  const warning = pairingKeysState(status, "none", "").headerWarning;
  return warning ? [warning] : [];
}

/**
 * The one muted line for a host whose server cannot be asked right now. A
 * host that isn't connected has no server to ask: its server stays idle, so
 * "Updating…" would never resolve.
 */
function mutedLine(
  hostStatus: HostStatusInfo["status"],
  state: HostServerView["state"] | null,
  name: string,
): string {
  if (hostStatus === "connecting") return `Waiting for ${name} to connect…`;
  if (hostStatus !== "connected") return `Device access needs ${name} connected`;
  if (state === null) return "Checking device access…";
  if (state === "idle" || state === "connecting") return "Updating…";
  return "Device access needs the host to reconnect";
}

type PairingKeysProps = {
  status: HostServerStatus;
  hostId: string;
  hostName: string;
  fix: KeyFix;
  busy: boolean;
  run: RunAction;
  autoEncrypt: boolean;
};

const PILL_ICONS: Record<PairingKeysTone, ReactNode> = {
  caution: <ShieldAlert size={11} aria-hidden />,
  ok: <ShieldCheck size={11} aria-hidden />,
  partial: <Shield size={11} aria-hidden />,
  busy: <SpinnerLoader size="pane" />,
};

/**
 * The Pairing keys row: the keys' state as a pill, one line on
 * it, the caveats behind a disclosure, and **Encrypt** where Manor can do it.
 * Then what the host's server says about itself.
 */
function PairingKeys(props: PairingKeysProps) {
  const { status, hostId, hostName, fix, busy, run, autoEncrypt } = props;

  // An Encrypt click in flight: `busy` alone is every action's.
  const [encrypting, setEncrypting] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const encrypt = () =>
    run(async () => {
      setEncrypting(true);
      try {
        await useHostStore.getState().encryptKeys(hostId);
      } finally {
        setEncrypting(false);
      }
    });

  // Once per host: a new ssh host gets its key as soon as its server can take
  // one. A failure leaves the row with its button, and the error below it.
  const autoTried = useRef(false);
  const canAuto = autoEncrypt && fix === "button" && status.secretBackend === "plaintext" && !busy;
  useEffect(() => {
    if (!canAuto || autoTried.current) return;
    autoTried.current = true;
    encrypt();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once, when the host first can
  }, [canAuto]);

  const keys = pairingKeysState(status, fix, hostName, encrypting);
  const control =
    keys.tone === "busy" || (keys.tone === "caution" && fix === "button") ? (
      <Button
        size="sm"
        variant="primary"
        data-testid="host-encrypt-keys"
        disabled={busy}
        onClick={encrypt}
      >
        Encrypt
      </Button>
    ) : fix === "recipe" && keys.tone === "caution" ? (
      <Link href={RECIPE_SECRETS_DOCS_URL} data-testid="host-encrypt-recipe">
        How
      </Link>
    ) : fix === "container" && keys.tone === "caution" ? (
      <Link href={CONTAINER_SECRETS_DOCS_URL} data-testid="host-encrypt-container">
        How
      </Link>
    ) : keys.tone === "partial" ? (
      <Link href={SECRETS_DOCS_URL} data-testid="host-key-on-volume">
        Move it out
      </Link>
    ) : null;

  return (
    <>
      <SettingRow
        plain
        data-testid="host-pairing-keys"
        label={
          <span className={settingsStyles.settingLabelRow}>
            Pairing keys
            <span
              className={settingsStyles.statePill}
              data-tone={keys.tone}
              data-testid="host-pairing-keys-state"
            >
              {PILL_ICONS[keys.tone]}
              {keys.state}
            </span>
          </span>
        }
        hint={
          <>
            <span data-testid="host-pairing-keys-hint">{keys.hint}</span>
            {keys.detail && (
              <>
                {" "}
                <Button
                  variant="link"
                  data-testid="host-pairing-keys-more"
                  aria-expanded={detailOpen}
                  onClick={() => setDetailOpen((open) => !open)}
                >
                  {detailOpen ? "Less" : "What this protects"}
                </Button>
                <Collapse open={detailOpen}>
                  <span className={settingsStyles.settingDetail} data-testid="host-pairing-keys-detail">
                    {keys.detail}
                  </span>
                </Collapse>
              </>
            )}
          </>
        }
      >
        {control}
      </SettingRow>
      {status.identityReset === "cloned" && (
        <div className={settingsStyles.fieldHint} data-testid="host-identity-reset">
          {hostName} was copied from another machine, so it got new pairing keys. Devices
          paired with this Mac re-link on their own.
        </div>
      )}
      <div className={settingsStyles.fieldHint} data-testid="host-phone-summary">
        Manor {status.version} ·{" "}
        {status.relay.connected ? "relay connected" : "relay not connected"}
        {!status.relay.connected && status.relay.error ? ` (${status.relay.error})` : ""}
      </div>
    </>
  );
}

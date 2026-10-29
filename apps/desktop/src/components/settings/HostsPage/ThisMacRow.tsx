import { useState } from "react";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import type { HostTone } from "../../../lib/host-status";
import { isWebApp } from "../../../lib/platform";
import { useRemoteControlStore } from "../../../store/remote-control-store";
import { Button } from "../../ui/Button/Button";
import { Switch } from "../../ui/Switch/Switch";
import { RelayConfirmDialog, ResetRelayDialog } from "../RemoteControlDialogs";
import { SettingRow } from "../SettingRow";
import { describe, isOn, type StatusView } from "../remote-control-status";
import { HostRowShell } from "./HostRow";
import settingsStyles from "../SettingsModal/SettingsModal.module.css";
import styles from "./HostsPage.module.css";

/** The row's section, so a link can open it. */
export const LOCAL_HOST_SECTION = "host-local";

const TONE: Record<StatusView["tone"], HostTone | null> = {
  off: null,
  ok: "ok",
  pending: "warn",
  bad: "error",
};

/**
 * This computer on the Hosts page: a host row like the remote
 * ones, holding what the old Remote control page's status card did — whether devices can
 * reach This Mac (through the relay, confirmed before it turns on), and
 * whether it comes back on by itself at launch, and resetting its pairing keys.
 *
 * `remoteControl.*` is `localOnly`: a browser sees the state
 * but can't touch the switch or the reset.
 */
export function ThisMacRow() {
  const status = useRemoteControlStore((s) => s.status);
  const busy = useRemoteControlStore((s) => s.busy);
  const error = useRemoteControlStore((s) => s.error);
  const turnOn = useRemoteControlStore((s) => s.turnOn);
  const turnOff = useRemoteControlStore((s) => s.turnOff);
  const resetRelayAddress = useRemoteControlStore((s) => s.resetRelayAddress);
  const setStartOnLaunch = useRemoteControlStore((s) => s.setStartOnLaunch);

  const [dialog, setDialog] = useState<"confirm" | "reset" | null>(null);

  const locked = isWebApp() || busy || !status.encryptionAvailable;
  const view = describe(status);
  const devices = status.devices.length;

  return (
    <HostRowShell
      sectionId={LOCAL_HOST_SECTION}
      testId="host-local"
      bodyTestId="host-local-body"
      icon={<Laptop size={15} aria-hidden />}
      tone={TONE[view.tone]}
      name="This Mac"
      status={`Local · Manor ${__APP_VERSION__} · ${reachLine(view)}`}
      footer={
        devices > 0 && (
          <Button
            size="sm"
            variant="ghost"
            data-testid="remote-relay-reset"
            disabled={locked}
            onClick={() => setDialog("reset")}
          >
            Reset pairing keys…
          </Button>
        )
      }
      dialogs={
        <>
          <RelayConfirmDialog
            open={dialog === "confirm"}
            startOnLaunch={status.startOnLaunch}
            onCancel={() => setDialog(null)}
            onConfirm={() => {
              setDialog(null);
              void turnOn();
            }}
          />
          <ResetRelayDialog
            open={dialog === "reset"}
            devices={devices}
            onCancel={() => setDialog(null)}
            onConfirm={() => {
              setDialog(null);
              void resetRelayAddress();
            }}
          />
        </>
      }
    >
      <div className={styles.group} data-testid="remote-relay-card">
        <div className={styles.groupLabel}>Device access</div>
        <SettingRow
          label="Devices can reach This Mac"
          hint={`${view.title}. ${view.detail}`}
          action={
            view.retry && (
              <Button
                data-testid="remote-relay-retry"
                variant="secondary"
                size="sm"
                disabled={locked}
                onClick={() => void turnOn()}
              >
                {view.retry}
              </Button>
            )
          }
        >
          <Switch
            data-testid="remote-control-switch"
            aria-label="Remote control"
            checked={isOn(status)}
            disabled={locked}
            onCheckedChange={(on) => (on ? setDialog("confirm") : void turnOff())}
          />
        </SettingRow>
        <SettingRow
          label="Turn on when Manor opens"
          hint="Remote control turns on and starts the relay every time Manor opens."
        >
          <Switch
            data-testid="remote-control-on-launch"
            aria-label="Turn on remote control when Manor opens"
            checked={status.startOnLaunch}
            // Unlike the main switch, never stuck on: with the keychain gone
            // it can still be turned off, just not on.
            disabled={
              isWebApp() || busy || (!status.encryptionAvailable && !status.startOnLaunch)
            }
            onCheckedChange={(on) => void setStartOnLaunch(on)}
          />
        </SettingRow>
        {status.relayNotice && (
          <div className={settingsStyles.linearError} data-testid="remote-relay-notice">
            {status.relayNotice}
          </div>
        )}
        {!status.encryptionAvailable && (
          <div className={settingsStyles.remoteWarning}>
            <ShieldAlert size={14} />
            <span>
              This machine cannot encrypt stored secrets, so device tokens cannot be saved
              safely. Remote control stays off rather than writing a bearer token to disk in
              plaintext.
            </span>
          </div>
        )}
        {error && <div className={settingsStyles.linearError}>{error}</div>}
      </div>
    </HostRowShell>
  );
}

/** Whether devices reach This Mac, in the header's few words. */
function reachLine(view: StatusView): string {
  if (view.tone === "off") return "devices off";
  if (view.tone === "ok") return "devices reach it while Manor is open";
  if (view.title === "Turning on…") return "turning on…";
  return "can't reach the relay";
}

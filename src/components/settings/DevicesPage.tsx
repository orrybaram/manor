import { useCallback, useState } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Plus from "lucide-react/dist/esm/icons/plus";

import { useHostStore } from "../../store/host-store";
import { useRemoteControlStore } from "../../store/remote-control-store";
import { Button } from "../ui/Button/Button";
import { Stack, Row } from "../ui/Layout/Layout";
import {
  AddDeviceDialog,
  CopyLinkButton,
  PairingQr,
  PairingResultDialog,
} from "./RemoteControlDialogs";
import type { RemotePairResult } from "../../electron.d";
import { DeviceRow } from "./DeviceRow";
import { isOn } from "./remote-control-status";
import { hostReach, localReach, type Reach } from "./reach";
import { LOCAL_HOST_SECTION } from "./HostsPage/ThisMacRow";
import { useSettingsNav } from "./SettingsModal/settings-nav";
import { SectionTitle } from "./SectionTitle";
import { isWebApp } from "../../lib/platform";
import { hostName } from "../../lib/hosts";
import { useHostDisplay } from "../../hooks/useHostDisplay";
import { useMountEffect } from "../../hooks/useMountEffect";
import type { HostTone } from "../../lib/host-status";
import styles from "./SettingsModal/SettingsModal.module.css";

/**
 * Settings → Devices: the phones and browsers paired with this
 * computer, and which hosts they reach.
 *
 * A device gets full control of Manor on every host that allows devices, so
 * pairing sits behind that warning, and turns remote control on so the link
 * handed over works straight away. The switch itself lives on This Mac's row
 * on the Hosts page.
 *
 * While the relay is live a QR code for the web app, with no credentials in
 * it, lets a phone that was already paired back in: it keeps its pairing in
 * its own storage.
 */
export function DevicesPage() {
  const status = useRemoteControlStore((s) => s.status);
  const busy = useRemoteControlStore((s) => s.busy);
  const error = useRemoteControlStore((s) => s.error);
  const revoke = useRemoteControlStore((s) => s.revoke);
  const pair = useRemoteControlStore((s) => s.pair);
  const reissue = useRemoteControlStore((s) => s.reissue);
  const clearError = useRemoteControlStore((s) => s.clearError);
  const hosts = useHostStore((s) => s.hosts);
  const servers = useHostStore((s) => s.servers);

  const [addOpen, setAddOpen] = useState(false);
  const [pairing, setPairing] = useState<RemotePairResult | null>(null);

  // `remoteControl.setEnabled/pair/revoke/startRelay/stopRelay` are
  // `localOnly` — a browser can read this page's status but
  // can't touch pairing or the relay.
  const webApp = isWebApp();
  const locked = webApp || busy || !status.encryptionAvailable;

  const handlePair = useCallback(
    async (label: string) => {
      const result = await pair(label);
      if (result) {
        setAddOpen(false);
        setPairing(result);
      }
    },
    [pair],
  );

  const handleNewLink = useCallback(
    async (id: string) => {
      const result = await reissue(id);
      if (result) setPairing(result);
    },
    [reissue],
  );

  const openAdd = () => {
    clearError();
    setAddOpen(true);
  };

  const relayUp =
    status.relay.state === "running" || status.relay.state === "starting";
  const on = isOn(status);
  const live = status.relay.state === "running" && status.enabled;

  // This Mac first, then each remote host.
  const reaches: ReachEntry[] = [
    {
      hostId: null,
      name: "This Mac",
      kind: "Local",
      reach: localReach(status),
    },
    ...hosts
      .filter((h) => h.spec !== null)
      .map((h) => ({
        hostId: h.hostId,
        name: hostName(h),
        kind: h.spec?.kind === "ssh" ? "SSH" : "Started by Manor",
        reach: hostReach(servers[h.hostId] ?? null),
      })),
  ];
  const reachable = reaches.filter((e) => e.reach?.reachable);

  return (
    <Stack className={styles.pageContent}>
      <div className={styles.sectionDescription}>
        Check on your agents from your phone or another browser. Every device
        reaches every host that allows devices.
      </div>

      {webApp && (
        <div className={styles.sectionDescription}>
          This page isn&apos;t live from the browser yet — pairing and relay
          controls are read-only here.
        </div>
      )}

      {error && !addOpen && <div className={styles.linearError}>{error}</div>}

      <Stack gap="xs">
        <Row
          align="center"
          justify="space-between"
          className={styles.remoteDevicesHeader}
        >
          <SectionTitle id="remote-devices">Paired devices</SectionTitle>
          {status.devices.length > 0 && (
            <Button
              data-testid="remote-add-device"
              variant="secondary"
              size="sm"
              disabled={locked}
              onClick={openAdd}
            >
              <Plus size={13} />
              Add device
            </Button>
          )}
        </Row>
        {status.devices.length === 0 ? (
          <div className={styles.remoteEmpty}>
            <span>
              No devices yet. Pair your phone to check on agents away from
              your desk.
            </span>
            <Button
              data-testid="remote-add-device"
              variant="primary"
              disabled={locked}
              onClick={openAdd}
            >
              <Plus size={13} />
              Add device
            </Button>
          </div>
        ) : (
          <div className={styles.remoteDeviceList}>
            {status.devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                busy={locked}
                onRevoke={() => void revoke(device.id)}
                onNewLink={() => void handleNewLink(device.id)}
              />
            ))}
          </div>
        )}
      </Stack>

      {live && status.relayAppUrl && status.devices.length > 0 && (
        <div
          className={`${styles.remoteStatusCard} ${styles.remoteStatusLive}`}
        >
          <div className={styles.remoteOpenOnPhone} data-testid="remote-open-app">
            <PairingQr
              key={status.relayAppUrl}
              url={status.relayAppUrl}
              size={128}
              alt="QR code to open Manor"
            />
            <Stack gap="xs" align="flex-start" className={styles.remoteOpenOnPhoneBody}>
              <div className={styles.remoteStatusTitle}>
                Open on a paired phone
              </div>
              <div className={styles.remoteStatusDetail}>
                Scan with a device you&apos;ve already added to open Manor.
              </div>
              <CopyLinkButton
                url={status.relayAppUrl}
                testId="remote-open-app-link"
              />
            </Stack>
          </div>
        </div>
      )}

      <ReachableHosts entries={reaches} count={reachable.length} />

      <AddDeviceDialog
        open={addOpen}
        enabled={on}
        busy={locked}
        error={error}
        hosts={reachable.map((e) => e.name)}
        onCancel={() => setAddOpen(false)}
        onPair={(label) => void handlePair(label)}
      />

      <PairingResultDialog
        result={pairing}
        relayUp={relayUp}
        onClose={() => setPairing(null)}
      />
    </Stack>
  );
}

type ReachEntry = {
  /** Null for This Mac. */
  hostId: string | null;
  name: string;
  kind: string;
  /** Null until the host's server has answered. */
  reach: Reach | null;
};

/**
 * Every host with whether devices reach it, This Mac first: a compact row
 * each, linking to the host's row on the Hosts page where that is changed.
 */
function ReachableHosts(props: { entries: ReachEntry[]; count: number }) {
  const { entries, count } = props;
  const goTo = useSettingsNav();
  return (
    <Stack gap="xs" data-testid="devices-hosts">
      <Row
        align="center"
        justify="space-between"
        className={styles.remoteDevicesHeader}
      >
        <SectionTitle id="devices-hosts">
          Hosts your devices can reach
        </SectionTitle>
        <Row gap="sm" align="center">
          <span className={styles.fieldHint} data-testid="devices-hosts-count">
            {count} of {entries.length}
          </span>
          <Button
            data-testid="devices-manage-hosts"
            variant="ghost"
            size="sm"
            onClick={() => goTo({ type: "hosts" })}
          >
            Manage in Hosts
          </Button>
        </Row>
      </Row>
      <div className={styles.deviceHostList}>
        {entries.map((entry) => (
          <ReachRow key={entry.hostId ?? "local"} entry={entry} />
        ))}
      </div>
    </Stack>
  );
}

const TONE_CLASS: Record<HostTone, string> = {
  ok: styles.remoteDotOk,
  warn: styles.remoteDotPending,
  error: styles.remoteDotBad,
  asleep: "",
};

function ReachRow(props: { entry: ReachEntry }) {
  const { hostId, name, kind, reach } = props.entry;
  const goTo = useSettingsNav();
  const display = useHostDisplay(hostId);

  useMountEffect(() => {
    // The reach is the server's view; a browser can't ask.
    if (hostId && !isWebApp()) void useHostStore.getState().refreshServer(hostId);
  });

  // This Mac's dot is the relay's; a remote host's is its connection's.
  const dot = hostId === null ? (reach?.reachable ? styles.remoteDotOk : "") : TONE_CLASS[display?.tone ?? "asleep"];

  return (
    <Button
      variant="ghost"
      className={styles.deviceHostRow}
      data-testid="devices-host-row"
      onClick={() =>
        goTo({ type: "hosts" }, hostId === null ? LOCAL_HOST_SECTION : `host-${hostId}`)
      }
    >
      <span className={`${styles.remoteDot} ${styles.deviceHostDot} ${dot}`} aria-hidden />
      <span className={styles.deviceHostName}>{name}</span>
      <span className={styles.deviceHostKind}>{kind}</span>
      <span className={styles.deviceHostReach}>{reach?.text ?? "Checking…"}</span>
      <ChevronRight size={13} aria-hidden />
    </Button>
  );
}

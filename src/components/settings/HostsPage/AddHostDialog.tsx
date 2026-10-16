import { useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import Check from "lucide-react/dist/esm/icons/check";
import { useHostDisplay } from "../../../hooks/useHostDisplay";
import { pendingDisplay } from "../../../lib/host-status";
import { hostName } from "../../../lib/hosts";
import { useHostStore, type HostStatusInfo } from "../../../store/host-store";
import { Button } from "../../ui/Button/Button";
import { Stack } from "../../ui/Layout/Layout";
import { HostStateIcon } from "../../hosts/HostStateIcon";
import { HostRawOutput } from "../../hosts/HostStatusDetails";
import { useSettingsNav } from "../SettingsModal/settings-nav";
import { AddSshHostForm } from "./AddSshHostForm";
import { HostDeviceAccess, HostIntegrations } from "./HostRow";
import { StartHostForm } from "./StartHostForm";
import { useHostAction, useHostSettings } from "./useHostSettings";
import dialogStyles from "../../sidebar/dialogs.module.css";
import settingsStyles from "../SettingsModal/SettingsModal.module.css";
import styles from "./HostsPage.module.css";

const STEPS = ["Where", "Connect", "Device access"];

type Path = "ssh" | "start";

const PATHS: { path: Path; testId: string; title: string; description: string }[] = [
  {
    path: "ssh",
    testId: "hosts-add-ssh",
    title: "A machine I can SSH into",
    description:
      "A server, VM or another computer. Manor installs itself over SSH and keeps running there.",
  },
  {
    path: "start",
    testId: "hosts-add-start",
    title: "Start a new host",
    description:
      "Manor starts it for you: a Docker container, a Kubernetes pod, or your own script. Sleeps when idle, wakes on demand.",
  },
];

type AddHostDialogProps = {
  open: boolean;
  onClose: () => void;
};

/**
 * "Add a host…" (ADR-233 D4): where the host is, then connecting to it over
 * ssh or starting it from a template or recipe, then its device access —
 * the same groups its row shows, live as it connects. Closing it, however, opens its row.
 */
export function AddHostDialog(props: AddHostDialogProps) {
  const { open, onClose } = props;

  const goTo = useSettingsNav();
  // The host this opening added, once step 3 is reached. However the dialog
  // closes after that, its row opens: the host exists either way.
  const addedRef = useRef<string | null>(null);

  const close = () => {
    const id = addedRef.current;
    addedRef.current = null;
    onClose();
    if (id) goTo({ type: "hosts" }, `host-${id}`);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.confirmOverlay} />
        <Dialog.Content
          className={`${dialogStyles.confirmDialog} ${styles.addHostDialog}`}
          data-testid="add-host-dialog"
          aria-describedby={undefined}
        >
          {/* Mounted per opening: every add starts at Where. */}
          <AddHostBody onClose={close} onAdded={(id) => (addedRef.current = id)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type AddHostBodyProps = {
  onClose: () => void;
  onAdded: (hostId: string) => void;
};

function AddHostBody(props: AddHostBodyProps) {
  const { onClose, onAdded } = props;

  const [step, setStep] = useState(0);
  const [path, setPath] = useState<Path | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);

  const added = (id: string) => {
    setHostId(id);
    onAdded(id);
    setStep(2);
  };

  return (
    <>
      <StepIndicator step={step} />
      {step === 0 && (
        <>
          <Dialog.Title className={dialogStyles.confirmTitle}>Add a host</Dialog.Title>
          <div role="radiogroup" aria-label="Where" className={styles.pathCards}>
            {PATHS.map((option) => (
              <Button
                key={option.path}
                variant="ghost"
                role="radio"
                aria-checked={path === option.path}
                className={`${styles.pathCard} ${path === option.path ? styles.pathCardSelected : ""}`}
                data-testid={option.testId}
                onClick={() => setPath(option.path)}
              >
                <span className={styles.pathRadio} aria-hidden />
                <span className={styles.pathText}>
                  <span className={styles.pathTitle}>{option.title}</span>
                  <span className={styles.pathDescription}>{option.description}</span>
                </span>
              </Button>
            ))}
          </div>
          <div className={dialogStyles.confirmActions}>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              data-testid="add-host-continue"
              disabled={path === null}
              onClick={() => setStep(1)}
            >
              Continue
            </Button>
          </div>
        </>
      )}
      {step === 1 && (
        <>
          <Dialog.Title className={dialogStyles.confirmTitle}>
            {path === "ssh" ? "Connect over SSH" : "Start a new host"}
          </Dialog.Title>
          <div className={styles.wizardBody}>
            {path === "ssh" ? (
              <AddSshHostForm onAdded={added} />
            ) : (
              <StartHostForm onStarted={added} />
            )}
          </div>
          <div className={dialogStyles.confirmActions}>
            <Button variant="ghost" data-testid="add-host-back" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </>
      )}
      {step === 2 && hostId && <NewHostAccess hostId={hostId} onDone={onClose} />}
    </>
  );
}

type StepIndicatorProps = {
  step: number;
};

/** "Where · Connect · Device access": numbered dots, done ones ticked. */
function StepIndicator(props: StepIndicatorProps) {
  const { step } = props;

  return (
    <ol className={styles.steps} data-testid="add-host-steps">
      {STEPS.map((label, i) => {
        const state = i < step ? "done" : i === step ? "current" : "todo";
        return (
          <li
            key={label}
            className={`${styles.step} ${styles[`step_${state}`]}`}
            aria-current={i === step ? "step" : undefined}
          >
            <span className={styles.stepDot}>
              {i < step ? <Check size={10} aria-hidden /> : i + 1}
            </span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

type NewHostAccessProps = {
  hostId: string;
  onDone: () => void;
};

/**
 * Step 3: the new host's state as it connects, and its Device access and
 * Integrations groups, so devices can be let in before the row is ever opened.
 */
function NewHostAccess(props: NewHostAccessProps) {
  const { hostId, onDone } = props;

  const host = useHostStore((s) => s.hosts.find((h) => h.hostId === hostId)) ?? null;
  const display = useHostDisplay(hostId) ?? pendingDisplay(hostId);
  const name = host ? hostName(host) : hostId;
  const connected = host?.status === "connected";

  return (
    <>
      <Dialog.Title className={dialogStyles.confirmTitle} data-testid="add-host-ready">
        {connected ? `${name} is ready` : name}
      </Dialog.Title>
      <div className={styles.wizardBody}>
        {!connected && (
          <>
            <div
              className={`${styles.wizardStatus} ${styles[display.tone]}`}
              data-testid="add-host-status"
            >
              <HostStateIcon display={display} size={14} />
              <span>{display.summary ?? display.detail ?? display.status}</span>
            </div>
            {/* Open: a failed recipe's summary says its output is below. */}
            <HostRawOutput display={display} defaultOpen />
          </>
        )}
        {host && <NewHostGroups host={host} name={name} />}
      </div>
      <div className={dialogStyles.confirmActions}>
        <Button variant="primary" data-testid="add-host-done" onClick={onDone}>
          Done
        </Button>
      </div>
    </>
  );
}

type NewHostGroupsProps = {
  host: HostStatusInfo;
  name: string;
};

/** The groups from the host's row (ADR-233 D1), with their own action state. */
function NewHostGroups(props: NewHostGroupsProps) {
  const { host, name } = props;

  const { view, desktopLinear } = useHostSettings(host.hostId, false);
  const { busy, error, run } = useHostAction();

  return (
    <Stack gap="sm">
      <HostDeviceAccess host={host} name={name} readOnly={false} view={view} busy={busy} run={run} />
      <HostIntegrations
        hostId={host.hostId}
        name={name}
        readOnly={false}
        view={view}
        desktopLinear={desktopLinear}
        busy={busy}
        run={run}
      />
      {error && <div className={settingsStyles.linearError}>{error}</div>}
    </Stack>
  );
}

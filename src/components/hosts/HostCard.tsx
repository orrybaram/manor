import { useRef, useState, type ReactNode } from "react";
import Copy from "lucide-react/dist/esm/icons/copy";
import Check from "lucide-react/dist/esm/icons/check";
import { useHostDisplay } from "../../hooks/useHostDisplay";
import { isRemoteHost } from "../../lib/hosts";
import type { HostDisplay } from "../../lib/host-status";
import { Button } from "../ui/Button/Button";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { HostRetryButton, HostStatusDetails, LocalHostDetails } from "./HostStatusDetails";
import styles from "./HostCard.module.css";

const COPIED_MS = 1600;

type HostCardProps = {
  /** The host to describe; this machine for a missing or local id. */
  hostId: string | null | undefined;
  /** Extra rows under the host's state: a missing repo, a failed switch. */
  children?: ReactNode;
  /** Right-aligned actions, e.g. the "Change host…" picker. */
  actions?: ReactNode;
};

/** A remote host main hasn't reported yet: never drawn as this machine. */
function pendingDisplay(hostId: string): HostDisplay {
  return {
    target: hostId,
    offline: true,
    busy: true,
    tone: "warn",
    status: "Checking…",
    banner: "",
    canRetry: false,
  };
}

/**
 * A project's host in project settings: who it is, its state in plain words
 * (the same text the host popover shows), the raw ssh output on demand, and
 * buttons that act on it.
 */
export function HostCard(props: HostCardProps) {
  const { hostId, children, actions } = props;

  const reported = useHostDisplay(hostId);
  const remoteId = isRemoteHost(hostId) ? hostId : null;
  const display = reported ?? (remoteId ? pendingDisplay(remoteId) : undefined);

  return (
    <div
      className={`${styles.card} ${display ? styles[display.tone] : ""}`}
      data-testid="host-card"
    >
      <div className={styles.section}>
        {display ? <HostStatusDetails display={display} /> : <LocalHostDetails />}
      </div>
      {children}
      <div className={styles.actions}>
        {remoteId && display?.canRetry && <HostRetryButton hostId={remoteId} />}
        {display && <CopySshCommand target={display.target} />}
        <span className={styles.spacer} />
        {actions}
      </div>
    </div>
  );
}

type CopySshCommandProps = {
  target: string;
};

/** Copies `ssh <target>`, the quickest way to see what ssh itself says. */
function CopySshCommand(props: CopySshCommandProps) {
  const { target } = props;

  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const command = `ssh ${target}`;

  const copy = () => {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <Tooltip label={command} side="top">
      <Button
        size="sm"
        variant="ghost"
        aria-label={copied ? "ssh command copied" : `Copy ${command}`}
        onClick={copy}
      >
        {copied ? (
          <Check size={11} aria-hidden className={styles.buttonIcon} />
        ) : (
          <Copy size={11} aria-hidden className={styles.buttonIcon} />
        )}
        {copied ? "Copied" : "Copy ssh command"}
      </Button>
    </Tooltip>
  );
}

type HostCardRowProps = {
  /** Colours the row's message: `warn` for a missing repo, `error` for a failure. */
  tone?: "warn" | "error";
  children: ReactNode;
};

/** One extra row in a `HostCard`, between its state and its actions. */
export function HostCardRow(props: HostCardRowProps) {
  const { tone, children } = props;

  return (
    <div className={`${styles.section} ${styles.row} ${tone ? styles[tone] : ""}`}>
      {children}
    </div>
  );
}

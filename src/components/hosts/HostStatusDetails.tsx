import { useState } from "react";
import { addErrorToast } from "../../store/toast-store";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Sunrise from "lucide-react/dist/esm/icons/sunrise";
import { useHostStore } from "../../store/host-store";
import type { HostDisplay } from "../../lib/host-status";
import { Button } from "../ui/Button/Button";
import { Link } from "../ui/Link/Link";
import { Collapse } from "../ui/Collapse/Collapse";
import { HostStateIcon } from "./HostStateIcon";
import styles from "./HostStatusDetails.module.css";

type HostStatusDetailsProps = {
  display: HostDisplay;
};

/**
 * Who the host is and what state it is in, in plain words: the header, the
 * one-line summary and — behind a toggle — the raw output. Shared by the
 * host popover and the project settings host card, so both say exactly the
 * same thing.
 */
export function HostStatusDetails(props: HostStatusDetailsProps) {
  const { display } = props;

  const summary = display.summary ?? display.detail;

  return (
    <div className={styles.details}>
      <div className={styles.head}>
        <span className={`${styles.glyphBox} ${styles[display.tone]}`}>
          <HostStateIcon display={display} size={14} />
        </span>
        <span className={styles.name}>{display.target}</span>
        <span className={`${styles.status} ${styles[display.tone]}`}>{display.status}</span>
      </div>
      {summary && <p className={styles.summary}>{summary}</p>}
      <HostRawOutput display={display} />
    </div>
  );
}

type HostFailureActionProps = {
  display: HostDisplay;
  hostId: string;
  /** Render the Retry action; false where a Retry button already shows. */
  showRetry?: boolean;
};

/**
 * The one thing to do about a recognised recipe failure (ADR-234 D10): a
 * link to the page that helps, or Retry.
 */
export function HostFailureAction(props: HostFailureActionProps) {
  const { display, hostId, showRetry = true } = props;

  const action = display.action;
  if (!action) return null;
  if (action.kind === "url") {
    return (
      <Link href={action.href} data-testid="host-failure-link">
        {action.label}
      </Link>
    );
  }
  return showRetry && display.canRetry ? <HostRetryButton hostId={hostId} /> : null;
}

type HostRawOutputProps = {
  display: HostDisplay;
  /** Start expanded: where the summary already points at the output. */
  defaultOpen?: boolean;
};

/**
 * The host's raw output — ssh's, or a recipe's — behind a toggle, when it
 * says more than the summary does. Connecting progress and connected
 * warnings are already plain words; an unclassified error with nothing
 * better to say is its own summary, so there is nothing more to show.
 */
export function HostRawOutput(props: HostRawOutputProps) {
  const { display, defaultOpen = false } = props;

  const [showRaw, setShowRaw] = useState(defaultOpen);

  const summary = display.summary ?? display.detail;
  const raw = display.detail && display.detail !== summary ? display.detail : null;
  if (!raw) return null;

  const what = display.sshTarget ? "ssh output" : "output";
  return (
    <div className={styles.rawOutput} data-testid="host-raw-output">
      <Button
        variant="link"
        className={styles.rawToggle}
        aria-expanded={showRaw}
        onClick={() => setShowRaw((v) => !v)}
      >
        {showRaw ? `Hide ${what}` : `Show ${what}`}
      </Button>
      <Collapse open={showRaw}>
        <pre className={styles.raw}>{raw}</pre>
      </Collapse>
    </div>
  );
}

/** This machine's counterpart to `HostStatusDetails`: always here, no state. */
export function LocalHostDetails() {
  return (
    <div className={styles.details}>
      <div className={styles.head}>
        <span className={`${styles.glyphBox} ${styles.local}`}>
          <Laptop size={14} aria-hidden />
        </span>
        <span className={styles.name}>This machine</span>
      </div>
    </div>
  );
}

type HostRetryButtonProps = {
  hostId: string;
};

/** Retry a host's connection now, skipping any backoff wait. */
export function HostRetryButton(props: HostRetryButtonProps) {
  const { hostId } = props;

  const retryConnect = useHostStore((s) => s.retryConnect);
  return (
    <Button
      size="sm"
      variant="primary"
      onClick={() =>
        void retryConnect(hostId).catch((err: unknown) =>
          addErrorToast(`host-retry-${hostId}`, "Couldn't reconnect", err),
        )
      }
    >
      <RefreshCw size={11} aria-hidden className={styles.buttonIcon} />
      Retry
    </Button>
  );
}

type HostWakeButtonProps = {
  hostId: string;
};

/**
 * Wake a sleeping host (ADR-229 D1). Its progress, or why it could not
 * start, shows in the host's status.
 */
export function HostWakeButton(props: HostWakeButtonProps) {
  const { hostId } = props;

  const wake = useHostStore((s) => s.wake);
  return (
    <Button
      size="sm"
      variant="primary"
      data-testid="host-wake"
      onClick={() => {
        wake(hostId).catch(() => {
          // Reported through the host's status.
        });
      }}
    >
      <Sunrise size={11} aria-hidden className={styles.buttonIcon} />
      Wake
    </Button>
  );
}

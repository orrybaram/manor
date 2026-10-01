import { useState } from "react";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { useHostStore } from "../../store/host-store";
import type { HostDisplay } from "../../lib/host-status";
import { Button } from "../ui/Button/Button";
import { Collapse } from "../ui/Collapse/Collapse";
import { HostStateIcon } from "./HostStateIcon";
import styles from "./HostStatusDetails.module.css";

type HostStatusDetailsProps = {
  display: HostDisplay;
};

/**
 * Who the host is and what state it is in, in plain words: the header, the
 * one-line summary and — behind a toggle — the raw ssh output. Shared by the
 * host popover and the project settings host card, so both say exactly the
 * same thing.
 */
export function HostStatusDetails(props: HostStatusDetailsProps) {
  const { display } = props;

  const [showRaw, setShowRaw] = useState(false);

  // Connecting progress and connected warnings are already plain words; an
  // unclassified error with nothing better to say shows its raw text openly.
  const summary = display.summary ?? display.detail;
  const raw = display.detail && display.detail !== summary ? display.detail : null;

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
      {raw && (
        <>
          <Button
            variant="link"
            className={styles.rawToggle}
            aria-expanded={showRaw}
            onClick={() => setShowRaw((v) => !v)}
          >
            {showRaw ? "Hide ssh output" : "Show ssh output"}
          </Button>
          <Collapse open={showRaw}>
            <pre className={styles.raw}>{raw}</pre>
          </Collapse>
        </>
      )}
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
    <Button size="sm" variant="primary" onClick={() => void retryConnect(hostId)}>
      <RefreshCw size={11} aria-hidden className={styles.buttonIcon} />
      Retry
    </Button>
  );
}

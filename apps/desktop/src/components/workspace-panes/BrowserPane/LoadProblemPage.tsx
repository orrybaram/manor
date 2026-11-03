import { useState } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { describeLoadError } from "../../../lib/browser-load-error";
import { Button } from "../../ui/Button/Button";
import type { LoadProblem } from "./useLoadProblem";
import styles from "./BrowserPane.module.css";

type LoadProblemPageProps = {
  problem: LoadProblem;
  /** The failed page's site, as the pane names it. */
  site: string;
  onRetry: () => void;
  /** Stop waiting for a dev server. */
  onCancel: () => void;
};

/** The waiting, error or crash page that stands in for the page. */
export function LoadProblemPage(props: LoadProblemPageProps) {
  const { problem, site, onRetry, onCancel } = props;

  if (problem.kind === "waiting") {
    return (
      <div className={styles.statePage} data-testid="browser-waiting">
        <span className={styles.stateSpinner} aria-hidden />
        <strong className={styles.stateTitle}>Waiting for {site}…</strong>
        <span className={styles.stateDetail}>
          Nothing is listening yet. <RetryCountdown retryAt={problem.retryAt} attempt={problem.attempt} />
        </span>
        <div className={styles.stateActions}>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Retry now
          </Button>
        </div>
      </div>
    );
  }

  if (problem.kind === "crashed") {
    return (
      <div className={styles.statePage} data-testid="browser-crashed">
        <strong className={styles.stateTitle}>This page crashed</strong>
        <span className={styles.stateDetail}>Its process stopped unexpectedly.</span>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Reload
        </Button>
      </div>
    );
  }

  return (
    <div className={styles.statePage} data-testid="browser-load-error">
      <strong className={styles.stateTitle}>Couldn't load {site}</strong>
      <span className={styles.stateDetail}>{describeLoadError(problem.name)}</span>
      <span className={styles.stateCode}>{problem.name}</span>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** "Trying again in 3s (attempt 4).", ticking down to the retry. */
function RetryCountdown(props: { retryAt: number; attempt: number }) {
  const { retryAt, attempt } = props;
  const [now, setNow] = useState(() => Date.now());
  useMountEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  });
  const seconds = Math.ceil((retryAt - now) / 1000);
  if (seconds <= 0) return <>Trying again (attempt {attempt}).</>;
  return (
    <>
      Trying again in {seconds}s (attempt {attempt}).
    </>
  );
}

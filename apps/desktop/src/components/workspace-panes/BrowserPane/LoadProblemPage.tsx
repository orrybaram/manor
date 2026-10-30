import { describeLoadError } from "../../../lib/browser-load-error";
import { Button } from "../../ui/Button/Button";
import type { LoadProblem } from "./useLoadProblem";
import styles from "./BrowserPane.module.css";

type LoadProblemPageProps = {
  problem: LoadProblem;
  /** The failed page's site, as the pane names it. */
  site: string;
  onRetry: () => void;
};

/** The error page for a failed load, or the crash page for a dead renderer. */
export function LoadProblemPage(props: LoadProblemPageProps) {
  const { problem, site, onRetry } = props;

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

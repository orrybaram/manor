import { useState } from "react";
import type { AutomationRunView } from "../../../lib/automation-views";
import { Button } from "../../ui/Button/Button";
import {
  historyTime,
  runStatusText,
  runWhatText,
  type RunStatusText,
} from "./automation-text";
import styles from "./AutomationsPage.module.css";

/** A run's status: a dot in its tone, and its label. */
export function RunStatus(props: { status: RunStatusText }) {
  const { status } = props;
  return (
    <span className={`${styles.status} ${styles[status.tone]}`}>
      <span className={styles.dot} aria-hidden />
      {status.label}
    </span>
  );
}

const SHOWN = 20;

type RunHistoryProps = {
  runs: AutomationRunView[];
  local: boolean;
  workspaceName: (path: string) => string | null;
  /** Opens a started run's Agent in its pane. */
  onOpenAgent: (agentId: string) => void;
};

/**
 * "Runs": a strip of recent outcomes, newest first, then one row per run —
 * when, what happened, and its status now. A run with an Agent opens it.
 */
export function RunHistory(props: RunHistoryProps) {
  const { runs, local, workspaceName, onOpenAgent } = props;
  const [all, setAll] = useState(false);
  const shown = all ? runs : runs.slice(0, SHOWN);

  return (
    <div data-testid="automation-runs">
      <div className={styles.strip} aria-hidden>
        {runs.slice(0, 40).map((run) => {
          const status = runStatusText(run);
          return (
            <span
              key={run.id}
              className={`${styles[status.tone]}`}
              title={`${historyTime(run.firedAt)} · ${status.label}`}
            >
              <span className={styles.dot} />
            </span>
          );
        })}
      </div>
      <div className={styles.hist}>
        {shown.map((run) => {
          const content = (
            <>
              <span className={styles.histTime}>{historyTime(run.firedAt)}</span>
              <span className={styles.histWhat}>{runWhatText(run, { local, workspaceName })}</span>
              <RunStatus status={runStatusText(run)} />
            </>
          );
          const agentId = run.agentId;
          return agentId ? (
            <button
              key={run.id}
              type="button"
              className={styles.histRow}
              data-testid={`automation-run-${run.id}`}
              title="Open this run's agent"
              onClick={() => onOpenAgent(agentId)}
            >
              {content}
            </button>
          ) : (
            <div key={run.id} className={styles.histRow} data-testid={`automation-run-${run.id}`}>
              {content}
            </div>
          );
        })}
      </div>
      {runs.length > SHOWN && !all && (
        <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
          Show {runs.length - SHOWN} older
        </Button>
      )}
    </div>
  );
}

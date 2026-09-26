import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2";
import XCircle from "lucide-react/dist/esm/icons/x-circle";
import HelpCircle from "lucide-react/dist/esm/icons/help-circle";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw";
import type { HealthCheckResult } from "../../lib/hosts";
import { Button } from "../ui/Button/Button";
import { Row } from "../ui/Layout/Layout";
import styles from "./HealthCheckList.module.css";

type HealthCheckListProps = {
  checks: HealthCheckResult[] | null;
  running: boolean;
  onRerun: () => void;
  onFix: (check: HealthCheckResult) => void;
};

function StatusIcon(props: { check: HealthCheckResult }) {
  const { check } = props;
  if (check.status === "unknown") {
    return <HelpCircle size={14} className={`${styles.icon} ${styles.unknown}`} />;
  }
  if (check.ok) {
    return <CheckCircle2 size={14} className={`${styles.icon} ${styles.ok}`} />;
  }
  return <XCircle size={14} className={`${styles.icon} ${styles.fail}`} />;
}

/**
 * The post-clone health-check header ("Re-run") and list, with
 * ok/fail/unknown icons and "Fix in terminal" buttons. Shared by
 * `AddProjectDialog` (ADR-178 ticket 5) and `CloneToHostDialog` (ADR-179).
 */
export function HealthCheckList(props: HealthCheckListProps) {
  const { checks, running, onRerun, onFix } = props;
  const list = checks ?? [];
  const passed = list.filter((c) => c.ok).length;

  return (
    <div className={styles.root}>
      <Row align="center" justify="space-between" className={styles.header}>
        <span className={styles.title}>
          Host health check
          {list.length > 0 && (
            <span className={styles.summary}>
              {passed} of {list.length} passed
            </span>
          )}
        </span>
        <Button variant="ghost" size="sm" disabled={running} onClick={onRerun}>
          <RotateCw size={12} className={running ? styles.spinning : undefined} />
          {running ? "Checking…" : "Re-run"}
        </Button>
      </Row>
      <ul className={styles.list} data-testid="health-check-list">
        {list.map((check) => (
          <li key={check.id} className={styles.item}>
            <StatusIcon check={check} />
            <div className={styles.text}>
              <div className={styles.label}>{check.label}</div>
              <div className={styles.detail}>{check.detail}</div>
            </div>
            {!check.ok && check.fixCommand && (
              <Button variant="secondary" size="sm" onClick={() => onFix(check)}>
                Fix in terminal
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

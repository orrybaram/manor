import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2";
import XCircle from "lucide-react/dist/esm/icons/x-circle";
import HelpCircle from "lucide-react/dist/esm/icons/help-circle";
import type { HealthCheckResult } from "../../lib/hosts";
import { Button } from "../ui/Button/Button";
import { Row, Stack } from "../ui/Layout/Layout";
import styles from "./HealthCheckList.module.css";

type HealthCheckListProps = {
  checks: HealthCheckResult[] | null;
  running: boolean;
  onRerun: () => void;
  onFix: (check: HealthCheckResult) => void;
};

/**
 * The post-clone health-check header ("Re-run checks") and list, with
 * ok/fail/unknown icons and "Fix in terminal" buttons. Shared by
 * `AddProjectDialog` (ADR-178 ticket 5) and `CloneToHostDialog` (ADR-179).
 */
export function HealthCheckList(props: HealthCheckListProps) {
  const { checks, running, onRerun, onFix } = props;

  return (
    <Stack gap="sm">
      <Row align="center" justify="space-between">
        <span className={styles.fieldLabel}>Host health check</span>
        <Button variant="ghost" size="sm" disabled={running} onClick={onRerun}>
          {running ? "Checking…" : "Re-run checks"}
        </Button>
      </Row>
      <Stack gap="xs" data-testid="health-check-list">
        {(checks ?? []).map((check) => (
          <Row key={check.id} align="center" justify="space-between" gap="sm">
            <Row align="center" gap="xs">
              {check.status === "unknown" ? (
                <HelpCircle size={14} className={styles.unknown} />
              ) : check.ok ? (
                <CheckCircle2 size={14} className={styles.ok} />
              ) : (
                <XCircle size={14} className={styles.fail} />
              )}
              <Stack gap="2xs">
                <span>{check.label}</span>
                <span className={styles.fieldHint}>{check.detail}</span>
              </Stack>
            </Row>
            {!check.ok && check.fixCommand && (
              <Button variant="secondary" size="sm" onClick={() => onFix(check)}>
                Fix in terminal
              </Button>
            )}
          </Row>
        ))}
      </Stack>
    </Stack>
  );
}

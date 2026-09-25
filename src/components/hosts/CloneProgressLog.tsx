import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import { Row, Stack } from "../ui/Layout/Layout";
import styles from "./CloneProgressLog.module.css";

type CloneProgressLogProps = {
  /** All progress lines received so far, oldest first; only the last 8 render. */
  lines: string[];
};

/**
 * "Cloning…" spinner plus the last 8 lines of clone progress. Shared by
 * `AddProjectDialog` (ADR-178 ticket 5) and `CloneToHostDialog` (ADR-179).
 */
export function CloneProgressLog(props: CloneProgressLogProps) {
  const { lines } = props;

  return (
    <Stack gap="sm">
      <Row gap="xs" align="center">
        <Loader2 size={14} className={styles.spinner} />
        <span>Cloning…</span>
      </Row>
      <div className={styles.progressLog} data-testid="clone-progress-log">
        {lines.slice(-8).map((line, i) => (
          <div key={i} className={styles.progressLine}>
            {line}
          </div>
        ))}
      </div>
    </Stack>
  );
}

import type { CSSProperties } from "react";
import type { PipelineRow } from "../../../lib/home-dashboard-studio";
import type { PrStage } from "../../../lib/pr-readiness";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import { Button } from "../../ui/Button/Button";
import { PrPopover } from "../PrPopover";
import { formatAge } from "./format";
import styles from "./PrPipeline.module.css";

type PipelineCardProps = {
  row: PipelineRow;
  stage: PrStage;
  onOpen: () => void;
};

/**
 * One pipeline card: title, blocked reason and meta. The whole card opens the
 * workspace; hovering it shows the same PR popover as the sidebar badge.
 */
export function PipelineCard(props: PipelineCardProps) {
  const { row, stage, onOpen } = props;
  const { pr, project, workspace } = row;

  return (
    <PrPopover
      pr={pr}
      workspacePath={workspace.path}
      hostId={project.hostId}
      onOpen={() => window.electronAPI.shell.openExternal(pr.url)}
    >
      <Button
        variant="ghost"
        className={`${styles.card} ${stage === "blocked" ? styles.bad : ""}`}
        onClick={onOpen}
      >
        <span className={styles.prTitle}>{pr.title}</span>
        {stage === "blocked" && row.label && (
          <span className={styles.why}>{row.label}</span>
        )}
        <span className={styles.meta}>
          <span className={styles.num}>#{pr.number}</span>
          <span
            className={styles.proj}
            style={projectColorStyle(project.color)}
          >
            {project.name}
          </span>
          {stage !== "blocked" && row.label && (
            <span className={styles.tag}>{row.label}</span>
          )}
          {row.ageMs != null && (
            <span className={`${styles.age} ${row.stale ? styles.stale : ""}`}>
              {formatAge(row.ageMs)}
            </span>
          )}
        </span>
        {stage === "checks" && row.checks && row.checks.total > 0 && (
          <CheckBar checks={row.checks} />
        )}
      </Button>
    </PrPopover>
  );
}

/**
 * Check progress as one proportional bar plus "done/total", on its own line:
 * a pip per check overflowed narrow columns once a suite had more than a
 * handful of checks.
 */
function CheckBar(props: { checks: NonNullable<PipelineRow["checks"]> }) {
  const { passing, pending, failing, total } = props.checks;
  const part = (n: number) => ({ flexGrow: n }) as CSSProperties;

  return (
    <span
      className={styles.checks}
      title={`${passing} passing, ${pending} running, ${failing} failing`}
    >
      <span className={styles.checkBar}>
        {passing > 0 && <i className={styles.ok} style={part(passing)} />}
        {pending > 0 && <i className={styles.run} style={part(pending)} />}
        {failing > 0 && <i className={styles.fail} style={part(failing)} />}
      </span>
      <span className={styles.checkCount}>
        {passing + failing}/{total}
      </span>
    </span>
  );
}

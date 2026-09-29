import type { CSSProperties } from "react";
import type { PipelineRow, PrStage } from "../../../lib/home-dashboard-studio";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import { Button } from "../../ui/Button/Button";
import { formatAge } from "./format";
import styles from "./PrPipeline.module.css";

/** Most pips drawn for one PR, so a huge check suite doesn't overflow the card. */
const MAX_PIPS = 12;

type PipelineCardProps = {
  row: PipelineRow;
  stage: PrStage;
  onOpen: () => void;
};

/** One pipeline card: title, blocked reason and meta. The whole card opens the workspace. */
export function PipelineCard(props: PipelineCardProps) {
  const { row, stage, onOpen } = props;
  const { pr, project } = row;

  return (
    <Button
      variant="ghost"
      className={`${styles.card} ${stage === "blocked" ? styles.bad : ""}`}
      onClick={onOpen}
      title={pr.title}
    >
      <span className={styles.prTitle}>{pr.title}</span>
      {stage === "blocked" && row.label && <span className={styles.why}>{row.label}</span>}
      <span className={styles.meta}>
        <span className={styles.num}>#{pr.number}</span>
        <span className={styles.proj} style={projectColorStyle(project.color)}>
          {project.name}
        </span>
        {stage === "checks" && row.checks && <CheckPips checks={row.checks} />}
        {stage !== "blocked" && row.label && <span className={styles.tag}>{row.label}</span>}
        {row.ageMs != null && (
          <span className={`${styles.age} ${row.stale ? styles.stale : ""}`}>{formatAge(row.ageMs)}</span>
        )}
      </span>
    </Button>
  );
}

function CheckPips(props: { checks: NonNullable<PipelineRow["checks"]> }) {
  const { passing, pending, failing } = props.checks;
  const pips = [
    ...Array<string>(passing).fill(styles.ok),
    ...Array<string>(pending).fill(styles.run),
    ...Array<string>(failing).fill(styles.fail),
  ].slice(0, MAX_PIPS);

  return (
    <span
      className={styles.checks}
      title={`${passing} passing, ${pending} running, ${failing} failing`}
      style={{ "--pips": pips.length } as CSSProperties}
    >
      {pips.map((cls, i) => (
        <i key={i} className={cls} />
      ))}
    </span>
  );
}

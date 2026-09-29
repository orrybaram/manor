import type { CSSProperties } from "react";
import type {
  PipelineColumn,
  PrStage,
} from "../../../lib/home-dashboard-studio";
import { AnimatedCount } from "../../ui/AnimatedCount/AnimatedCount";
import { PipelineCard } from "./PipelineCard";
import { useDashboardAnimate } from "./useDashboardAnimate";
import { useSelectWorkspace } from "./useSelectWorkspace";
import styles from "./PrPipeline.module.css";

const STAGE_LABEL: Record<PrStage, string> = {
  checks: "Checks running",
  review: "In review",
  blocked: "Blocked",
  ready: "Ready",
};

const STAGE_COLOR: Record<PrStage, string> = {
  checks: "var(--yellow)",
  review: "var(--hd-fg-4)",
  blocked: "var(--red)",
  ready: "var(--green)",
};

type PipelineStageProps = {
  column: PipelineColumn;
};

/**
 * One pipeline column: a count header over every card, in a list about three
 * cards tall that scrolls the rest.
 */
export function PipelineStage(props: PipelineStageProps) {
  const { column } = props;
  const openWorkspace = useSelectWorkspace();
  const animate = useDashboardAnimate();

  return (
    <div
      className={styles.stage}
      style={{ "--c": STAGE_COLOR[column.stage] } as CSSProperties}
    >
      <div className={styles.stageHeader}>
        <AnimatedCount
          value={column.rows.length}
          className={styles.stageCount}
        />
        <span>{STAGE_LABEL[column.stage]}</span>
      </div>
      <div ref={animate} className={styles.cards}>
        {column.rows.map((row) => (
          <PipelineCard
            key={row.pr.url}
            row={row}
            stage={column.stage}
            onOpen={() => openWorkspace(row.project, row.workspace)}
          />
        ))}
      </div>
    </div>
  );
}

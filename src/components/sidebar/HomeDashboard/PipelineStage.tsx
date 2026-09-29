import type { CSSProperties } from "react";
import type { PipelineColumn } from "../../../lib/home-dashboard-studio";
import { AnimatedCount } from "../../ui/AnimatedCount/AnimatedCount";
import { PipelineCard } from "./PipelineCard";
import { useDashboardAnimate } from "./useDashboardAnimate";
import { useSelectWorkspace } from "./useSelectWorkspace";
import { PR_STAGE } from "./pr-stage";
import styles from "./PrPipeline.module.css";

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
      style={{ "--c": PR_STAGE[column.stage].color } as CSSProperties}
    >
      <div className={styles.stageHeader}>
        <AnimatedCount
          value={column.rows.length}
          className={styles.stageCount}
        />
        <span>{PR_STAGE[column.stage].label}</span>
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

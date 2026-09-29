import type { CSSProperties } from "react";
import type {
  PipelineColumn,
  PrStage,
} from "../../../lib/home-dashboard-studio";
import { AnimatedCount } from "../../ui/AnimatedCount/AnimatedCount";
import { Button } from "../../ui/Button/Button";
import { PipelineCard } from "./PipelineCard";
import { useDashboardAnimate } from "./useDashboardAnimate";
import { useSelectWorkspace } from "./useSelectWorkspace";
import styles from "./PrPipeline.module.css";

const VISIBLE_CARDS = 3;

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
  expanded: boolean;
  onExpand: () => void;
};

/** One pipeline column: a count header, three cards, the rest behind "+N more". */
export function PipelineStage(props: PipelineStageProps) {
  const { column, expanded, onExpand } = props;
  const openWorkspace = useSelectWorkspace();
  const animate = useDashboardAnimate();

  const shown = expanded ? column.rows : column.rows.slice(0, VISIBLE_CARDS);
  const hidden = column.rows.length - shown.length;

  return (
    <div
      ref={animate}
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
      {shown.map((row) => (
        <PipelineCard
          key={row.pr.url}
          row={row}
          stage={column.stage}
          onOpen={() => openWorkspace(row.project, row.workspace)}
        />
      ))}
      {hidden > 0 && (
        <Button variant="link" className={styles.more} onClick={onExpand}>
          +{hidden} more
        </Button>
      )}
    </div>
  );
}

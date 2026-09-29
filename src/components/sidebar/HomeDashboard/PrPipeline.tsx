import { useState } from "react";
import type {
  PipelineColumn,
  PrStage,
} from "../../../lib/home-dashboard-studio";
import { Panel } from "./Panel";
import { PipelineStage } from "./PipelineStage";
import { useDashboardAnimate } from "./useDashboardAnimate";
import styles from "./PrPipeline.module.css";

type PrPipelineProps = {
  pipeline: PipelineColumn[];
  /** Grid placement from `HomeDashboard.module.css`. */
  className?: string;
};

/**
 * The Pull requests panel (ADR-198 §1.6): open PRs in four stage columns,
 * three cards each, the rest behind "+N more".
 */
export function PrPipeline(props: PrPipelineProps) {
  const { pipeline, className } = props;
  const [expanded, setExpanded] = useState<ReadonlySet<PrStage>>(new Set());
  const animate = useDashboardAnimate();

  const total = pipeline.reduce((sum, column) => sum + column.rows.length, 0);
  const projectIds = new Set(
    pipeline.flatMap((column) => column.rows.map((row) => row.project.id)),
  );
  const sub = `${total} open across ${projectIds.size} ${projectIds.size === 1 ? "project" : "projects"}`;

  const expand = (stage: PrStage) =>
    setExpanded((prev) => new Set(prev).add(stage));

  return (
    <Panel
      title="Pull requests"
      sub={total > 0 ? sub : undefined}
      className={className}
    >
      <div ref={animate}>
        {total === 0 ? (
          <p className={styles.empty}>No open PRs.</p>
        ) : (
          <div className={styles.pipe}>
            {pipeline.map((column) => (
              <PipelineStage
                key={column.stage}
                column={column}
                expanded={expanded.has(column.stage)}
                onExpand={() => expand(column.stage)}
              />
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

import { useState, type CSSProperties } from "react";
import type { PipelineColumn, PrStage } from "../../../lib/home-dashboard-studio";
import { Button } from "../../ui/Button/Button";
import { Panel } from "./Panel";
import { PipelineCard } from "./PipelineCard";
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
  const openWorkspace = useSelectWorkspace();

  const total = pipeline.reduce((sum, column) => sum + column.rows.length, 0);
  const projectIds = new Set(pipeline.flatMap((column) => column.rows.map((row) => row.project.id)));
  const sub = `${total} open across ${projectIds.size} ${projectIds.size === 1 ? "project" : "projects"}`;

  const expand = (stage: PrStage) => setExpanded((prev) => new Set(prev).add(stage));

  return (
    <Panel title="Pull requests" sub={total > 0 ? sub : undefined} className={className}>
      {total === 0 ? (
        <p className={styles.empty}>No open PRs.</p>
      ) : (
        <div className={styles.pipe}>
          {pipeline.map((column) => {
            const shown = expanded.has(column.stage) ? column.rows : column.rows.slice(0, VISIBLE_CARDS);
            const hidden = column.rows.length - shown.length;
            return (
              <div key={column.stage} className={styles.stage} style={{ "--c": STAGE_COLOR[column.stage] } as CSSProperties}>
                <div className={styles.stageHeader}>
                  <b>{column.rows.length}</b>
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
                  <Button variant="link" className={styles.more} onClick={() => expand(column.stage)}>
                    +{hidden} more
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

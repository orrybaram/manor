import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import type { NewWorkspaceHandler } from "../../../lib/start-issue-work";
import type { PaletteView } from "../../command-palette/types";
import { Button } from "../../ui/Button/Button";
import { Panel } from "./Panel";
import { PriorityGlyph } from "./PriorityGlyph";
import { useStartUpNextIssue } from "./useStartUpNextIssue";
import { useUpNextIssues } from "./useUpNextIssues";
import { useDashboardAnimate } from "./useDashboardAnimate";
import styles from "./UpNextPanel.module.css";

const VISIBLE_ROWS = 5;
const SKELETON_ROWS = 3;

type UpNextPanelProps = {
  onNewWorkspace?: NewWorkspaceHandler;
  onOpenPaletteView?: (view: PaletteView) => void;
  /** Extra class for placement. */
  className?: string;
};

/**
 * The Up next panel (ADR-198 §1.7): the top of the ranked list of issues
 * assigned to the user that no workspace has picked up. A row starts work on
 * its issue; "View all" opens the palette's full list.
 */
export function UpNextPanel(props: UpNextPanelProps) {
  const { onNewWorkspace, onOpenPaletteView, className } = props;
  const { all, total, loading } = useUpNextIssues();
  const startIssue = useStartUpNextIssue(onNewWorkspace);

  const rows = all.slice(0, VISIBLE_ROWS);
  const animate = useDashboardAnimate();

  return (
    <Panel
      title="Up next"
      sub="Assigned to you, no workspace yet"
      className={className}
      right={
        total > 0 && onOpenPaletteView ? (
          <Button variant="link" onClick={() => onOpenPaletteView("up-next")}>
            View all {total} →
          </Button>
        ) : undefined
      }
    >
      <div ref={animate} className={styles.list}>
        {loading && rows.length === 0 ? (
          Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <div key={i} className={styles.skeleton} aria-hidden="true" />
          ))
        ) : rows.length === 0 ? (
          <p className={styles.empty}>
            No assigned tasks without a workspace.
          </p>
        ) : (
          rows.map((row) => (
            <Button
              key={`${row.issue.source}:${row.issue.projectKey}:${row.issue.identifier}`}
              variant="ghost"
              className={styles.li}
              onClick={() => void startIssue(row)}
            >
              <PriorityGlyph priority={row.issue.priority} />
              <span className={styles.body}>
                <span className={styles.title}>{row.issue.title}</span>
                <span className={styles.meta}>
                  <span className={styles.id}>{row.issue.identifier}</span>
                  <span
                    className={styles.proj}
                    style={projectColorStyle(row.color)}
                  >
                    {row.entryName}
                  </span>
                  {row.issue.labels.includes("ready-for-agent") && (
                    <span className={styles.tag}>ready-for-agent</span>
                  )}
                </span>
              </span>
              <span className={styles.go}>Start agent →</span>
            </Button>
          ))
        )}
      </div>
    </Panel>
  );
}

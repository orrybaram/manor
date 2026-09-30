import { useMemo, useState } from "react";
import { useProjectStore } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import type { NewWorkspaceHandler } from "../../../lib/start-issue-work";
import {
  DEFAULT_TASK_FILTERS,
  applyTaskFilters,
  sortTasksBy,
  withoutLinkedTasks,
} from "../../../lib/tasks";
import { readFilters, readProvider, readSort } from "../../tasks/task-prefs";
import { useTasks } from "../../tasks/useTasks";
import { useStartTask } from "../../tasks/useStartTask";
import { TaskTableRow } from "../../tasks/TaskTableRow";
import tasksStyles from "../../tasks/TasksView.module.css";
import { Button } from "../../ui/Button/Button";
import { Panel } from "./Panel";
import styles from "./UpNextPanel.module.css";

const VISIBLE_ROWS = 5;
const SKELETON_ROWS = 3;

type UpNextPanelProps = {
  onNewWorkspace?: NewWorkspaceHandler;
  /** Extra class for placement. */
  className?: string;
};

/**
 * The Up next panel (ADR-198 §1.7): the top of the Tasks view's list — each
 * tracker's tasks through its saved filters, merged and ordered by the sort
 * of the tracker last shown there — in the Tasks table's compact rows. "View
 * all" opens the Tasks view.
 */
export function UpNextPanel(props: UpNextPanelProps) {
  const { onNewWorkspace, className } = props;

  // Same queries as the Tasks view, so the two share one cache.
  const github = useTasks({ provider: "github", projectKey: null });
  const linear = useTasks({ provider: "linear", projectKey: null });
  const projects = useProjectStore((s) => s.projects);
  const showTasksView = useAppStore((s) => s.showTasksView);
  const startTask = useStartTask(onNewWorkspace);
  const [now] = useState(() => Date.now());
  // The Tasks view isn't mounted alongside Home, so its choices can't change
  // while this is shown — read once.
  const [prefs] = useState(() => ({
    sort: readSort(readProvider()),
    github: readFilters("github"),
    linear: readFilters("linear"),
  }));
  const defaultFilters =
    JSON.stringify(prefs.github) === JSON.stringify(DEFAULT_TASK_FILTERS) &&
    JSON.stringify(prefs.linear) === JSON.stringify(DEFAULT_TASK_FILTERS);

  const upNext = useMemo(
    () =>
      sortTasksBy(
        [
          ...applyTaskFilters(withoutLinkedTasks(github.rows, projects), prefs.github),
          ...applyTaskFilters(withoutLinkedTasks(linear.rows, projects), prefs.linear),
        ],
        prefs.sort,
      ),
    [github.rows, linear.rows, projects, prefs],
  );
  const rows = upNext.slice(0, VISIBLE_ROWS);
  const loading = github.loading || linear.loading;

  return (
    <Panel
      title="Up next"
      sub={defaultFilters ? "Assigned to you, not started" : "Matching your Tasks filters"}
      className={className}
      right={
        <Button variant="link" onClick={showTasksView}>
          View all{upNext.length > 0 ? ` ${upNext.length}` : ""} →
        </Button>
      }
    >
      <div className={styles.body}>
        {loading && rows.length === 0 ? (
          Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <div key={i} className={styles.skeleton} aria-hidden="true" />
          ))
        ) : rows.length === 0 ? (
          <p className={styles.empty}>
            {defaultFilters ? "No assigned tasks waiting to start." : "No tasks match your Tasks filters."}
          </p>
        ) : (
          <div
            className={`${tasksStyles.table} ${tasksStyles.compact}`}
            role="table"
            aria-label="Up next tasks"
          >
            {rows.map((row) => (
              <TaskTableRow
                key={row.key}
                row={row}
                now={now}
                showPriority={false}
                actionLabel="Start"
                onAction={() => void startTask(row)}
                compact
              />
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

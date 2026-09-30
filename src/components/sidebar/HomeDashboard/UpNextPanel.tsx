import { useMemo, useState } from "react";
import { useProjectStore } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import type { NewWorkspaceHandler } from "../../../lib/start-issue-work";
import { entryLookup, taskList } from "../../../lib/task-list";
import { trackerFor } from "../../../lib/trackers";
import { isDefaultFilters, useTaskPrefs } from "../../tasks/task-prefs";
import { useTaskScope, useTasks } from "../../tasks/useTasks";
import { useStartTask } from "../../tasks/useStartTask";
import { openLinkedTask } from "../../tasks/open-linked-task";
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
 * The Up next panel (ADR-198 §1.7, ADR-202 §4): the first rows of exactly
 * the list "View all" opens — the tracker and project last chosen in the
 * Tasks view, through that tracker's saved filters and sort, in-progress
 * linked tasks included when the filters let them through — in the Tasks
 * table's compact rows.
 */
export function UpNextPanel(props: UpNextPanelProps) {
  const { onNewWorkspace, className } = props;

  // The Tasks view isn't mounted alongside Home, so its choices can't change
  // while this is shown — read once.
  const prefs = useTaskPrefs();
  const scope = useTaskScope(prefs.provider, prefs.project);
  const { provider, projectKey } = scope;
  const filters = prefs.filtersBy[provider];
  const sort = prefs.sorts[provider];

  // Same queries as the Tasks view, so the two share one cache.
  const { rows: fetched, loading } = useTasks({ provider, projectKey });
  const projects = useProjectStore((s) => s.projects);
  const showTasksView = useAppStore((s) => s.showTasksView);
  const startTask = useStartTask(onNewWorkspace);
  const [now] = useState(() => Date.now());

  const list = useMemo(
    () =>
      taskList(
        { rows: fetched, projects, entryOf: entryLookup(projects) },
        { provider, projectKey, filters, sort },
      ),
    [fetched, projects, provider, projectKey, filters, sort],
  );

  // With no tracker usable the Tasks view shows its setup screen, not a list.
  const nothingConnected = scope.providers.length === 0 && !scope.checking;
  const rows = nothingConnected ? [] : list.top(VISIBLE_ROWS);
  const total = nothingConnected ? 0 : list.matching.length;
  const defaultFilters = isDefaultFilters(filters);

  const sub = [
    defaultFilters
      ? "Assigned to you, not started"
      : "Matching your Tasks filters",
    ...(nothingConnected ? [] : [trackerFor(provider).label]),
    ...(scope.selectedSource ? [scope.selectedSource.ctx.projectName] : []),
  ].join(" · ");

  return (
    <Panel
      title="Up next"
      sub={sub}
      className={className}
      right={
        <Button variant="link" onClick={showTasksView}>
          View all{total > 0 ? ` ${total}` : ""} →
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
            {defaultFilters || nothingConnected
              ? "No assigned tasks waiting to start."
              : "No tasks match your Tasks filters."}
          </p>
        ) : (
          <div
            className={`${tasksStyles.table} ${tasksStyles.compact}`}
            role="table"
            aria-label="Up next tasks"
          >
            {rows.map((row) =>
              "workspacePath" in row ? (
                <TaskTableRow
                  key={row.key}
                  row={row}
                  now={now}
                  showPriority={false}
                  actionLabel="Open"
                  onAction={() => openLinkedTask(row)}
                  compact
                />
              ) : (
                <TaskTableRow
                  key={row.key}
                  row={row}
                  now={now}
                  showPriority={false}
                  actionLabel="Start"
                  onAction={() => void startTask(row)}
                  compact
                />
              ),
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

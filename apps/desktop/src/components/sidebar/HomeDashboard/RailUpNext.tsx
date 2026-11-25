import { useMemo } from "react";
import { useProjectStore } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import type { NewWorkspaceHandler } from "../../../lib/start-issue-work";
import { entryLookup, taskList } from "../../../lib/task-list";
import { trackerFor } from "../../../lib/trackers";
import { isDefaultFilters, useTaskPrefs } from "../../tasks/task-prefs";
import { useTaskScope, useTasks } from "../../tasks/useTasks";
import { useStartTask } from "../../tasks/useStartTask";
import { openLinkedTask } from "../../tasks/open-linked-task";
import { Button } from "../../ui/Button/Button";
import { Link } from "../../ui/Link/Link";
import styles from "./DashboardRail.module.css";

const VISIBLE_ROWS = 3;

type RailUpNextProps = {
  onNewWorkspace?: NewWorkspaceHandler;
};

/**
 * The rail's Up next section: the first rows of exactly the list "View all"
 * opens — the tracker and project last chosen in the Tasks view, through
 * that tracker's saved filters and sort, in-progress linked tasks included
 * when the filters let them through — each with Start (or Open for a task
 * already in a workspace).
 */
export function RailUpNext(props: RailUpNextProps) {
  const { onNewWorkspace } = props;

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

  const source = nothingConnected
    ? null
    : [trackerFor(provider).label, scope.selectedSource?.ctx.projectName]
        .filter(Boolean)
        .join(" · ");

  return (
    <section className={styles.section} aria-label="Up next">
      <h2 className={styles.label}>
        Up next
        {total > 0 && <span className={styles.labelCount}>{total}</span>}
        {source && <span className={styles.labelAside}>{source}</span>}
      </h2>
      {loading && rows.length === 0 ? (
        <div aria-hidden="true">
          {Array.from({ length: VISIBLE_ROWS }, (_, i) => (
            <div key={i} className={styles.skeleton} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className={styles.note}>
          {nothingConnected
            ? "No task tracker connected."
            : isDefaultFilters(filters)
              ? "No assigned tasks waiting to start."
              : "No tasks match your Tasks filters."}
        </p>
      ) : (
        <ul className={styles.list} aria-label="Up next tasks">
          {rows.map((row) => {
            const linked = "workspacePath" in row;
            const action = linked ? "Open" : "Start";
            return (
              <li key={row.key} className={styles.taskRow}>
                <Link href={row.url} variant="plain" className={styles.rowText} title={`${row.displayId} ${row.title}`}>
                  {row.title}
                </Link>
                <Button
                  variant="secondary"
                  size="sm"
                  className={styles.taskAction}
                  aria-label={`${action} ${row.displayId}`}
                  onClick={() => (linked ? openLinkedTask(row) : void startTask(row))}
                >
                  {action}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <Button variant="link" className={styles.viewAll} onClick={() => showTasksView()}>
        {nothingConnected ? "Set up Tasks →" : "View all →"}
      </Button>
    </section>
  );
}

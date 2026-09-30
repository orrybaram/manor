import {
  useCallback,
  useDeferredValue,
  useMemo,
  useState,
} from "react";
import { useProjectStore } from "../../store/project-store";
import { useQueryClient } from "@tanstack/react-query";
import Search from "lucide-react/dist/esm/icons/search";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down";
import X from "lucide-react/dist/esm/icons/x";
import type { PaletteView } from "../command-palette/types";
import { GitHubNudge } from "../sidebar/GitHubNudge";
import { Button } from "../ui/Button/Button";
import { Link } from "../ui/Link/Link";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "../ui/SearchableSelect/SearchableSelect";
import { Input } from "../ui/Input";
import { projectColorStyle } from "../../hooks/useProjectHeaderRow";
import type { NewWorkspaceHandler } from "../../lib/start-issue-work";
import {
  DEFAULT_TASK_FILTERS,
  TASK_FIELDS,
  facetLabel,
  pageWindow,
  type TaskFieldId,
  type TaskFilters,
  type TaskProvider,
  type TaskSort,
} from "../../lib/tasks";
import { entryLookup, taskList } from "../../lib/task-list";
import { TRACKER_STATUS_KEY, trackerFor } from "../../lib/trackers";
import { useTaskScope, useTasks } from "./useTasks";
import { TaskFilterMenu } from "./TaskFilterMenu";
import { TaskSortMenu } from "./TaskSortMenu";
import { TaskTableRow } from "./TaskTableRow";
import { useStartTask } from "./useStartTask";
import { activeFilterCount, initialDirection } from "./task-menus";
import { isDefaultFilters, useTaskPrefs } from "./task-prefs";
import { openLinkedTask } from "./open-linked-task";
import { TrackerIcon } from "./tracker-icons";
import styles from "./TasksView.module.css";

type TasksViewProps = {
  onNewWorkspace: NewWorkspaceHandler;
  /**
   * Reserved for opening a task in the palette's detail view. The palette
   * can't yet be opened on a specific issue from outside, so rows open the
   * task's URL instead (ADR-198 §3).
   */
  onOpenPaletteView: (view: PaletteView) => void;
};

const ALL_PROJECTS = "__all__";

const NO_FILTERS: TaskFilters = {};

/** The table's sortable column headers, in column order (Priority is Linear's). */
const SORT_COLUMNS: { field: TaskFieldId; label: string }[] = [
  { field: "id", label: "ID" },
  { field: "title", label: "Title / Context" },
  { field: "assignee", label: "Assignees" },
  { field: "status", label: "Status" },
  { field: "priority", label: "Priority" },
  { field: "updated", label: "Updated" },
];

export function TasksView(props: TasksViewProps) {
  const { onNewWorkspace } = props;

  const queryClient = useQueryClient();

  const prefs = useTaskPrefs();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [page, setPage] = useState(1);
  const [now] = useState(() => Date.now());

  // The saved provider/project may no longer be usable (tracker
  // disconnected, project removed): fall back without forgetting the choice.
  const scope = useTaskScope(prefs.provider, prefs.project);
  const { providers, provider, projectKey, selectedSource } = scope;

  // Only projects the current tracker can be queried through.
  const projectOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: ALL_PROJECTS, label: "All projects" },
      ...scope.sources.map((s) => ({
        value: s.ctx.entryKey,
        label: s.ctx.projectName,
      })),
    ],
    [scope.sources],
  );

  const { rows, loading, failedCount } = useTasks({ provider, projectKey });

  const projects = useProjectStore((s) => s.projects);

  const sort = prefs.sorts[provider];
  const filters = prefs.filtersBy[provider];
  const filterCount = activeFilterCount(filters);
  const showPriority = provider === "linear";

  // A task linked to a workspace is listed once, as its in-progress link.
  // Facet counts in the filter menu come from `listed`, so they don't shift
  // as filters change.
  const list = useMemo(
    () =>
      taskList(
        { rows, projects, entryOf: entryLookup(projects) },
        { provider, projectKey, filters, sort, search: deferredSearch },
      ),
    [rows, projects, provider, projectKey, filters, sort, deferredSearch],
  );
  const { listed, filtered } = list;
  const current = list.page(page);
  const tracker = trackerFor(provider);
  const homeUrl = projectKey ? tracker.homeUrl(rows) : null;
  const projectCount = useMemo(
    () => new Set(listed.map((r) => r.projectEntryKey)).size,
    [listed],
  );

  const { setProvider, setProject, setSort, setFilters } = prefs;

  const chooseProvider = useCallback(
    (next: TaskProvider) => {
      setProvider(next);
      setPage(1);
    },
    [setProvider],
  );

  const changeFilters = useCallback(
    (next: TaskFilters) => {
      setFilters(provider, next);
      setPage(1);
    },
    [provider, setFilters],
  );

  const clearFilters = useCallback(
    () => changeFilters(NO_FILTERS),
    [changeFilters],
  );

  const resetFilters = useCallback(
    () => changeFilters(DEFAULT_TASK_FILTERS),
    [changeFilters],
  );
  const filtersAreDefault = isDefaultFilters(filters);

  const removeFilter = useCallback(
    (field: TaskFieldId) => {
      const next = { ...filters };
      delete next[field];
      changeFilters(next);
    },
    [filters, changeFilters],
  );

  const changeSort = useCallback(
    (next: TaskSort) => {
      setSort(provider, next);
      setPage(1);
    },
    [provider, setSort],
  );

  // A header sets the sort to its column; clicking the active one flips it.
  const sortByColumn = useCallback(
    (field: TaskFieldId) => {
      changeSort(
        field === sort.field
          ? { field, direction: sort.direction === "asc" ? "desc" : "asc" }
          : { field, direction: initialDirection(field) },
      );
    },
    [sort, changeSort],
  );

  const chooseProject = useCallback(
    (next: string) => {
      setProject(next === ALL_PROJECTS ? null : next);
      setPage(1);
    },
    [setProject],
  );

  const handleGitHubInstalled = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: TRACKER_STATUS_KEY("github"),
    });
  }, [queryClient]);

  const handleStart = useStartTask(onNewWorkspace);

  const nothingConnected = providers.length === 0 && !scope.checking;

  return (
    <div className={styles.page} data-testid="tasks-view">
      <div className={styles.content}>
        <div className={styles.header}>
          <h1 className={styles.heading}>Tasks</h1>
          <span className={styles.headerMeta}>
            {loading && listed.length === 0
              ? "Loading…"
              : (filterCount > 0
                  ? `${filtered.length} of ${plural(listed.length, "task")}`
                  : plural(listed.length, "task")) +
                ` · ${plural(projectCount, "project")}`}
          </span>
          {homeUrl && (
            <Link href={homeUrl} variant="plain" className={styles.openLink}>
              <ExternalLink size={13} />
              Open in {tracker.label}
            </Link>
          )}
        </div>

        {nothingConnected ? (
          <div className={styles.setup}>
            <p className={styles.setupText}>
              Connect a tracker to see your tasks from every project here.
            </p>
            <GitHubNudge onInstalled={handleGitHubInstalled} />
            <p className={styles.setupHint}>
              To use Linear, connect it in Settings and link a team to a
              project.
            </p>
          </div>
        ) : (
          <>
            <div className={styles.filters}>
              {providers.length > 0 && (
                <div
                  className={styles.providers}
                  role="group"
                  aria-label="Tracker"
                >
                  {providers.map((p) => (
                    <Tooltip key={p} label={trackerFor(p).label}>
                      <Button
                        variant="ghost"
                        className={`${styles.providerTab} ${p === provider ? styles.providerTabActive : ""}`}
                        aria-label={trackerFor(p).label}
                        aria-pressed={p === provider}
                        onClick={() => chooseProvider(p)}
                      >
                        <TrackerIcon provider={p} size={15} />
                      </Button>
                    </Tooltip>
                  ))}
                </div>
              )}
              {providers.length > 0 && (
                <SearchableSelect
                  value={projectKey ?? ALL_PROJECTS}
                  onChange={chooseProject}
                  options={projectOptions}
                  placeholder="All projects"
                  maxWidth={260}
                  icon={
                    <span
                      className={styles.projectDot}
                      style={projectColorStyle(selectedSource?.ctx.color)}
                    />
                  }
                  className={styles.projectSelect}
                  data-testid="tasks-project-select"
                />
              )}
              <div className={styles.searchBox}>
                <Search size={14} className={styles.searchIcon} />
                <Input
                  className={styles.searchInput}
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Search by title, ID or label"
                  aria-label="Search tasks"
                  spellCheck={false}
                />
              </div>
              <TaskFilterMenu
                provider={provider}
                rows={listed}
                filters={filters}
                onChange={changeFilters}
              />
              <TaskSortMenu
                provider={provider}
                sort={sort}
                onChange={changeSort}
              />
            </div>

            {(filterCount > 0 || !filtersAreDefault) && (
              <div
                className={styles.activeFilters}
                role="group"
                aria-label="Active filters"
              >
                {(Object.keys(TASK_FIELDS) as TaskFieldId[]).flatMap((id) => {
                  const values = filters[id] ?? [];
                  if (values.length === 0) return [];
                  const label = TASK_FIELDS[id].label;
                  const text = values.map((v) => facetLabel(id, v)).join(", ");
                  return [
                    <span key={id} className={styles.filterChip}>
                      <span className={styles.filterChipField}>{label}:</span>
                      <span className={styles.filterChipValues} title={text}>
                        {text}
                      </span>
                      <Button
                        variant="ghost"
                        className={styles.filterChipRemove}
                        aria-label={`Remove ${label} filter`}
                        onClick={() => removeFilter(id)}
                      >
                        <X size={12} />
                      </Button>
                    </span>,
                  ];
                })}
                {filterCount > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles.clearFilters}
                    onClick={clearFilters}
                  >
                    Clear all
                  </Button>
                )}
                {!filtersAreDefault && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles.clearFilters}
                    onClick={resetFilters}
                  >
                    Reset to default
                  </Button>
                )}
              </div>
            )}

            <div
              className={`${styles.table} ${showPriority ? styles.withPriority : ""}`}
              role="table"
              aria-label="Tasks"
            >
              <div className={`${styles.gridRow} ${styles.headRow}`} role="row">
                {SORT_COLUMNS.filter(
                  (c) => c.field !== "priority" || showPriority,
                ).map((c) => (
                  <SortHeader
                    key={c.field}
                    field={c.field}
                    label={c.label}
                    sort={sort}
                    onSort={sortByColumn}
                  />
                ))}
                <span role="columnheader" aria-label="Actions" />
              </div>
              {loading && listed.length === 0 ? (
                <TasksSkeleton showPriority={showPriority} />
              ) : current.rows.length === 0 &&
                filterCount > 0 &&
                filtered.length === 0 ? (
                <div className={`${styles.empty} ${styles.emptyFilters}`}>
                  No tasks match these filters.
                  <Button variant="secondary" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                </div>
              ) : current.rows.length === 0 ? (
                <div className={styles.empty}>
                  {deferredSearch.trim()
                    ? "No tasks match your search."
                    : "No open tasks."}
                </div>
              ) : (
                current.rows.map((row) =>
                  "workspacePath" in row ? (
                    <TaskTableRow
                      key={row.key}
                      row={row}
                      now={now}
                      showPriority={showPriority}
                      actionLabel="Open"
                      onAction={() => openLinkedTask(row)}
                    />
                  ) : (
                    <TaskTableRow
                      key={row.key}
                      row={row}
                      now={now}
                      showPriority={showPriority}
                      actionLabel="Start"
                      onAction={() => void handleStart(row)}
                    />
                  ),
                )
              )}
            </div>

            <div className={styles.footer}>
              {failedCount > 0 && (
                <span className={styles.failed}>
                  {failedCount} source{failedCount === 1 ? "" : "s"} failed
                </span>
              )}
              {current.pageCount > 1 && (
                <nav className={styles.pagination} aria-label="Pages">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={current.page <= 1}
                    onClick={() => setPage(current.page - 1)}
                  >
                    <ChevronLeft size={14} />
                    Previous
                  </Button>
                  {pageWindow(current.page, current.pageCount).map((p, i) =>
                    p === "gap" ? (
                      <span key={`gap-${i}`} className={styles.pageGap}>
                        …
                      </span>
                    ) : (
                      <Button
                        key={p}
                        variant="ghost"
                        size="sm"
                        className={`${styles.pageButton} ${p === current.page ? styles.pageButtonActive : ""}`}
                        aria-current={p === current.page ? "page" : undefined}
                        onClick={() => setPage(p)}
                      >
                        {p}
                      </Button>
                    ),
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={current.page >= current.pageCount}
                    onClick={() => setPage(current.page + 1)}
                  >
                    Next
                    <ChevronRight size={14} />
                  </Button>
                </nav>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

type SortHeaderProps = {
  field: TaskFieldId;
  label: string;
  sort: TaskSort;
  onSort: (field: TaskFieldId) => void;
};

/** A column header that sorts by its column; the active one shows its direction. */
function SortHeader(props: SortHeaderProps) {
  const { field, label, sort, onSort } = props;

  const active = sort.field === field;
  const Arrow = sort.direction === "asc" ? ArrowUp : ArrowDown;

  return (
    <span
      role="columnheader"
      aria-sort={
        active
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      <Button
        variant="ghost"
        className={`${styles.sortHeader} ${active ? styles.sortHeaderActive : ""}`}
        onClick={() => onSort(field)}
      >
        {label}
        {active && <Arrow size={11} aria-hidden />}
      </Button>
    </span>
  );
}

function TasksSkeleton(props: { showPriority: boolean }) {
  const { showPriority } = props;

  return (
    <div aria-busy="true" aria-label="Loading tasks">
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className={`${styles.gridRow} ${styles.bodyRow}`}
          role="row"
        >
          <span className={`${styles.bone} ${styles.boneId}`} />
          <span className={styles.titleCell}>
            <span
              className={`${styles.bone} ${styles.boneTitle}`}
              style={{ width: `${45 + ((i * 17) % 40)}%` }}
            />
            <span className={`${styles.bone} ${styles.boneContext}`} />
          </span>
          <span className={`${styles.bone} ${styles.boneAvatar}`} />
          <span className={`${styles.bone} ${styles.boneStatus}`} />
          {showPriority && (
            <span className={`${styles.bone} ${styles.bonePriority}`} />
          )}
          <span className={`${styles.bone} ${styles.boneUpdated}`} />
          <span />
        </div>
      ))}
    </div>
  );
}

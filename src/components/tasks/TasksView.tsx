import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppStore } from "../../store/app-store";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useProjectStore } from "../../store/project-store";
import { useTasksSummaryStore } from "../../store/tasks-summary-store";
import { useQueryClient } from "@tanstack/react-query";
import Search from "lucide-react/dist/esm/icons/search";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import X from "lucide-react/dist/esm/icons/x";
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
  fieldsFor,
  pageWindow,
  type TaskFieldId,
  type LinkedTask,
  type TaskFilters,
  type TaskProvider,
  type TaskRow,
  type TaskSort,
} from "../../lib/tasks";
import { entryLookup, taskList } from "../../lib/task-list";
import { TRACKER_STATUS_KEY, trackerFor } from "../../lib/trackers";
import { useTaskScope, useTasks } from "./useTasks";
import { TaskFilterChip, TaskFilterMenu } from "./TaskFilterMenu";
import { TaskSortMenu } from "./TaskSortMenu";
import { TaskTableRow } from "./TaskTableRow";
import { useStartTask } from "./useStartTask";
import { activeFilterCount, initialDirection } from "./task-menus";
import { isDefaultFilters, useTaskPrefs } from "./task-prefs";
import { openLinkedTask } from "./open-linked-task";
import { TrackerIcon, TrackerRowIcon } from "./tracker-icons";
import { TaskDetail } from "./TaskDetail/TaskDetail";
import styles from "./TasksView.module.css";

type TasksViewProps = {
  onNewWorkspace: NewWorkspaceHandler;
  /** Launches an agent in the active workspace — the drawer's New agent here. */
  onNewAgentWithPrompt?: (prompt: string) => void;
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
  const { onNewWorkspace, onNewAgentWithPrompt } = props;

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
      {
        value: ALL_PROJECTS,
        label: "All projects",
        icon: <span className={styles.projectDot} />,
      },
      ...scope.sources.map((s) => ({
        value: s.ctx.entryKey,
        label: s.ctx.projectName,
        icon: (
          <span
            className={styles.projectDot}
            style={projectColorStyle(s.ctx.color)}
          />
        ),
      })),
    ],
    [scope.sources],
  );

  const { rows, loading, failedCount, failures } = useTasks({
    provider,
    projectKey,
  });

  const projects = useProjectStore((s) => s.projects);

  const sort = prefs.sorts[provider];
  const filters = prefs.filtersBy[provider];
  const filterCount = activeFilterCount(filters);
  const showPriority = fieldsFor(provider).includes("priority");

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

  // ADR-207 §3: the row whose detail is open in the drawer. It only stays
  // open while that row is on the current page.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const openIndex =
    openKey === null ? -1 : current.rows.findIndex((r) => r.key === openKey);
  const openRow = openIndex >= 0 ? current.rows[openIndex] : undefined;
  if (openKey !== null && !openRow) setOpenKey(null);
  const drawerOpen = openRow !== undefined;

  // ADR-207 §5: "See all" (palette) and friends open this view on a search
  // / project. The intent is one-shot — consumed on mount and whenever a new
  // one arrives while the view is open.
  useMountEffect(() => {
    const applyIntent = () => {
      const intent = useAppStore.getState().consumeTasksIntent();
      if (!intent) return;
      if (intent.search !== undefined) setSearch(intent.search);
      if (intent.project !== undefined) setProject(intent.project);
      setPage(1);
      setOpenKey(null);
    };
    applyIntent();
    return useAppStore.subscribe((s, prev) => {
      if (s.tasksIntent && s.tasksIntent !== prev.tasksIntent) applyIntent();
    });
  });

  const tableRef = useRef<HTMLDivElement>(null);

  const focusTitle = useCallback((key: string) => {
    requestAnimationFrame(() => {
      tableRef.current
        ?.querySelector<HTMLElement>(
          `[data-task-key="${CSS.escape(key)}"] [data-task-title]`,
        )
        ?.focus();
    });
  }, []);

  // Closing hands focus back to the row the drawer was showing.
  const closeDrawer = useCallback(() => {
    if (openKey !== null) focusTitle(openKey);
    setOpenKey(null);
  }, [openKey, focusTitle]);

  const prevKey = openIndex > 0 ? current.rows[openIndex - 1].key : null;
  const nextKey =
    openIndex >= 0 && openIndex < current.rows.length - 1
      ? current.rows[openIndex + 1].key
      : null;

  const moveTo = useCallback((key: string | null) => {
    if (key === null) return;
    setOpenKey(key);
    requestAnimationFrame(() => {
      const row = tableRef.current?.querySelector(
        `[data-task-key="${CSS.escape(key)}"]`,
      );
      row?.scrollIntoView({ block: "nearest" });
      // Focus on a title follows the selection, so Enter opens what's shown.
      if (document.activeElement?.hasAttribute("data-task-title")) {
        row?.querySelector<HTMLElement>("[data-task-title]")?.focus();
      }
    });
  }, []);

  // ↑/↓ (j/k) step through the page's rows, Esc closes — not while typing.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (keysBelongElsewhere(e.target)) return;
      if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        moveTo(prevKey);
      } else if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        moveTo(nextKey);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeDrawer();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen, prevKey, nextKey, moveTo, closeDrawer]);

  // Assignees and Priority make room for the drawer.
  const tableShowsPriority = showPriority && !drawerOpen;

  const nothingConnected = providers.length === 0 && !scope.checking;
  // Some sources answered, others are still out: the rows are partial.
  const loadingMore = loading && listed.length > 0;

  // The count line lives in the status bar while this view is open.
  const summary =
    loading && listed.length === 0
      ? "Loading…"
      : (filterCount > 0
          ? `${filtered.length} of ${plural(listed.length, "task")}`
          : plural(listed.length, "task")) +
        ` · ${plural(projectCount, "project")}`;
  const setSummary = useTasksSummaryStore((s) => s.setSummary);
  useEffect(() => {
    setSummary(summary);
  }, [summary, setSummary]);
  useEffect(() => () => setSummary(null), [setSummary]);

  return (
    <div className={styles.page} data-testid="tasks-view">
      <div className={styles.content}>
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
                {(Object.keys(TASK_FIELDS) as TaskFieldId[])
                  .filter((id) => (filters[id]?.length ?? 0) > 0)
                  .map((id) => (
                    <TaskFilterChip
                      key={id}
                      field={id}
                      rows={listed}
                      filters={filters}
                      onChange={changeFilters}
                      onRemove={() => removeFilter(id)}
                    />
                  ))}
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

            <div className={styles.tableArea}>
              <div
                ref={tableRef}
                className={`${styles.table} ${tableShowsPriority ? styles.withPriority : ""} ${drawerOpen ? styles.withDrawer : ""}`}
                role="table"
                aria-label="Tasks"
                aria-busy={loading}
              >
                <div
                  className={`${styles.gridRow} ${styles.headRow}`}
                  role="row"
                >
                  <span role="columnheader" aria-label="Actions" />
                  {SORT_COLUMNS.filter(
                    (c) =>
                      !(drawerOpen && c.field === "assignee") &&
                      (c.field !== "priority" || tableShowsPriority),
                  ).map((c) => (
                    <SortHeader
                      key={c.field}
                      field={c.field}
                      label={c.label}
                      sort={sort}
                      onSort={sortByColumn}
                    />
                  ))}
                </div>
                {loading && listed.length === 0 ? (
                  <TasksSkeleton
                    showPriority={tableShowsPriority}
                    showAssignees={!drawerOpen}
                  />
                ) : current.rows.length === 0 &&
                  filterCount > 0 &&
                  filtered.length === 0 ? (
                  <div className={`${styles.empty} ${styles.emptyFilters}`}>
                    No tasks match these filters.
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={clearFilters}
                    >
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
                        showPriority={tableShowsPriority}
                        showAssignees={!drawerOpen}
                        actionLabel="Open"
                        onAction={() => openLinkedTask(row)}
                        onOpen={() => setOpenKey(row.key)}
                        selected={row.key === openKey}
                      />
                    ) : (
                      <TaskTableRow
                        key={row.key}
                        row={row}
                        now={now}
                        showPriority={tableShowsPriority}
                        showAssignees={!drawerOpen}
                        actionLabel="Start"
                        onAction={() => void handleStart(row)}
                        onOpen={() => setOpenKey(row.key)}
                        selected={row.key === openKey}
                      />
                    ),
                  )
                )}
              </div>
              {openRow && (
                <TaskDrawer
                  row={openRow}
                  onPrev={prevKey === null ? undefined : () => moveTo(prevKey)}
                  onNext={nextKey === null ? undefined : () => moveTo(nextKey)}
                  onClose={closeDrawer}
                  onNewWorkspace={onNewWorkspace}
                  onNewAgentWithPrompt={onNewAgentWithPrompt}
                />
              )}
            </div>

            {(loadingMore || failedCount > 0 || current.pageCount > 1) && (
              <div className={styles.footer}>
                {loadingMore && (
                  <span
                    className={styles.loadingMore}
                    role="status"
                    data-testid="tasks-loading-more"
                  >
                    <Loader2 size={12} className={styles.spinner} aria-hidden />
                    Loading more tasks…
                  </span>
                )}
                {failedCount > 0 && (
                  <Tooltip label={failures.join("\n")} side="top">
                    <span className={styles.failed} tabIndex={0}>
                      {failedCount} source{failedCount === 1 ? "" : "s"} failed
                    </span>
                  </Tooltip>
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
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Keys typed into a field, or handled by an open menu / listbox / dialog, aren't the drawer's. */
function keysBelongElsewhere(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest(
        'input, textarea, select, [role="menu"], [role="listbox"], [role="dialog"]',
      ) !== null)
  );
}

type TaskDrawerProps = {
  row: TaskRow | LinkedTask;
  /** Undefined at the first / last row of the page. */
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
  onNewWorkspace: NewWorkspaceHandler;
  onNewAgentWithPrompt?: (prompt: string) => void;
};

/**
 * ADR-207 §3: the open row's `TaskDetail`, in a panel beside the table. A
 * tracker row opens in `default` mode; a task linked to a workspace resolves
 * its ref from the link and opens in `linked` mode.
 */
function TaskDrawer(props: TaskDrawerProps) {
  const { row, onPrev, onNext, onClose, onNewWorkspace, onNewAgentWithPrompt } =
    props;

  const tracker = trackerFor(row.provider);
  const projects = useProjectStore((s) => s.projects);
  const linked = "workspacePath" in row ? row : null;
  const listed = "workspacePath" in row ? null : row;

  const taskRef = useMemo(() => {
    if (listed) return tracker.refOf(listed);
    if (!linked) return null;
    const project = projects.find((p) => p.id === linked.projectId);
    const ws = project?.workspaces.find((w) => w.path === linked.workspacePath);
    const link = ws?.linkedIssues?.find(
      (l) => linked.key === `linked:${ws.path}:${l.id}`,
    );
    return project && link ? tracker.refFromLink(link, project) : null;
  }, [linked, listed, tracker, projects]);

  const openLabel = `Open in ${tracker.label}`;

  return (
    <aside
      className={styles.drawer}
      aria-label={`Task ${row.displayId}`}
      data-testid="task-drawer"
    >
      <div className={styles.drawerHeader}>
        <Tooltip label="Previous task (↑)">
          <Button
            variant="ghost"
            className={styles.drawerIconButton}
            aria-label="Previous task"
            disabled={!onPrev}
            onClick={onPrev}
          >
            <ChevronUp size={15} />
          </Button>
        </Tooltip>
        <Tooltip label="Next task (↓)">
          <Button
            variant="ghost"
            className={styles.drawerIconButton}
            aria-label="Next task"
            disabled={!onNext}
            onClick={onNext}
          >
            <ChevronDown size={15} />
          </Button>
        </Tooltip>
        <span className={styles.idChip}>
          <TrackerRowIcon provider={row.provider} />
          {row.displayId}
        </span>
        <Tooltip label={openLabel}>
          <Link
            href={row.url}
            variant="plain"
            className={styles.drawerOpenLink}
            aria-label={openLabel}
          >
            <ExternalLink size={14} aria-hidden />
          </Link>
        </Tooltip>
        <span className={styles.drawerSpacer} />
        {linked && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openLinkedTask(linked)}
          >
            Open workspace
          </Button>
        )}
        <Tooltip label="Close (Esc)">
          <Button
            variant="ghost"
            className={styles.drawerIconButton}
            aria-label="Close task"
            onClick={onClose}
          >
            <X size={15} />
          </Button>
        </Tooltip>
      </div>
      {taskRef &&
        (linked ? (
          <TaskDetail
            key={row.key}
            taskRef={taskRef}
            mode="linked"
            layout="drawer"
            linkedTo={linked.workspaceName}
            projectId={linked.projectId}
            workspacePath={linked.workspacePath}
            onNewWorkspace={onNewWorkspace}
            onDone={onClose}
            keyboard={false}
          />
        ) : (
          <TaskDetail
            key={row.key}
            taskRef={taskRef}
            row={listed ?? undefined}
            mode="default"
            layout="drawer"
            onNewWorkspace={onNewWorkspace}
            onNewAgentWithPrompt={onNewAgentWithPrompt}
            onDone={onClose}
            keyboard={false}
          />
        ))}
    </aside>
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

function TasksSkeleton(props: {
  showPriority: boolean;
  showAssignees: boolean;
}) {
  const { showPriority, showAssignees } = props;

  return (
    <div aria-busy="true" aria-label="Loading tasks">
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className={`${styles.gridRow} ${styles.bodyRow}`}
          role="row"
        >
          <span />
          <span className={`${styles.bone} ${styles.boneId}`} />
          <span className={styles.titleCell}>
            <span
              className={`${styles.bone} ${styles.boneTitle}`}
              style={{ width: `${45 + ((i * 17) % 40)}%` }}
            />
            <span className={`${styles.bone} ${styles.boneContext}`} />
          </span>
          {showAssignees && (
            <span className={`${styles.bone} ${styles.boneAvatar}`} />
          )}
          <span className={`${styles.bone} ${styles.boneStatus}`} />
          {showPriority && (
            <span className={`${styles.bone} ${styles.bonePriority}`} />
          )}
          <span className={`${styles.bone} ${styles.boneUpdated}`} />
        </div>
      ))}
    </div>
  );
}

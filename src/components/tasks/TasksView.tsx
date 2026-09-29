import {
  useCallback,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import { buildTopLevelEntries } from "../../utils/sidebar-items";
import { useQueryClient } from "@tanstack/react-query";
import Search from "lucide-react/dist/esm/icons/search";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import CircleDot from "lucide-react/dist/esm/icons/circle-dot";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down";
import FolderKanban from "lucide-react/dist/esm/icons/folder-kanban";
import Milestone from "lucide-react/dist/esm/icons/milestone";
import IterationCw from "lucide-react/dist/esm/icons/iteration-cw";
import X from "lucide-react/dist/esm/icons/x";
import type { PaletteView } from "../command-palette/types";
import { GitHubIcon } from "../command-palette/GitHubIcon";
import { LinearIcon } from "../command-palette/LinearIcon";
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
import { ghRepoOf } from "../../lib/gh-repo";
import {
  startGitHubIssueWork,
  startLinearIssueWork,
  type NewWorkspaceHandler,
} from "../../lib/start-issue-work";
import {
  DEFAULT_TASK_FILTERS,
  DEFAULT_TASK_SORT,
  TASK_FIELDS,
  applyTaskFilters,
  facetLabel,
  filterTasks,
  sortTasksBy,
  filterableFields,
  sortableFields,
  withoutLinkedTasks,
  linkedTasks,
  type LinkedTask,
  initialOf,
  pageWindow,
  paginate,
  relativeTime,
  trackerHomeUrl,
  type TaskFieldId,
  type TaskFilters,
  type TaskProvider,
  type TaskRow,
  type TaskSort,
} from "../../lib/tasks";
import { useTasks, useTrackerSources } from "./useTasks";
import { TaskFilterMenu } from "./TaskFilterMenu";
import { TaskSortMenu } from "./TaskSortMenu";
import { activeFilterCount, initialDirection } from "./task-menus";
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
const MAX_AVATARS = 3;

const PREF_PROVIDER = "tasks-view:provider";
const PREF_PROJECT = "tasks-view:project";
/** Followed by the provider: each tracker remembers its own sort and filters. */
const PREF_SORT = "tasks-view:sort:";
const PREF_FILTERS = "tasks-view:filters:";

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable — the choice just isn't remembered.
  }
}

/** A provider's saved sort, if it's still a sortable field of it; else the default. */
function readSort(provider: TaskProvider): TaskSort {
  const raw = readPref(PREF_SORT + provider);
  if (!raw) return DEFAULT_TASK_SORT;
  try {
    const saved = JSON.parse(raw) as { field?: unknown; direction?: unknown };
    const field = sortableFields(provider).find((id) => id === saved.field);
    if (field && (saved.direction === "asc" || saved.direction === "desc")) {
      return { field, direction: saved.direction };
    }
  } catch {
    // Not JSON — fall through to the default.
  }
  return DEFAULT_TASK_SORT;
}

/** A provider's saved filters, keeping only fields it can still filter on; else the defaults. */
function readFilters(provider: TaskProvider): TaskFilters {
  const raw = readPref(PREF_FILTERS + provider);
  if (!raw) return DEFAULT_TASK_FILTERS;
  try {
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const out: TaskFilters = {};
    for (const field of filterableFields(provider)) {
      const values = saved[field];
      if (Array.isArray(values) && values.every((v) => typeof v === "string")) {
        out[field] = values;
      }
    }
    return out;
  } catch {
    return DEFAULT_TASK_FILTERS;
  }
}

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

const PROVIDER_LABEL: Record<TaskProvider, string> = {
  github: "GitHub",
  linear: "Linear",
};

function ProviderIcon(props: { provider: TaskProvider; size: number }) {
  const { provider, size } = props;

  return provider === "github" ? (
    <GitHubIcon size={size} />
  ) : (
    <LinearIcon size={size} />
  );
}

export function TasksView(props: TasksViewProps) {
  const { onNewWorkspace } = props;

  const queryClient = useQueryClient();

  const [savedProvider, setSavedProvider] = useState<TaskProvider>(() =>
    readPref(PREF_PROVIDER) === "linear" ? "linear" : "github",
  );
  const [savedProject, setSavedProject] = useState<string>(
    () => readPref(PREF_PROJECT) ?? ALL_PROJECTS,
  );
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [page, setPage] = useState(1);
  const [now] = useState(() => Date.now());
  const [sorts, setSorts] = useState<Record<TaskProvider, TaskSort>>(() => ({
    github: readSort("github"),
    linear: readSort("linear"),
  }));
  // Each provider keeps its own filters — their fields differ.
  const [filtersBy, setFiltersBy] = useState<Record<TaskProvider, TaskFilters>>(
    () => ({
      github: readFilters("github"),
      linear: readFilters("linear"),
    }),
  );

  // The saved provider/project may no longer be usable (tracker
  // disconnected, project removed): fall back without forgetting the choice.
  const status = useTrackerSources();
  const providers = useMemo(() => {
    const out: TaskProvider[] = [];
    if (status.ghReady) out.push("github");
    if (status.linearConnected) out.push("linear");
    return out;
  }, [status.ghReady, status.linearConnected]);
  const provider: TaskProvider = providers.includes(savedProvider)
    ? savedProvider
    : (providers[0] ?? savedProvider);

  // Only projects the current tracker can be queried through.
  const projectOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: ALL_PROJECTS, label: "All projects" },
      ...status.sources
        .filter((s) => s.provider === provider)
        .map((s) => ({ value: s.ctx.entryKey, label: s.ctx.projectName })),
    ],
    [status.sources, provider],
  );
  const projectKey =
    savedProject !== ALL_PROJECTS &&
    projectOptions.some((o) => o.value === savedProject)
      ? savedProject
      : null;
  const selectedSource = projectKey
    ? status.sources.find(
        (s) => s.provider === provider && s.ctx.entryKey === projectKey,
      )
    : undefined;

  const { rows, loading, failedCount } = useTasks({ provider, projectKey });

  // A task linked to a workspace is listed once, as its in-progress link.
  const projects = useProjectStore((s) => s.projects);
  const unlinked = useMemo(
    () => withoutLinkedTasks(rows, projects),
    [rows, projects],
  );

  const linked = useMemo(() => {
    const entryOf = entryLookup(projects);
    return linkedTasks(projects, entryOf, rows).filter(
      (t) =>
        t.provider === provider &&
        (projectKey === null || t.projectEntryKey === projectKey),
    );
  }, [projects, rows, provider, projectKey]);

  const sort = sorts[provider];
  const filters = filtersBy[provider];
  const filterCount = activeFilterCount(filters);
  const showPriority = provider === "linear";

  // Filters, then search, then sort, then the page. Facet counts in the
  // filter menu come from `listed`, so they don't shift as filters change.
  const listed = useMemo<(TaskRow | LinkedTask)[]>(
    () => [...unlinked, ...linked],
    [unlinked, linked],
  );
  const narrowed = useMemo(
    () => applyTaskFilters(listed, filters),
    [listed, filters],
  );
  const searched = useMemo(
    () => filterTasks(narrowed, deferredSearch),
    [narrowed, deferredSearch],
  );
  const sorted = useMemo(() => sortTasksBy(searched, sort), [searched, sort]);
  const current = paginate(sorted, page);
  const homeUrl = projectKey ? trackerHomeUrl(rows, provider) : null;
  const projectCount = useMemo(
    () => new Set(listed.map((r) => r.projectEntryKey)).size,
    [listed],
  );

  const chooseProvider = useCallback((next: TaskProvider) => {
    setSavedProvider(next);
    writePref(PREF_PROVIDER, next);
    setPage(1);
  }, []);

  const changeFilters = useCallback(
    (next: TaskFilters) => {
      setFiltersBy((prev) => ({ ...prev, [provider]: next }));
      writePref(PREF_FILTERS + provider, JSON.stringify(next));
      setPage(1);
    },
    [provider],
  );

  const clearFilters = useCallback(
    () => changeFilters(NO_FILTERS),
    [changeFilters],
  );

  const resetFilters = useCallback(
    () => changeFilters(DEFAULT_TASK_FILTERS),
    [changeFilters],
  );
  const filtersAreDefault =
    JSON.stringify(filters) === JSON.stringify(DEFAULT_TASK_FILTERS);

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
      setSorts((prev) => ({ ...prev, [provider]: next }));
      writePref(PREF_SORT + provider, JSON.stringify(next));
      setPage(1);
    },
    [provider],
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

  const chooseProject = useCallback((next: string) => {
    setSavedProject(next);
    writePref(PREF_PROJECT, next);
    setPage(1);
  }, []);

  const handleGitHubInstalled = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ["home-up-next", "gh-status"],
    });
  }, [queryClient]);

  // A start fetches the task's body first; ignore repeat clicks meanwhile.
  const startingRef = useRef(false);
  const handleStart = useCallback(
    async (row: TaskRow) => {
      if (startingRef.current) return;
      startingRef.current = true;
      try {
        const { project } = row;
        if (row.raw.provider === "github") {
          const listed = row.raw.issue;
          const repo = ghRepoOf(project);
          // Same key as the palette's detail view, so they share the cache.
          // Title only if the detail fetch fails.
          const detail = await queryClient
            .fetchQuery({
              queryKey: [
                "github-issue-detail",
                repo.hostId,
                repo.path,
                listed.number,
                listed.url,
              ],
              queryFn: () =>
                window.electronAPI.github.getIssueDetail(
                  repo,
                  listed.number,
                  listed.url,
                ),
              staleTime: 60_000,
              retry: false,
            })
            .catch(() => null);
          startGitHubIssueWork({
            project,
            repo,
            issue: { ...listed, body: detail?.body ?? null },
            onNewWorkspace,
          });
        } else {
          const listed = row.raw.issue;
          const detail = await queryClient
            .fetchQuery({
              queryKey: ["linear-issue-detail", listed.id],
              queryFn: () =>
                window.electronAPI.linear.getIssueDetail(listed.id),
              staleTime: 60_000,
              retry: false,
            })
            .catch(() => null);
          startLinearIssueWork({
            project,
            issue: { ...listed, description: detail?.description ?? null },
            onNewWorkspace,
          });
        }
      } finally {
        startingRef.current = false;
      }
    },
    [queryClient, onNewWorkspace],
  );

  const openLinked = useCallback((task: LinkedTask) => {
    const store = useProjectStore.getState();
    const project = store.projects.find((p) => p.id === task.projectId);
    const index =
      project?.workspaces.findIndex((ws) => ws.path === task.workspacePath) ??
      -1;
    // Also flips `activeSurface` back to "workspace" via `setActiveWorkspace`.
    if (index >= 0) store.selectWorkspace(task.projectId, index);
  }, []);

  const nothingConnected = providers.length === 0 && !status.checking;

  return (
    <div className={styles.page} data-testid="tasks-view">
      <div className={styles.content}>
        <div className={styles.header}>
          <h1 className={styles.heading}>Tasks</h1>
          <span className={styles.headerMeta}>
            {loading && listed.length === 0
              ? "Loading…"
              : (filterCount > 0
                  ? `${narrowed.length} of ${plural(listed.length, "task")}`
                  : plural(listed.length, "task")) +
                ` · ${plural(projectCount, "project")}`}
          </span>
          {homeUrl && (
            <Link href={homeUrl} variant="plain" className={styles.openLink}>
              <ExternalLink size={13} />
              Open in {PROVIDER_LABEL[provider]}
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
                    <Tooltip key={p} label={PROVIDER_LABEL[p]}>
                      <Button
                        variant="ghost"
                        className={`${styles.providerTab} ${p === provider ? styles.providerTabActive : ""}`}
                        aria-label={PROVIDER_LABEL[p]}
                        aria-pressed={p === provider}
                        onClick={() => chooseProvider(p)}
                      >
                        <ProviderIcon provider={p} size={15} />
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
                narrowed.length === 0 ? (
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
                      onAction={() => openLinked(row)}
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

/** Each project's sidebar entry: a linked group's key, name and colour, or its own. */
function entryLookup(projects: readonly ProjectInfo[]) {
  const byProject = new Map<
    string,
    { entryKey: string; projectName: string; color: string | null }
  >();
  for (const entry of buildTopLevelEntries(projects)) {
    if (entry.kind === "project") {
      byProject.set(entry.project.id, {
        entryKey: entry.key,
        projectName: entry.project.name,
        color: entry.project.color,
      });
    } else {
      for (const section of entry.sections) {
        byProject.set(section.project.id, {
          entryKey: entry.key,
          projectName: entry.group.name,
          color: section.project.color,
        });
      }
    }
  }
  return (project: ProjectInfo) =>
    byProject.get(project.id) ?? {
      entryKey: project.id,
      projectName: project.name,
      color: project.color,
    };
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

/** Linear's priority glyph: an alert square for Urgent, else 3 bars — High 3 lit, Medium 2, Low 1. */
function PriorityIcon(props: { value: number }) {
  const { value } = props;

  if (value === 1) {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        className={styles.priorityUrgent}
        aria-hidden
      >
        <rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" />
        <path
          d="M8 4.5v4.5"
          stroke="var(--bg)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="8" cy="11.75" r="1.1" fill="var(--bg)" />
      </svg>
    );
  }
  const lit = 5 - value;
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      className={styles.priorityBars}
      aria-hidden
    >
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={1.5 + i * 5}
          y={10 - i * 4}
          width="3"
          height={5 + i * 4}
          rx="1"
          fill="currentColor"
          opacity={i < lit ? 1 : 0.3}
        />
      ))}
    </svg>
  );
}

type TaskTableRowProps = {
  row: TaskRow | LinkedTask;
  now: number;
  /** Linear's Priority column. */
  showPriority: boolean;
  /** "Start" for a tracker row, "Open" (go to its workspace) for a linked one. */
  actionLabel: string;
  onAction: () => void;
};

function TaskTableRow(props: TaskTableRowProps) {
  const { row, now, showPriority, actionLabel, onAction } = props;

  const shownAssignees = row.assignees.slice(0, MAX_AVATARS);
  const hiddenAssignees = row.assignees.length - shownAssignees.length;
  const updated = relativeTime(row.updatedAt, now);

  return (
    <div
      className={`${styles.gridRow} ${styles.bodyRow}`}
      role="row"
      data-testid="task-row"
    >
      <span role="cell">
        <Link href={row.url} variant="plain" className={styles.idChip}>
          {row.provider === "github" ? (
            <CircleDot size={11} />
          ) : (
            <LinearIcon size={10} />
          )}
          {row.displayId}
        </Link>
      </span>
      <span role="cell" className={styles.titleCell}>
        <Link href={row.url} variant="plain" className={styles.taskTitle}>
          {row.title}
        </Link>
        <span className={styles.context}>
          <span
            className={styles.projectName}
            style={projectColorStyle(row.color)}
          >
            {row.projectName}
          </span>
          {"workspaceName" in row && (
            <span className={styles.workspaceName}>
              <GitBranch size={11} />
              {row.workspaceName}
            </span>
          )}
          {row.trackerProjects.map((name) => (
            <span key={`p:${name}`} className={styles.contextChip}>
              <FolderKanban size={11} aria-hidden />
              {name}
            </span>
          ))}
          {row.milestone && (
            <span className={styles.contextChip}>
              <Milestone size={11} aria-hidden />
              {row.milestone}
            </span>
          )}
          {row.cycle && (
            <span className={styles.contextChip}>
              <IterationCw size={11} aria-hidden />
              {row.cycle}
            </span>
          )}
          {row.author && <span className={styles.author}>by {row.author}</span>}
          {row.labels.map((label) => (
            <span
              key={label.name}
              className={styles.label}
              style={
                label.color
                  ? ({ "--label-color": label.color } as CSSProperties)
                  : undefined
              }
            >
              {label.name}
            </span>
          ))}
        </span>
      </span>
      <span role="cell" className={styles.avatars}>
        {shownAssignees.map((name) => (
          <Tooltip key={name} label={name}>
            <span className={styles.avatar} aria-label={name}>
              {initialOf(name)}
            </span>
          </Tooltip>
        ))}
        {hiddenAssignees > 0 && (
          <span className={styles.avatarMore}>+{hiddenAssignees}</span>
        )}
        {row.assignees.length === 0 && <span className={styles.dim}>—</span>}
      </span>
      <span role="cell">
        <span
          className={`${styles.status} ${styles[`tone-${row.status.tone}`]}`}
        >
          {row.status.label}
        </span>
      </span>
      {showPriority && (
        <span role="cell" className={styles.priority}>
          {row.priority && row.priority.value > 0 ? (
            <>
              <PriorityIcon value={row.priority.value} />
              {row.priority.label}
            </>
          ) : (
            <span className={styles.dim}>—</span>
          )}
        </span>
      )}
      <span role="cell" className={styles.updated}>
        {updated || <span className={styles.dim}>—</span>}
      </span>
      <span role="cell" className={styles.actionCell}>
        <Button
          variant="secondary"
          size="sm"
          className={styles.startButton}
          onClick={onAction}
          aria-label={`${actionLabel} ${row.displayId}`}
        >
          {actionLabel}
          <ArrowRight size={13} />
        </Button>
      </span>
    </div>
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

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
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import CircleDot from "lucide-react/dist/esm/icons/circle-dot";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import type { PaletteView } from "../command-palette/types";
import { GitHubIcon } from "../command-palette/GitHubIcon";
import { LinearIcon } from "../command-palette/LinearIcon";
import { GitHubNudge } from "../sidebar/GitHubNudge";
import { Button } from "../ui/Button/Button";
import { Link } from "../ui/Link/Link";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { ToggleGroup } from "../ui/ToggleGroup";
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
  filterTasks,
  withoutLinkedTasks,
  linkedTasks,
  type LinkedTask,
  initialOf,
  pageWindow,
  paginate,
  relativeTime,
  trackerHomeUrl,
  type TaskFilter,
  type TaskProvider,
  type TaskRow,
} from "../../lib/tasks";
import { useTasks, useTrackerSources } from "./useTasks";
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
const PREF_FILTER = "tasks-view:filter";
const PREF_PROJECT = "tasks-view:project";

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

/** The filter row's choices: the two tracker queries, plus tasks linked to a workspace. */
type TaskListMode = TaskFilter | "in-progress";

const FILTER_OPTIONS: { value: TaskListMode; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "assigned", label: "Assigned to me" },
  { value: "in-progress", label: "In progress" },
];

function readMode(): TaskListMode {
  const saved = readPref(PREF_FILTER);
  return saved === "open" || saved === "in-progress" ? saved : "assigned";
}

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
  const [mode, setMode] = useState<TaskListMode>(readMode);
  const inProgress = mode === "in-progress";
  // In progress lists workspace links; the assigned query fills in their
  // labels, assignees and status (starting a task assigns it to you).
  const filter: TaskFilter = inProgress ? "assigned" : mode;
  const [savedProject, setSavedProject] = useState<string>(
    () => readPref(PREF_PROJECT) ?? ALL_PROJECTS,
  );
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [page, setPage] = useState(1);
  const [now, setNow] = useState(() => Date.now());

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

  const { rows, loading, failedCount, refetch } = useTasks({
    provider,
    projectKey,
    filter,
  });

  // Tasks already linked to a workspace are being worked on — hide them.
  const projects = useProjectStore((s) => s.projects);
  const unlinked = useMemo(
    () => withoutLinkedTasks(rows, projects),
    [rows, projects],
  );
  const linkedCount = rows.length - unlinked.length;

  const linked = useMemo(() => {
    const entryOf = entryLookup(projects);
    return linkedTasks(projects, entryOf, rows).filter(
      (t) =>
        t.provider === provider &&
        (projectKey === null || t.projectEntryKey === projectKey),
    );
  }, [projects, rows, provider, projectKey]);

  const listed: (TaskRow | LinkedTask)[] = inProgress ? linked : unlinked;
  const filtered = useMemo(
    () => filterTasks(listed, deferredSearch),
    [listed, deferredSearch],
  );
  const current = paginate(filtered, page);
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

  const chooseFilter = useCallback((next: TaskListMode) => {
    setMode(next);
    writePref(PREF_FILTER, next);
    setPage(1);
  }, []);

  const chooseProject = useCallback((next: string) => {
    setSavedProject(next);
    writePref(PREF_PROJECT, next);
    setPage(1);
  }, []);

  const handleRefresh = useCallback(() => {
    setNow(Date.now());
    refetch();
  }, [refetch]);

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
            {loading && rows.length === 0 && !inProgress
              ? "Loading…"
              : `${plural(listed.length, "task")} · ${plural(projectCount, "project")}` +
                (!inProgress && linkedCount > 0
                  ? ` · ${linkedCount} in progress`
                  : "")}
          </span>
          <div className={styles.headerControls}>
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
                data-testid="tasks-project-select"
              />
            )}
            {homeUrl && (
              <Link href={homeUrl} variant="plain" className={styles.openLink}>
                <ExternalLink size={13} />
                Open in {PROVIDER_LABEL[provider]}
              </Link>
            )}
          </div>
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
              {/* A wrapper, so the group centres in the row (it pins itself to flex-start). */}
              <div className={styles.filterToggle}>
                <ToggleGroup
                  value={mode}
                  onChange={chooseFilter}
                  options={FILTER_OPTIONS}
                  size="sm"
                  aria-label="Which tasks"
                  activationMode="manual"
                />
              </div>
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
              <Tooltip label="Refresh">
                <Button
                  variant="secondary"
                  className={styles.iconButton}
                  aria-label="Refresh"
                  onClick={handleRefresh}
                >
                  <RefreshCw size={14} />
                </Button>
              </Tooltip>
            </div>

            <div className={styles.table} role="table" aria-label="Tasks">
              <div className={`${styles.gridRow} ${styles.headRow}`} role="row">
                <span role="columnheader">ID</span>
                <span role="columnheader">Title / Context</span>
                <span role="columnheader">Assignees</span>
                <span role="columnheader">Status</span>
                <span role="columnheader">Updated</span>
                <span role="columnheader" aria-label="Actions" />
              </div>
              {loading && rows.length === 0 && !inProgress ? (
                <TasksSkeleton />
              ) : current.rows.length === 0 ? (
                <div className={styles.empty}>
                  {deferredSearch.trim()
                    ? "No tasks match your search."
                    : inProgress
                      ? "No tasks linked to a workspace."
                      : mode === "assigned"
                        ? "Nothing assigned to you."
                        : "No open tasks."}
                </div>
              ) : (
                current.rows.map((row) =>
                  "workspacePath" in row ? (
                    <TaskTableRow
                      key={row.key}
                      row={row}
                      now={now}
                      actionLabel="Open"
                      onAction={() => openLinked(row)}
                    />
                  ) : (
                    <TaskTableRow
                      key={row.key}
                      row={row}
                      now={now}
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

type TaskTableRowProps = {
  row: TaskRow | LinkedTask;
  now: number;
  /** "Start" for a tracker row, "Open" (go to its workspace) for a linked one. */
  actionLabel: string;
  onAction: () => void;
};

function TaskTableRow(props: TaskTableRowProps) {
  const { row, now, actionLabel, onAction } = props;

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

function TasksSkeleton() {
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
          <span className={`${styles.bone} ${styles.boneUpdated}`} />
          <span />
        </div>
      ))}
    </div>
  );
}

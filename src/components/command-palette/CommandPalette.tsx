import { useMemo, useCallback, useState, useRef, Fragment } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import { useAppStore, selectActiveWorkspaceKey } from "../../store/app-store";
import { workspaceKey } from "../../lib/workspace-key";
import { useRestoreFocus } from "../../hooks/useRestoreFocus";
import { useProjectStore } from "../../store/project-store";
import { addErrorToast } from "../../store/toast-store";
import { projectColorStyle } from "../../hooks/useProjectHeaderRow";
import type { LinkedTask, TaskRef, TaskRow } from "../../lib/tasks";
import {
  useCommandUsageStore,
  rankCommandIds,
} from "../../store/command-usage-store";
import { useWorkspaceCommands } from "./useWorkspaceCommands";
import { useCommands } from "./useCommands";
import { useAgentCommands } from "./useAgentCommands";
import { useCustomCommands } from "./useCustomCommands";
import { usePortsData } from "../ports/usePortsData";
import { ProcessesView, KillAllFooter } from "./ProcessesView";
import { StatsView } from "./StatsView";
import { wordPrefixFilter } from "./utils";
import {
  paletteScopeEntries,
  resolvePaletteScope,
  scopeEntryOf,
} from "./scope";
import { ScopeChip } from "./ScopeChip";
import {
  usePaletteTasks,
  paletteTaskRef,
  type PaletteTask,
} from "./usePaletteTasks";
import { useStartTask } from "../tasks/useStartTask";
import { openLinkedTask } from "../tasks/open-linked-task";
import { TrackerRowIcon } from "../tasks/tracker-icons";
import { TaskDetail } from "../tasks/TaskDetail/TaskDetail";
import type {
  CommandPaletteProps,
  PaletteView,
  CategoryConfig,
  CommandItem,
} from "./types";
import { Row } from "../ui/Layout/Layout";
import { Button } from "../ui/Button/Button";
import tasksStyles from "../tasks/TasksView.module.css";
import styles from "./CommandPalette.module.css";

const HIDDEN_STYLE = { display: "none" } as const;

/** How many frequently used commands to pin at the top of the root view. */
const FREQUENT_LIMIT = 5;

const FREQUENT_CATEGORY_ID = "frequent";

/** Heading of the Agents group; also what agent rows match against. */
const AGENTS_HEADING = "Agents";

const IS_MAC =
  typeof navigator !== "undefined" &&
  navigator.platform.toLowerCase().includes("mac");

/** The widen-to-global shortcut, as shown in hints. */
const WIDEN_HINT = IS_MAC ? "⌘↵" : "Ctrl+↵";
/** ⌘↵ on a task row starts it (opens a linked task's workspace). */
const START_HINT = WIDEN_HINT;

/** The Tasks group (ADR-208 §4): listed only while searching, never pinned as frequent. */
const TASKS_CATEGORY_ID = "tasks";

const TASKS_HEADING = "Tasks";

/** Prefix of a task row's command id; the rest is the row's key. */
const TASK_ITEM_PREFIX = "task:";

/** The "See all" row's cmdk value — force-mounted, so cmdk never scores it. */
const SEE_ALL_TASKS_VALUE = "\u0000see-all-tasks";

/** The task open in the `task-detail` view. */
type SelectedTask = { ref: TaskRef; row?: TaskRow; linked?: LinkedTask };

/** Keyword marking an item of the Frequently Used group for `paletteFilter`. */
const FREQUENT_KEYWORD = "\u0000frequent";

/** The string cmdk matches a root command against. */
function itemValue(heading: string, cmd: CommandItem): string {
  return `${heading} ${cmd.label} ${cmd.keywords?.join(" ") ?? ""}`;
}

/**
 * Separates an item's searchable text from its identity suffix. cmdk tracks
 * selection by value, so items with the same text (a local and a remote
 * `main` under one project group, or a Frequently Used item and its home
 * copy) would highlight together without a unique suffix.
 */
const VALUE_ID_SEPARATOR = "\u001f";

/** A cmdk value unique per rendered item; `paletteFilter` ignores the suffix. */
function uniqueItemValue(
  heading: string,
  cmd: CommandItem,
  categoryId: string,
): string {
  return `${itemValue(heading, cmd)}${VALUE_ID_SEPARATOR}${categoryId}:${cmd.id}`;
}

/**
 * `wordPrefixFilter`, plus a lift for Frequently Used items. cmdk orders
 * groups and items by score, so a matching frequent command outranks every
 * other match and its group stays on top while searching.
 */
function paletteFilter(
  value: string,
  search: string,
  keywords?: string[],
): number {
  const score = wordPrefixFilter(value.split(VALUE_ID_SEPARATOR)[0], search);
  return score > 0 && keywords?.includes(FREQUENT_KEYWORD) ? score + 1 : score;
}

export function CommandPalette(props: CommandPaletteProps) {
  const { open, onClose, onOpenSettings, onNewWorkspace, onResumeAgent, onViewAllAgents, onNewAgent, onRunCommand, initialView, origin = "shortcut" } = props;

  const { onCloseAutoFocus: restoreFocusOnClose } = useRestoreFocus(open);

  const addBrowserTab = useAppStore((s) => s.addBrowserTab);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const activeWorkspaceKey = useAppStore(selectActiveWorkspaceKey);
  const activeSurface = useAppStore((s) => s.activeSurface);
  const projects = useProjectStore((s) => s.projects);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);
  const commandUsage = useCommandUsageStore((s) => s.usage);
  const recordCommandUsage = useCommandUsageStore((s) => s.record);

  const { ports } = usePortsData();
  const activePorts = useMemo(
    () =>
      ports.filter(
        (p) =>
          !!p.workspacePath &&
          workspaceKey(p.hostId, p.workspacePath) === activeWorkspaceKey,
      ),
    [ports, activeWorkspaceKey],
  );

  const [view, setView] = useState<PaletteView>("root");
  const [search, setSearch] = useState("");
  const [selectedTask, setSelectedTask] = useState<SelectedTask | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Scope (ADR-200): the project the root view is narrowed to, or `null` for
  // all projects. `openedScopeProjectId` is what the palette opened with, so
  // Tab can toggle back to it after widening.
  const [scopeProjectId, setScopeProjectId] = useState<string | null>(null);
  const [openedScopeProjectId, setOpenedScopeProjectId] = useState<
    string | null
  >(null);
  const [scopeArmed, setScopeArmed] = useState(false);
  // Scoped to a sidebar entry: a project, or a group's linked checkouts.
  const scopeEntries = useMemo(() => paletteScopeEntries(projects), [projects]);
  const scope = useMemo(
    () => (scopeProjectId ? scopeEntryOf(scopeEntries, scopeProjectId) : null),
    [scopeEntries, scopeProjectId],
  );
  const scopeProjectIds = scope?.memberIds ?? null;

  // Check connection status when palette opens (render-time, ref-guarded)
  const prevOpenRef = useRef(false);
  if (open && !prevOpenRef.current) {
    const openedScope = resolvePaletteScope({
      origin,
      activeSurface,
      activeWorkspaceKey,
      projects,
    });
    setScopeProjectId(openedScope);
    setOpenedScopeProjectId(openedScope);
    setScopeArmed(false);

    // Apply initial view state if provided
    if (initialView) {
      setView(initialView);
    }
  }
  prevOpenRef.current = open;

  const handleClose = useCallback(() => {
    setView("root");
    setSearch("");
    setSelectedTask(null);
    setScopeProjectId(null);
    setOpenedScopeProjectId(null);
    setScopeArmed(false);
    onClose();
  }, [onClose]);

  /** Drops the project scope; the query stays. */
  const widenScope = useCallback(() => {
    setScopeProjectId(null);
    setScopeArmed(false);
    listRef.current?.scrollTo(0, 0);
    inputRef.current?.focus();
  }, []);

  const navigateToProcesses = useCallback(() => {
    setSearch("");
    setView("processes");
  }, []);

  const navigateToStats = useCallback(() => {
    setSearch("");
    setView("stats");
  }, []);

  const navigateToRoot = useCallback(() => {
    setSearch("");
    setView("root");
  }, []);

  // Esc from a task's detail: back to the search it was opened from.
  const navigateBackToSearch = useCallback(() => {
    setSelectedTask(null);
    setView("root");
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }, []);

  const { workspaceGroups } = useWorkspaceCommands({
    projects,
    activeWorkspacePath,
    selectWorkspace,
    onClose: handleClose,
    onNewWorkspace,
    enabled: open,
  });

  const commandCategories = useCommands({
    addBrowserTab,
    onClose: handleClose,
    onOpenSettings,
    onRunCommand,
    activePorts,
    navigateToProcesses,
    navigateToStats,
  });

  const agentCommands = useAgentCommands({
    onResumeAgent,
    onViewAllAgents,
    onClose: handleClose,
    onNewAgent,
    scopeProjectIds,
    enabled: open,
  });

  const scopedWorkspaceGroups = useMemo(
    () =>
      scopeProjectIds
        ? workspaceGroups.filter((g) => scopeProjectIds.has(g.projectId))
        : workspaceGroups,
    [workspaceGroups, scopeProjectIds],
  );

  const paletteTasks = usePaletteTasks({
    search,
    scopeProjectId,
    enabled: open && view === "root",
  });

  const startTask = useStartTask(onNewWorkspace);

  // ↵ on a task row: start a tracker task, or go to a linked task's workspace.
  const selectTask = useCallback(
    async (task: PaletteTask) => {
      if ("workspacePath" in task) {
        openLinkedTask(task);
      } else {
        try {
          await startTask(task);
        } catch (err) {
          addErrorToast(
            `start-task-error-${task.key}`,
            "Failed to start task",
            err,
          );
          return;
        }
      }
      handleClose();
    },
    [startTask, handleClose],
  );

  // ↵ or → on a task row: its detail.
  const openTaskDetail = useCallback(
    (task: PaletteTask) => {
      const ref = paletteTaskRef(task, projects);
      if (!ref) return;
      setSelectedTask(
        "workspacePath" in task ? { ref, linked: task } : { ref, row: task },
      );
      setView("task-detail");
    },
    [projects],
  );

  const seeAllTasks = useCallback(() => {
    const { projectKey, seeAllProvider } = paletteTasks;
    useAppStore.getState().showTasksView({
      search: search.trim(),
      project: projectKey,
      ...(seeAllProvider && { provider: seeAllProvider, clearFilters: true }),
    });
    handleClose();
  }, [search, paletteTasks, handleClose]);

  const customCommands = useCustomCommands({
    onClose: handleClose,
    activeWorkspaceKey,
    enabled: open,
  });

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) handleClose();
    },
    [handleClose],
  );

  const handleOpenAutoFocus = useCallback((e: Event) => {
    e.preventDefault();
  }, []);

  const handleCloseAutoFocus = restoreFocusOnClose;

  const handleEscapeKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (view === "task-detail") {
        e.preventDefault();
        navigateBackToSearch();
        return;
      }
      if (view !== "root") {
        e.preventDefault();
        navigateToRoot();
        return;
      }
      // An armed scope chip (Backspace on an empty query) clears on Escape
      // instead of closing the palette.
      if (scopeArmed) {
        e.preventDefault();
        widenScope();
      }
    },
    [
      view,
      navigateToRoot,
      navigateBackToSearch,
      scopeArmed,
      widenScope,
    ],
  );

  const isSubView = view === "processes" || view === "stats";
  const isDetailView = view === "task-detail";

  const categories = useMemo<CategoryConfig[]>(() => {
    const workspaceCategories: CategoryConfig[] = scopedWorkspaceGroups.map(
      (group) => ({
        id: `workspace-${group.projectId}`,
        heading: group.heading,
        visible: true,
        items: group.items,
      }),
    );

    // "Go to" (Dashboard, Tasks, Projects) leads the list, ahead of the
    // per-project workspace groups that can run long.
    const goTo = commandCategories.filter((c) => c.id === "go-to");
    const otherCommands = commandCategories.filter((c) => c.id !== "go-to");

    return [
      ...goTo,
      {
        id: "agents",
        heading: AGENTS_HEADING,
        visible: true,
        items: agentCommands.items,
      },
      ...workspaceCategories,
      {
        id: "run",
        heading: "Run",
        visible: customCommands.length > 0,
        items: customCommands,
      },
      ...otherCommands,
    ];
  }, [
    agentCommands,
    customCommands,
    scopedWorkspaceGroups,
    commandCategories,
  ]);

  // Pin the most-used commands above everything else. With an empty search box
  // these are the top few overall; while searching, the top few that match,
  // lifted out of their home groups so no command is listed twice. Each keeps
  // its home group's heading for matching, so searching a project name still
  // finds that project's frequent workspaces.
  const frequent = useMemo(() => {
    const byId = new Map<string, { item: CommandItem; heading: string }>();
    for (const cat of categories) {
      if (!cat.visible) continue;
      for (const item of cat.items) {
        byId.set(item.id, { item, heading: cat.heading });
      }
    }
    const items: CommandItem[] = [];
    const homeHeadings = new Map<string, string>();
    for (const id of rankCommandIds(commandUsage)) {
      const entry = byId.get(id);
      // Skip commands that no longer exist (closed workspace, finished task)
      // and no-ops like switching to the already-active workspace.
      if (!entry || entry.item.isActive) continue;
      if (
        search &&
        wordPrefixFilter(itemValue(entry.heading, entry.item), search) === 0
      ) {
        continue;
      }
      items.push(entry.item);
      homeHeadings.set(id, entry.heading);
      if (items.length >= FREQUENT_LIMIT) break;
    }
    return { items, homeHeadings };
  }, [search, categories, commandUsage]);

  // ADR-208 §4: the top task matches, as a group after agents and
  // workspaces. Kept out of `categories`, so tasks are never ranked or
  // recorded as frequent commands.
  const tasksByItemId = useMemo(
    () =>
      new Map(
        paletteTasks.rows.map((task) => [`${TASK_ITEM_PREFIX}${task.key}`, task]),
      ),
    [paletteTasks.rows],
  );

  const tasksCategory = useMemo<CategoryConfig | null>(() => {
    if (!search.trim() || paletteTasks.rows.length === 0) return null;
    return {
      id: TASKS_CATEGORY_ID,
      heading: TASKS_HEADING,
      visible: true,
      items: paletteTasks.rows.map((task) => ({
        id: `${TASK_ITEM_PREFIX}${task.key}`,
        label: task.title,
        keywords: [task.displayId, ...task.labels.map((l) => l.name)],
        action: () => openTaskDetail(task),
      })),
    };
  }, [search, paletteTasks.rows, openTaskDetail]);

  const rootCategories = useMemo<CategoryConfig[]>(() => {
    const rest =
      search && frequent.items.length > 0
        ? categories.map((cat) => ({
            ...cat,
            items: cat.items.filter(
              (item) => !frequent.homeHeadings.has(item.id),
            ),
          }))
        : categories;
    let listed = rest;
    if (tasksCategory) {
      const after = rest.reduce(
        (last, c, i) =>
          c.id === "agents" || c.id.startsWith("workspace-") ? i : last,
        -1,
      );
      listed = [
        ...rest.slice(0, after + 1),
        tasksCategory,
        ...rest.slice(after + 1),
      ];
    }
    if (frequent.items.length === 0) return listed;
    const pinned: CategoryConfig = {
      id: FREQUENT_CATEGORY_ID,
      heading: "Frequently Used",
      visible: true,
      items: frequent.items,
    };
    return [pinned, ...listed];
  }, [frequent, categories, search, tasksCategory]);

  // Project-owned rows outside the scope that match the query: the other
  // projects' workspace groups and agents. Drives the widening hints.
  const outOfScopeMatchCount = useMemo(() => {
    if (!scopeProjectIds || !search) return 0;
    const matches = (heading: string, cmd: CommandItem) =>
      wordPrefixFilter(itemValue(heading, cmd), search) > 0;
    let count = 0;
    for (const group of workspaceGroups) {
      if (scopeProjectIds.has(group.projectId)) continue;
      for (const cmd of group.items) if (matches(group.heading, cmd)) count++;
    }
    for (const cmd of agentCommands.outOfScope) {
      if (matches(AGENTS_HEADING, cmd)) count++;
    }
    return count;
  }, [scopeProjectIds, search, workspaceGroups, agentCommands.outOfScope]);

  // Whether the root view shows any row for the query (what cmdk's Empty
  // mirrors), for the footer's "+N in other projects" hint.
  const hasRootMatches = useMemo(
    () =>
      !search ||
      tasksCategory !== null ||
      categories.some(
        (cat) =>
          cat.visible &&
          cat.items.some(
            (cmd) => wordPrefixFilter(itemValue(cat.heading, cmd), search) > 0,
          ),
      ),
    [categories, search, tasksCategory],
  );

  /** The task row cmdk has highlighted, if any. */
  const selectedTaskRow = useCallback((): PaletteTask | undefined => {
    const selected = listRef.current?.querySelector<HTMLElement>(
      '[cmdk-item][data-selected="true"]',
    );
    return tasksByItemId.get(selected?.dataset.taskItem ?? "");
  }, [tasksByItemId]);

  const handleRootInputKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (view !== "root") return;
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Backspace" && search === "" && scopeProjectId) {
        e.preventDefault();
        if (scopeArmed) widenScope();
        else setScopeArmed(true);
        return;
      }
      if (e.key === "Tab" && (scopeProjectId || openedScopeProjectId)) {
        e.preventDefault();
        setScopeProjectId((cur) => (cur ? null : openedScopeProjectId));
        setScopeArmed(false);
        listRef.current?.scrollTo(0, 0);
        return;
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        // ⌘↵ on a task row starts it (or opens its workspace); elsewhere it
        // widens the scope. Either way, stop cmdk from running the row.
        const task = selectedTaskRow();
        if (task) {
          e.preventDefault();
          void selectTask(task);
          return;
        }
        if (scopeProjectId) {
          e.preventDefault();
          widenScope();
          return;
        }
      }
      if (
        e.key === "ArrowRight" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        caretAtEnd(e.currentTarget)
      ) {
        // Only at the end of the query, so → still moves the caret.
        const task = selectedTaskRow();
        if (task) {
          e.preventDefault();
          openTaskDetail(task);
          return;
        }
      }
      if (scopeArmed) setScopeArmed(false);
    },
    [
      view,
      search,
      scopeProjectId,
      scopeArmed,
      openedScopeProjectId,
      widenScope,
      selectedTaskRow,
      selectTask,
      openTaskDetail,
    ],
  );

  /** The chip's picker: scope to another project (or all), back in the query. */
  const changeScope = useCallback((projectId: string | null) => {
    setScopeProjectId(projectId);
    setScopeArmed(false);
    listRef.current?.scrollTo(0, 0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // ⌘↵ starts a highlighted task, so the widen hint falls back to Tab there.
  const [highlighted, setHighlighted] = useState("");
  const taskHighlighted =
    tasksCategory !== null &&
    highlighted.includes(`${VALUE_ID_SEPARATOR}${TASKS_CATEGORY_ID}:`);

  const scopeName = scope?.name ?? null;
  const rootPlaceholder = scopeName
    ? `Search ${scopeName}…`
    : "Search all projects…";

  return (
    <>
      <Dialog.Root open={open} onOpenChange={handleOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content
            data-testid="command-palette"
            aria-describedby={undefined}
            className={`${styles.palette} ${isDetailView ? styles.paletteWide : ""} ${view === "task-detail" ? styles.paletteTask : ""} ${view === "stats" ? styles.paletteStats : ""}`}
            onOpenAutoFocus={handleOpenAutoFocus}
            onCloseAutoFocus={handleCloseAutoFocus}
            onEscapeKeyDown={handleEscapeKeyDown}
          >
            <Dialog.Title className="sr-only">Command Palette</Dialog.Title>
            <Command
              className={styles.command}
              loop
              filter={paletteFilter}
              onValueChange={setHighlighted}
            >
              {isSubView && (
                <Row align="center" gap="xxs" className={styles.breadcrumb}>
                  <button
                    className={styles.breadcrumbBack}
                    onClick={navigateToRoot}
                  >
                    <ArrowLeft size={14} />
                  </button>
                  <span className={styles.breadcrumbLabel}>
                    {view === "processes" && "Processes"}
                    {view === "stats" && "Stats"}
                  </span>
                </Row>
              )}
              {view === "root" ? (
                <div className={styles.inputRow}>
                  <ScopeChip
                    entries={scopeEntries}
                    scope={scope}
                    armed={scopeArmed}
                    onChange={changeScope}
                    onClear={widenScope}
                  />
                  <Command.Input
                    ref={inputRef}
                    className={`${styles.input} ${styles.inputInRow}`}
                    placeholder={rootPlaceholder}
                    autoFocus
                    value={search}
                    onValueChange={(v) => {
                      setSearch(v);
                      setScopeArmed(false);
                      listRef.current?.scrollTo(0, 0);
                    }}
                    onKeyDown={handleRootInputKeyDown}
                  />
                  {/* Full screen on a phone, with no overlay to tap and no
                      Escape key: this is its way out. CSS shows it there only. */}
                  <Dialog.Close asChild>
                    <Button
                      variant="ghost"
                      className={styles.phoneClose}
                      data-testid="command-palette-close"
                    >
                      Cancel
                    </Button>
                  </Dialog.Close>
                </div>
              ) : (
                <Command.Input
                  className={styles.input}
                  placeholder="Type a command..."
                  autoFocus
                  value={search}
                  onValueChange={(v) => {
                    setSearch(v);
                    listRef.current?.scrollTo(0, 0);
                  }}
                  style={
                    isDetailView ||
                    view === "processes" ||
                    view === "stats"
                      ? { position: "absolute", opacity: 0, pointerEvents: "none", height: 0, padding: 0, border: "none" }
                      : undefined
                  }
                />
              )}
              <Command.List
                ref={listRef}
                className={styles.list}
                style={isDetailView ? HIDDEN_STYLE : undefined}
              >
                {view === "root" && (
                  <>
                    {rootCategories
                      .filter((c) => c.visible)
                      .sort((a, b) => {
                        if (!search) return 0;
                        // Frequently Used stays on top while searching.
                        if (a.id === FREQUENT_CATEGORY_ID) return -1;
                        if (b.id === FREQUENT_CATEGORY_ID) return 1;
                        
                        const bestScore = (cat: CategoryConfig) =>
                          Math.max(
                            0,
                            ...cat.items.map((cmd) => {
                              
                              return wordPrefixFilter(
                                itemValue(cat.heading, cmd),
                                search,
                              )
                            }),
                          );
                        return bestScore(b) - bestScore(a);
                      })
                      .map((cat, i) => (
                        <Fragment key={cat.id}>
                          {i > 0 && (
                            <Command.Separator className={styles.separator} />
                          )}
                          <Command.Group
                            heading={cat.heading}
                            className={styles.group}
                          >
                            {cat.id === TASKS_CATEGORY_ID &&
                              cat.items.map((cmd) => {
                                const task = tasksByItemId.get(cmd.id);
                                return (
                                  task && (
                                    <TaskItem
                                      key={cmd.id}
                                      itemId={cmd.id}
                                      value={uniqueItemValue(
                                        cat.heading,
                                        cmd,
                                        cat.id,
                                      )}
                                      keywords={cmd.keywords}
                                      task={task}
                                      query={search}
                                      onSelect={cmd.action}
                                    />
                                  )
                                );
                              })}
                            {cat.id === TASKS_CATEGORY_ID && (
                              // Force-mounted and unscored: cmdk sorts it
                              // after every task.
                              <Command.Item
                                value={SEE_ALL_TASKS_VALUE}
                                forceMount
                                onSelect={seeAllTasks}
                                className={`${styles.item} ${styles.seeAllTasks}`}
                              >
                                <span className={styles.label}>
                                  See all {paletteTasks.total} matching{" "}
                                  {paletteTasks.total === 1 ? "task" : "tasks"}{" "}
                                  in Tasks view
                                </span>
                                <ArrowRight size={13} aria-hidden />
                              </Command.Item>
                            )}
                            {cat.id !== TASKS_CATEGORY_ID &&
                              cat.items.map((cmd) => (
                              <Command.Item
                                key={cmd.id}
                                value={uniqueItemValue(
                                  cat.id === FREQUENT_CATEGORY_ID
                                    ? (frequent.homeHeadings.get(cmd.id) ??
                                        cat.heading)
                                    : cat.heading,
                                  cmd,
                                  cat.id,
                                )}
                                onSelect={() => {
                                  recordCommandUsage(cmd.id);
                                  cmd.action();
                                }}
                                className={`${styles.item} ${cmd.isActive ? styles.itemActive : ""}`}
                                keywords={
                                  cat.id === FREQUENT_CATEGORY_ID
                                    ? [...(cmd.keywords ?? []), FREQUENT_KEYWORD]
                                    : cmd.keywords
                                }
                              >
                                {cmd.icon && (
                                  <span className={styles.icon}>
                                    {cmd.icon}
                                  </span>
                                )}
                                <span className={styles.label}>
                                  {cmd.label}
                                </span>
                                {cmd.shortcut && (
                                  <span className={styles.shortcut}>
                                    {cmd.shortcut}
                                  </span>
                                )}
                                {cmd.isActive && (
                                  <span className={styles.activeBadge}>
                                    current
                                  </span>
                                )}
                                {cmd.suffix && (
                                  <span className={styles.chevron}>
                                    {cmd.suffix}
                                  </span>
                                )}
                              </Command.Item>
                              ))}
                          </Command.Group>
                        </Fragment>
                      ))}
                    {scopeName && outOfScopeMatchCount > 0 ? (
                      <Command.Empty
                        className={`${styles.emptyState} ${styles.scopedEmpty}`}
                        data-testid="palette-scope-empty"
                      >
                        <span className={styles.scopedEmptyTitle}>
                          No matches in <strong>{scopeName}</strong>.
                        </span>
                        <span className={styles.scopedEmptyHint}>
                          {outOfScopeMatchCount}{" "}
                          {outOfScopeMatchCount === 1 ? "match" : "matches"} in
                          other projects · <kbd className={styles.kbd}>⌫</kbd>{" "}
                          or <kbd className={styles.kbd}>{WIDEN_HINT}</kbd> to
                          search everywhere
                        </span>
                      </Command.Empty>
                    ) : (
                      <Command.Empty className={styles.emptyState}>
                        <span className={styles.emptyGhost} aria-hidden>
                          👻
                        </span>
                        <span className={styles.emptyTitle}>Boo!</span>
                        <span className={styles.emptyHint}>
                          No commands haunt this search.
                        </span>
                      </Command.Empty>
                    )}
                  </>
                )}

                {view === "processes" && <ProcessesView />}

                {view === "stats" && <StatsView />}
              </Command.List>
              {view === "root" && (scopeName || tasksCategory) && (
                <div
                  className={styles.footer}
                  data-testid={scopeName ? "palette-scope-footer" : "palette-footer"}
                >
                  {tasksCategory && (
                    <>
                      <span className={styles.footerItem}>
                        <kbd className={styles.kbd}>↵</kbd> Details
                      </span>
                      <span className={styles.footerItem}>
                        <kbd className={styles.kbd}>{START_HINT}</kbd> Start
                      </span>
                    </>
                  )}
                  {scopeName && (
                    <span className={styles.footerItem}>
                      <kbd className={styles.kbd}>⌫</kbd> clear scope
                    </span>
                  )}
                  <span className={styles.footerRight}>
                    {search && hasRootMatches && outOfScopeMatchCount > 0 && (
                      <span className={styles.footerItem}>
                        +{outOfScopeMatchCount} in other projects{" "}
                        <kbd className={styles.kbd}>
                          {taskHighlighted ? "Tab" : WIDEN_HINT}
                        </kbd>
                      </span>
                    )}
                    {tasksCategory && (
                      <span className={styles.footerItem}>
                        <kbd className={styles.kbd}>esc</kbd> Close
                      </span>
                    )}
                  </span>
                </div>
              )}
              {view === "processes" && (
                <KillAllFooter
                  onKillAll={async () => {
                    await window.electronAPI.processes.killAll();
                  }}
                />
              )}
              {view === "task-detail" && selectedTask && (
                <TaskDetail
                  key={selectedTask.ref.id}
                  taskRef={selectedTask.ref}
                  row={selectedTask.row}
                  mode={selectedTask.linked ? "linked" : "default"}
                  layout="card"
                  linkedTo={selectedTask.linked?.workspaceName}
                  projectId={selectedTask.linked?.projectId}
                  workspacePath={selectedTask.linked?.workspacePath}
                  onNewWorkspace={onNewWorkspace}
                  onDone={handleClose}
                />
              )}
            </Command>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

/** Is the input's caret collapsed at the end of its value. */
function caretAtEnd(input: HTMLInputElement): boolean {
  const end = input.value.length;
  return input.selectionStart === end && input.selectionEnd === end;
}

type HighlightProps = {
  text: string;
  query: string;
};

/** `text` with its first case-insensitive match of `query` marked. */
function Highlight(props: HighlightProps) {
  const { text, query } = props;

  const q = query.trim().toLowerCase();
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className={styles.taskMatch}>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

type TaskItemProps = {
  /** The row's command id, read back by → to find the task. */
  itemId: string;
  value: string;
  keywords?: string[];
  task: PaletteTask;
  query: string;
  onSelect: () => void;
};

/**
 * ADR-208 §4: a task in the palette's search — tracker glyph and ID, title,
 * its linked workspace (or project), and status. ↵ starts or opens it.
 */
function TaskItem(props: TaskItemProps) {
  const { itemId, value, keywords, task, query, onSelect } = props;

  const linked = "workspacePath" in task ? task : null;

  return (
    <Command.Item
      value={value}
      keywords={keywords}
      onSelect={onSelect}
      className={`${styles.item} ${styles.taskItem}`}
      data-task-item={itemId}
    >
      <span className={styles.taskId}>
        <TrackerRowIcon provider={task.provider} />
        {task.displayId}
      </span>
      <span className={styles.taskTitle}>
        <Highlight text={task.title} query={query} />
      </span>
      {linked ? (
        <span className={styles.taskContext}>
          <GitBranch size={11} aria-hidden />
          {linked.workspaceName}
        </span>
      ) : (
        <span
          className={`${styles.taskContext} ${tasksStyles.projectName}`}
          style={projectColorStyle(task.color)}
        >
          {task.projectName}
        </span>
      )}
      <span
        className={`${tasksStyles.status} ${tasksStyles[`tone-${task.status.tone}`]} ${styles.taskStatus}`}
      >
        {task.status.label}
      </span>
      <span className={styles.taskAction}>
        {linked ? "Open" : "Start"} <kbd className={styles.kbd}>{START_HINT}</kbd>
      </span>
    </Command.Item>
  );
}

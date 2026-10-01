import { create } from "zustand";
import { selectActiveWorkspaceKey, useAppStore } from "./app-store";
import { workspaceKey, type WorkspaceKey } from "../lib/workspace-key";
import { useToastStore } from "./toast-store";
import {
  clearLinkSuggestionsFor,
  offerLinkSuggestions,
  startLinkSuggestions,
} from "./link-suggestions";
import { branchesEqual } from "../utils/branch-name";
import { ipcErrorMessage } from "../lib/ipc-error";
import { splitShared } from "../lib/project-groups";
import { isRemoteHost, type HostId } from "../lib/hosts";
import { hostForPath, patch, reconcile } from "../lib/workspace-directory";
import { sharedRefresh } from "../lib/shared-refresh";
import {
  buildSidebarItems,
  folderParentsOf,
  insertFolderBefore,
  membershipOf,
  placeManyInFolder,
  serializeOrder,
  type SidebarItem,
} from "../utils/sidebar-items";
import type {
  ChecksSummary,
  PrCheckRun,
  PrComment,
  PrInfo,
} from "../lib/pr-info";

export type {
  ChecksSummary,
  PrCheckRun,
  PrComment,
  PrInfo,
} from "../lib/pr-info";

const COLLAPSED_KEY = "manor:collapsedProjectIds";
const COLLAPSED_FOLDER_KEYS_KEY = "manor:collapsedWorkspaceFolderKeys";
const SIDEBAR_WIDTH_KEY = "manor:sidebarWidth";
const SIDEBAR_MODE_KEY = "manor:sidebarMode";

export type SidebarMode = "full" | "rail" | "hidden";
const PORTS_HEIGHT_KEY = "manor:portsHeight";
const AGENTS_HEIGHT_KEY = "manor:agentsHeight";
const PORTS_COLLAPSED_KEY = "manor:portsCollapsed";
const AGENTS_COLLAPSED_KEY = "manor:agentsCollapsed";
const DEFAULT_SIDEBAR_WIDTH = 220;
const DEFAULT_PORTS_HEIGHT = 200;
export const MIN_PORTS_HEIGHT = 60;
export const MAX_PORTS_HEIGHT = 500;
const DEFAULT_AGENTS_HEIGHT = 200;
export const MIN_AGENTS_HEIGHT = 60;
export const MAX_AGENTS_HEIGHT = 500;

function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw) {
      const width = Number(raw);
      if (Number.isFinite(width) && width >= 160 && width <= 400) return width;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

function loadSidebarMode(): SidebarMode {
  try {
    const raw = localStorage.getItem(SIDEBAR_MODE_KEY);
    if (raw === "full" || raw === "rail" || raw === "hidden") return raw;
  } catch {
    /* ignore */
  }
  return "full";
}

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function saveFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}

function loadPortsHeight(): number {
  try {
    const raw = localStorage.getItem(PORTS_HEIGHT_KEY);
    if (raw) {
      const height = Number(raw);
      if (
        Number.isFinite(height) &&
        height >= MIN_PORTS_HEIGHT &&
        height <= MAX_PORTS_HEIGHT
      )
        return height;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_PORTS_HEIGHT;
}

function loadAgentsHeight(): number {
  try {
    const raw = localStorage.getItem(AGENTS_HEIGHT_KEY);
    if (raw) {
      const height = Number(raw);
      if (
        Number.isFinite(height) &&
        height >= MIN_AGENTS_HEIGHT &&
        height <= MAX_AGENTS_HEIGHT
      )
        return height;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_AGENTS_HEIGHT;
}

function loadCollapsedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return new Set();
}

function saveCollapsedIds(ids: Set<string>): void {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
}

/** Key used in `collapsedFolderKeys` for a given project/folder pair. */
export function folderCollapseKey(projectId: string, folderId: string): string {
  return `${projectId}/${folderId}`;
}

/** The ids of `project`'s folders that `collapsedFolderKeys` holds collapsed. */
export function collapsedFolderIdsOf(
  project: Pick<ProjectInfo, "id" | "folders">,
  collapsedFolderKeys: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const folder of project.folders) {
    if (collapsedFolderKeys.has(folderCollapseKey(project.id, folder.id))) {
      ids.add(folder.id);
    }
  }
  return ids;
}

/**
 * Re-sorts workspaces to match a sidebar order. Entries in `order` that aren't
 * paths (folder ids) are ignored; paths absent from `order` keep their
 * relative order at the end.
 */
function sortWorkspacesByOrder(
  workspaces: WorkspaceInfo[],
  order: string[],
): WorkspaceInfo[] {
  const index = new Map<string, number>();
  order.forEach((entry, i) => {
    if (!index.has(entry)) index.set(entry, i);
  });
  return [...workspaces].sort(
    (a, b) => (index.get(a.path) ?? Infinity) - (index.get(b.path) ?? Infinity),
  );
}

/**
 * Mirrors main's `spliceFolderOut`: drops the folder id from the sidebar order
 * and puts the keys it held in that slot — member paths and child folder ids
 * alike — so ungrouping leaves them where the folder was. Re-implemented here
 * rather than imported — the renderer never reaches into `electron/`.
 */
function spliceFolderOutOfOrder(
  order: string[],
  folderId: string,
  memberKeys: string[],
): string[] {
  const memberSet = new Set(memberKeys);
  const rest = order.filter(
    (entry) => entry !== folderId && !memberSet.has(entry),
  );
  const folderIndex = order.indexOf(folderId);
  if (folderIndex === -1) return [...rest, ...memberKeys];

  let insertAt = 0;
  for (let i = 0; i < folderIndex; i++) {
    const entry = order[i];
    if (entry !== folderId && !memberSet.has(entry)) insertAt++;
  }
  return [...rest.slice(0, insertAt), ...memberKeys, ...rest.slice(insertAt)];
}

function loadCollapsedFolderKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_FOLDER_KEYS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return new Set();
}

function saveCollapsedFolderKeys(keys: Set<string>): void {
  localStorage.setItem(COLLAPSED_FOLDER_KEYS_KEY, JSON.stringify([...keys]));
}

/**
 * Store-level orchestrator for the workspace setup-script PTY.
 *
 * Owns creation, command submission, and exit handling for the setup script
 * at store scope so its lifetime is decoupled from any view. The MiniTerminal
 * rendered by WorkspaceSetupView attaches (via `attach` prop) to the same
 * session for live display but never creates or closes the PTY.
 */
function startSetupScript(
  wsPath: string,
  script: string,
  hostId?: HostId,
): void {
  const sessionId = `setup-${wsPath.replace(/\//g, "-")}`;
  // Reasonable defaults; the view re-fits xterm when/if it mounts.
  const DEFAULT_COLS = 80;
  const DEFAULT_ROWS = 24;

  let commandSent = false;
  let unsubCwd: (() => void) | null = null;
  let unsubExit: (() => void) | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const disposeCommandWaiters = () => {
    if (unsubCwd) {
      unsubCwd();
      unsubCwd = null;
    }
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  };

  const sendCommand = () => {
    if (commandSent) return;
    commandSent = true;
    disposeCommandWaiters();
    window.electronAPI.pty.write(sessionId, `${script}; exit\r`);
  };

  const handleExit = () => {
    disposeCommandWaiters();
    useAppStore
      .getState()
      .updateWorktreeSetupStep(wsPath, "setup-script", "done");
    useAppStore.getState().completeWorktreeSetup(wsPath);
    // Remove the background persistent toast (ticket 2 creates it; unconditional
    // remove is a no-op if absent).
    useToastStore.getState().removeToast(`worktree-setup-${wsPath}`);
    // Success toast — fires regardless of whether the setup view is mounted.
    useToastStore.getState().addToast({
      id: `workspace-setup-${Date.now()}`,
      message: "Workspace setup complete",
      status: "success",
    });
    if (unsubExit) {
      unsubExit();
      unsubExit = null;
    }
  };

  // Subscribe to exit BEFORE pty.create so no events are missed.
  unsubExit = window.electronAPI.pty.onExit(sessionId, handleExit);

  // Wait for the shell-ready signal (first CWD event from the zsh precmd hook)
  // before writing the command. Fallback send after 3s for non-zsh shells.
  unsubCwd = window.electronAPI.pty.onCwd(sessionId, () => {
    sendCommand();
  });
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null;
    sendCommand();
  }, 3000);

  // Kick off the PTY. The promise resolves after main process spawns it.
  // Errors here are rare and we let the view's own exit observation (or the
  // lack of onExit) surface them; keeping this simple.
  void window.electronAPI.pty.create(
    sessionId,
    wsPath,
    DEFAULT_COLS,
    DEFAULT_ROWS,
    { hostId: hostId ?? hostForPath(useProjectStore.getState(), wsPath) },
  );
}

/**
 * Run a project's setup script in a workspace created outside `createWorktree`
 * — i.e. by the main process on behalf of MCP. The git steps already succeeded
 * by the time main hands off, so seed them as done and show only the script.
 */
export function runWorkspaceSetupScript(
  wsPath: string,
  script: string,
  hostId?: HostId,
): void {
  const app = useAppStore.getState();
  app.initWorktreeSetup(wsPath, true, script);
  const doneSteps: SetupStep[] = [
    "prune",
    "fetch",
    "create-worktree",
    "persist",
    "switch",
  ];
  for (const step of doneSteps) {
    app.updateWorktreeSetupStep(wsPath, step, "done");
  }
  startSetupScript(wsPath, script, hostId);
}

export interface CustomCommand {
  id: string;
  name: string;
  command: string;
}

export interface DiffStats {
  added: number;
  removed: number;
}

function checksEqual(
  a?: ChecksSummary | null,
  b?: ChecksSummary | null,
): boolean {
  if (a == null || b == null) return a == b;
  return (
    a.total === b.total &&
    a.passing === b.passing &&
    a.failing === b.failing &&
    a.pending === b.pending &&
    (a.skipped ?? 0) === (b.skipped ?? 0)
  );
}

/**
 * Structural equality for PR info. Used by `updateWorkspacePr` to skip no-op
 * updates. Must compare EVERY rendered field — comparing only number/state
 * froze review/checks/comment updates while a PR stayed "open" (the badge never
 * reflected approvals or CI results).
 */
export function prEqual(a?: PrInfo | null, b?: PrInfo | null): boolean {
  if (a === b) return true;
  // "No PR yet" (undefined) and "no PR" (null) render the same.
  if (!a || !b) return !a && !b;
  return (
    a.number === b.number &&
    a.state === b.state &&
    a.title === b.title &&
    a.url === b.url &&
    a.isDraft === b.isDraft &&
    a.additions === b.additions &&
    a.deletions === b.deletions &&
    a.reviewDecision === b.reviewDecision &&
    a.queuedToMerge === b.queuedToMerge &&
    a.hasConflicts === b.hasConflicts &&
    a.unresolvedThreads === b.unresolvedThreads &&
    a.commentCount === b.commentCount &&
    a.latestComment?.url === b.latestComment?.url &&
    a.latestComment?.body === b.latestComment?.body &&
    commentsEqual(a.recentComments, b.recentComments) &&
    checkRunsEqual(a.checkRuns, b.checkRuns) &&
    checksEqual(a.checks, b.checks)
  );
}

function commentsEqual(a?: PrComment[], b?: PrComment[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((c, i) => c.url === b[i].url && c.body === b[i].body);
}

function checkRunsEqual(a?: PrCheckRun[], b?: PrCheckRun[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((c, i) => c.name === b[i].name && c.status === b[i].status);
}

export interface WorkspaceFolder {
  id: string;
  name: string;
  /** Enclosing folder, or null at the top level (ADR-172). */
  parentId: string | null;
}

export interface WorkspaceInfo {
  path: string;
  branch: string;
  isMain: boolean;
  name: string | null;
  hidden?: boolean;
  diffStats?: DiffStats | null;
  pr?: PrInfo | null;
  linkedIssues?: LinkedIssue[];
  folderId?: string | null;
}

export interface LinkedIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export interface LinearAssociation {
  teamId: string;
  teamName: string;
  teamKey: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  workspaces: WorkspaceInfo[];
  selectedWorkspaceIndex: number;
  defaultRunCommand: string | null;
  worktreePath: string | null;
  worktreeStartScript: string | null;
  worktreeTeardownScript: string | null;
  linearAssociations: LinearAssociation[];
  color: string | null;
  agentCommand: string | null;
  commands: CustomCommand[];
  themeName: string | null;
  setupComplete: boolean;
  /** Whether dev-server ports get `.localhost` preview hostnames. Defaults to true. */
  portlessEnabled: boolean;
  /** The host this project's paths, git and terminals live on (ADR-160); `"local"` for this machine. */
  hostId: string;
  folders: WorkspaceFolder[];
  /**
   * Normalized, depth-first order of workspace paths and folder ids — the
   * canonical shape of what the sidebar renders.
   */
  sidebarOrder: string[];
  /**
   * The linked-project group this project is in (ADR-192). Absent or null
   * when it isn't linked; every member carries the same summary.
   */
  group?: ProjectGroupInfo | null;
}

/** Mirrors `ProjectGroupInfo` in `electron/projects/types.ts` (ADR-192). */
export interface ProjectGroupInfo {
  id: string;
  name: string;
  /** Member project ids, in the order their host sections render. */
  memberIds: string[];
  lastUsedHostId: string | null;
}

/** The optional parts of `createWorktree`, named so callers skip what they don't use. */
export interface CreateWorktreeOptions {
  /** Run in the new workspace once it (and any setup script) is ready. */
  agentCommand?: string;
  linkedIssue?: LinkedIssue;
  /** What a new branch starts from; the default branch when omitted. */
  baseBranch?: string;
  /** Check out `branch` as it is instead of creating it. */
  useExistingBranch?: boolean;
}

export type SetupStep =
  | "prune"
  | "fetch"
  | "create-worktree"
  | "persist"
  | "switch"
  | "setup-script";
export type StepStatus = "pending" | "in-progress" | "done" | "error";
export type SetupProgressEvent = {
  step: SetupStep;
  status: StepStatus;
  message?: string;
};

export type ProjectUpdatableFields = Partial<
  Pick<
    ProjectInfo,
    | "name"
    | "defaultRunCommand"
    | "worktreePath"
    | "worktreeStartScript"
    | "worktreeTeardownScript"
    | "linearAssociations"
    | "color"
    | "agentCommand"
    | "commands"
    | "themeName"
    | "setupComplete"
    | "portlessEnabled"
  >
>;

/** Mirrors `GroupUpdatableFields` in `electron/projects/types.ts` (ADR-192; ADR-193 ticket 1). */
export type GroupUpdatableFields = Partial<
  Pick<
    ProjectInfo,
    | "name"
    | "color"
    | "agentCommand"
    | "linearAssociations"
    | "themeName"
    | "commands"
  >
>;

/**
 * Apply one watcher payload (key -> value) to `projects` as a single store
 * update. Keeps the same state on no-ops so subscribers (e.g. useDiffWatcher's
 * re-apply effect) don't re-run.
 */
function patchWorkspaces<V>(
  s: { projects: ProjectInfo[] },
  byKey: Record<WorkspaceKey, V>,
  update: (ws: WorkspaceInfo, value: V) => WorkspaceInfo,
): { projects: ProjectInfo[] } {
  let projects = s.projects;
  for (const [key, value] of Object.entries(byKey) as [WorkspaceKey, V][]) {
    projects = patch(projects, key, (ws) => update(ws, value));
  }
  return projects === s.projects ? s : { projects };
}

interface ProjectState {
  projects: ProjectInfo[];
  selectedProjectIndex: number;
  sidebarMode: SidebarMode;
  /** Last mode that wasn't `hidden`; what un-hiding restores. Not persisted. */
  lastVisibleSidebarMode: "full" | "rail";
  sidebarWidth: number;
  portsHeight: number;
  agentsHeight: number;
  /** The full sidebar's Ports and Agents panes, folded to their headers. Persisted. */
  portsCollapsed: boolean;
  agentsCollapsed: boolean;
  loading: boolean;
  initialLoadDone: boolean;
  collapsedProjectIds: Set<string>;
  collapsedFolderKeys: Set<string>;

  // Actions
  loadProjects: () => Promise<void>;
  /**
   * Re-list remote projects' worktrees, which no watcher sees change — for
   * a window focus. Local projects are left as they are. Joins a refresh
   * already running, and skips one within `REMOTE_REFRESH_MIN_INTERVAL` of
   * the last.
   */
  refreshRemoteProjects: () => Promise<void>;
  addProject: (name: string, path: string) => Promise<ProjectInfo>;
  addProjectFromDirectory: () => Promise<void>;
  /** ADR-178 ticket 5, ADR-194: clone a repo onto any host, then add it. */
  cloneProject: (opts: {
    hostId: string;
    repoUrl: string;
    targetDir: string;
    name: string;
  }) => Promise<ProjectInfo>;
  /** ADR-179: clone an existing project onto a remote host, keeping its record. */
  moveProjectToHost: (
    projectId: string,
    opts: { hostId: string; repoUrl: string; remoteDir: string },
  ) => Promise<ProjectInfo>;
  /**
   * ADR-179: switch a project to a host without cloning — to `path`, or the
   * path it last had there.
   */
  switchProjectHost: (
    projectId: string,
    hostId: string,
    path?: string,
  ) => Promise<ProjectInfo>;
  removeProject: (projectId: string) => Promise<void>;
  selectProject: (index: number) => void;
  selectWorkspace: (projectId: string, workspaceIndex: number) => void;
  createWorktree: (
    projectId: string,
    name: string,
    branch?: string,
    options?: CreateWorktreeOptions,
  ) => Promise<string | null>;
  removeWorktree: (
    projectId: string,
    worktreePath: string,
    deleteBranch?: boolean,
  ) => Promise<void>;
  canQuickMerge: (
    projectId: string,
    worktreePath: string,
  ) => Promise<{ canMerge: boolean; reason?: string }>;
  quickMergeWorktree: (
    projectId: string,
    worktreePath: string,
  ) => Promise<void>;
  renameWorkspace: (
    projectId: string,
    workspacePath: string,
    newName: string,
  ) => Promise<void>;
  setWorkspaceHidden: (
    projectId: string,
    workspacePath: string,
    hidden: boolean,
  ) => Promise<void>;
  createWorkspaceFolder: (
    projectId: string,
    name: string,
    /**
     * When given, the new folder takes the first key's slot and swallows
     * every key — one row from a row's menu, a whole selection (ADR-190 §2).
     */
    anchorKeys?: string[],
    /** Enclosing folder for the new folder; top level when omitted. */
    parentId?: string | null,
  ) => Promise<WorkspaceFolder | null>;
  renameWorkspaceFolder: (
    projectId: string,
    folderId: string,
    name: string,
  ) => Promise<void>;
  deleteWorkspaceFolder: (projectId: string, folderId: string) => Promise<void>;
  setWorkspaceFolder: (
    projectId: string,
    workspacePath: string,
    folderId: string | null,
  ) => Promise<void>;
  convertMainToWorktree: (
    projectId: string,
    name: string,
    branch: string,
  ) => Promise<string | null>;
  reorderProjects: (orderedIds: string[]) => Promise<void>;
  /**
   * ADR-192: link two projects on different hosts into one group. Errors
   * (a second member for one host, say) are shown as a toast.
   */
  linkProjects: (projectId: string, otherId: string) => Promise<void>;
  /**
   * ADR-192 ticket 4: clone `memberId`'s repo onto another host and link the
   * new project into its group, then reload. Resolves with the new project
   * as reloaded: its `group` is set once it joined. A failed clone rejects
   * and leaves the group unchanged. A failed link is shown as a toast, and
   * the new project stays, unlinked, with link suggestions offered for it.
   */
  cloneIntoGroup: (
    memberId: string,
    opts: { hostId: string; repoUrl: string; remoteDir: string },
  ) => Promise<ProjectInfo>;
  /**
   * ADR-193 ticket 4: let a remote project pick a local checkout to link
   * with, via a folder dialog rather than "Add project" first. Links an
   * existing local project at the chosen path, or adds one there and links
   * that. Cancelling the dialog is a no-op; errors (not a git repo, say) are
   * shown as a toast.
   */
  linkLocalFolder: (projectId: string) => Promise<void>;
  /** ADR-192: take a project out of its group. Errors are shown as a toast. */
  unlinkProject: (projectId: string) => Promise<void>;
  /** ADR-192: dissolve a whole group. Errors are shown as a toast. */
  unlinkGroup: (groupId: string) => Promise<void>;
  /**
   * ADR-192 ticket 2: set a group's shared settings, shown on every member
   * at once. Errors roll the change back and are shown as a toast.
   */
  updateGroup: (
    groupId: string,
    updates: GroupUpdatableFields,
  ) => Promise<void>;
  /**
   * ADR-192: remember the host a group last made a workspace on, where the
   * New Workspace host picker starts next time. Workspace creates record it
   * in main (ADR-203); a failure only loses the default, so it is quiet.
   */
  setGroupLastUsedHost: (groupId: string, hostId: string) => Promise<void>;
  /** Persists a full sidebar order: workspace paths and folder ids. */
  reorderSidebar: (projectId: string, orderedKeys: string[]) => Promise<void>;
  /** Persists a whole sidebar tree: membership changes, then the order. */
  applySidebarChange: (projectId: string, next: SidebarItem[]) => Promise<void>;
  updateProject: (
    projectId: string,
    updates: ProjectUpdatableFields,
  ) => Promise<void>;
  linkIssueToWorkspace: (
    projectId: string,
    workspacePath: string,
    issue: LinkedIssue,
  ) => Promise<void>;
  /** Apply one branch-watcher payload (key → branch) as a single update. */
  updateWorkspaceBranches: (branchByKey: Record<WorkspaceKey, string>) => void;
  /** Apply one diff-watcher payload (key → stats, null clears) as a single update. */
  updateWorkspaceDiffStats: (
    statsByKey: Record<WorkspaceKey, DiffStats | null>,
  ) => void;
  updateWorkspacePr: (key: WorkspaceKey, pr: PrInfo | null) => void;
  setSidebarMode: (mode: SidebarMode) => void;
  /** full <-> rail; hidden -> full. */
  toggleSidebarRail: () => void;
  /** hidden -> last visible mode; otherwise hidden. */
  toggleSidebarHidden: () => void;
  setSidebarWidth: (width: number) => void;
  setPortsHeight: (height: number) => void;
  setAgentsHeight: (height: number) => void;
  setPortsCollapsed: (collapsed: boolean) => void;
  setAgentsCollapsed: (collapsed: boolean) => void;
  toggleProjectCollapsed: (projectId: string) => void;
  setProjectExpanded: (projectId: string) => void;
  toggleFolderCollapsed: (projectId: string, folderId: string) => void;
  setFolderExpanded: (projectId: string, folderId: string) => void;
}

/**
 * After a host switch (ADR-179) the project's workspaces live at new paths
 * on the new host; the old ones — the previous checkout and its worktrees —
 * are no longer part of it. Select the new main workspace if the window was
 * showing one of them, then close their tabs, killing their terminals, so
 * nothing is left running against a workspace that is gone. A workspace
 * whose path the new host has too keeps its tabs, moved to its key on the
 * new host (ADR-191 §3), as main moves its saved layout.
 */
function closeWorkspacesLeftBehind(
  previous: ProjectInfo,
  updated: ProjectInfo,
  selectWorkspace: (projectId: string, workspaceIndex: number) => void,
): void {
  const app = useAppStore.getState();
  const kept = new Set(updated.workspaces.map((ws) => ws.path));
  // The same [old key, new key] pairs main's `moveLayouts`
  // (`electron/ipc/projects.ts`) moves in `layout.json`; keep them in step.
  for (const ws of previous.workspaces) {
    if (!kept.has(ws.path)) continue;
    app.moveWorkspaceLayout(
      workspaceKey(previous.hostId, ws.path),
      workspaceKey(updated.hostId, ws.path),
    );
  }
  const gone = previous.workspaces
    .filter((ws) => !kept.has(ws.path))
    .map((ws) => workspaceKey(previous.hostId, ws.path));
  if (gone.length === 0) return;
  const activeKey = selectActiveWorkspaceKey(useAppStore.getState());
  if (activeKey && gone.includes(activeKey)) {
    const mainIdx = updated.workspaces.findIndex(
      (ws) => ws.path === updated.path,
    );
    selectWorkspace(updated.id, mainIdx >= 0 ? mainIdx : 0);
  }
  for (const key of gone) useAppStore.getState().removeWorkspaceLayout(key);
}

/** An error toast for a failed link or unlink (ADR-192). */
function groupErrorToast(id: string, message: string, err: unknown): void {
  useToastStore.getState().addToast({
    id,
    message,
    status: "error",
    detail: ipcErrorMessage(err),
  });
}

/**
 * Drop a group's collapsed key once no project belongs to it any more, so a
 * dissolved group's id doesn't linger in `collapsedProjectIds` (ADR-192).
 */
function forgetDissolvedGroup(groupId: string | undefined): void {
  if (!groupId) return;
  useProjectStore.setState((s) => {
    if (!s.collapsedProjectIds.has(groupId)) return s;
    if (s.projects.some((p) => p.group?.id === groupId)) return s;
    const next = new Set(s.collapsedProjectIds);
    next.delete(groupId);
    saveCollapsedIds(next);
    return { collapsedProjectIds: next };
  });
}

const initialSidebarMode = loadSidebarMode();

/** The least time between two `refreshRemoteProjects` runs. */
export const REMOTE_REFRESH_MIN_INTERVAL = 30_000;

/** `refreshRemoteProjects`' refresh: re-list remote projects, keep local ones. */
const remoteRefresh = sharedRefresh(async () => {
  try {
    const fresh = new Map(
      (await window.electronAPI.projects.getRemote()).map((p) => [p.id, p]),
    );
    // Local projects keep their objects, so nothing re-renders for them.
    useProjectStore.setState((s) => ({
      projects: s.projects.map((p) => {
        const f = fresh.get(p.id);
        return f ? reconcile([f], [p])[0] : p;
      }),
    }));
  } catch {
    // Host unreachable: the next focus tries again.
  }
}, REMOTE_REFRESH_MIN_INTERVAL);

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  selectedProjectIndex: 0,
  sidebarMode: initialSidebarMode,
  lastVisibleSidebarMode:
    initialSidebarMode === "hidden" ? "full" : initialSidebarMode,
  sidebarWidth: loadSidebarWidth(),
  portsHeight: loadPortsHeight(),
  agentsHeight: loadAgentsHeight(),
  portsCollapsed: loadFlag(PORTS_COLLAPSED_KEY),
  agentsCollapsed: loadFlag(AGENTS_COLLAPSED_KEY),
  loading: false,
  initialLoadDone: false,
  collapsedProjectIds: loadCollapsedIds(),
  collapsedFolderKeys: loadCollapsedFolderKeys(),

  loadProjects: async () => {
    set({ loading: true });
    try {
      const projects = await window.electronAPI.projects.getAll();
      const selectedIndex =
        await window.electronAPI.projects.getSelectedIndex();
      const firstLoad = !get().initialLoadDone;
      set((s) => ({
        projects: reconcile(projects, s.projects),
        selectedProjectIndex: selectedIndex,
        loading: false,
        initialLoadDone: true,
      }));
      // ADR-192 ticket 5: offer links between existing duplicates, now and
      // as each remote host first connects.
      if (firstLoad)
        void startLinkSuggestions(() => get().projects, get().linkProjects);
    } catch {
      set({ loading: false, initialLoadDone: true });
    }
  },

  refreshRemoteProjects: () => {
    if (!get().projects.some((p) => isRemoteHost(p.hostId))) return Promise.resolve();
    return remoteRefresh.runIfDue() ?? Promise.resolve();
  },

  addProject: async (name: string, path: string) => {
    const project = await window.electronAPI.projects.add(name, path);
    set((s) => ({
      projects: [...s.projects, project],
      selectedProjectIndex: s.projects.length,
    }));
    void offerLinkSuggestions(project.id, get().linkProjects);
    return project;
  },

  addProjectFromDirectory: async () => {
    const selected = await window.electronAPI.dialog.openDirectory();
    if (selected) {
      const name = selected.split("/").pop() || "Untitled";
      await get().addProject(name, selected);
    }
  },

  cloneProject: async (opts) => {
    const project = await window.electronAPI.projects.clone(opts);
    set((s) => ({
      projects: [...s.projects, project],
      selectedProjectIndex: s.projects.length,
    }));
    void offerLinkSuggestions(project.id, get().linkProjects);
    return project;
  },

  moveProjectToHost: async (projectId, opts) => {
    const previous = get().projects.find((p) => p.id === projectId);
    const updated = await window.electronAPI.projects.moveToHost(
      projectId,
      opts,
    );
    set((s) => ({
      projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
    }));
    if (previous)
      closeWorkspacesLeftBehind(previous, updated, get().selectWorkspace);
    return updated;
  },

  switchProjectHost: async (projectId, hostId, path) => {
    const previous = get().projects.find((p) => p.id === projectId);
    const updated = await window.electronAPI.projects.switchHost(
      projectId,
      hostId,
      path,
    );
    set((s) => ({
      projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
    }));
    if (previous)
      closeWorkspacesLeftBehind(previous, updated, get().selectWorkspace);
    return updated;
  },

  removeProject: async (projectId: string) => {
    const groupId = get().projects.find((p) => p.id === projectId)?.group?.id;
    await window.electronAPI.projects.remove(projectId);
    if (groupId) {
      // The other members' group summaries changed (or the group dissolved).
      await get().loadProjects();
      forgetDissolvedGroup(groupId);
      return;
    }
    set((s) => {
      const projects = s.projects.filter((p) => p.id !== projectId);
      return {
        projects,
        selectedProjectIndex: Math.min(
          s.selectedProjectIndex,
          Math.max(0, projects.length - 1),
        ),
      };
    });
  },

  selectProject: (index: number) => {
    window.electronAPI.projects.select(index);
    set({ selectedProjectIndex: index });
  },

  selectWorkspace: (projectId: string, workspaceIndex: number) => {
    window.electronAPI.projects.selectWorkspace(projectId, workspaceIndex);
    const projectIndex = get().projects.findIndex((p) => p.id === projectId);
    set((s) => ({
      selectedProjectIndex:
        projectIndex >= 0 ? projectIndex : s.selectedProjectIndex,
      projects: s.projects.map((p) =>
        p.id === projectId
          ? { ...p, selectedWorkspaceIndex: workspaceIndex }
          : p,
      ),
    }));
    // Activate the workspace in the app store so the UI switches to it
    const project = get().projects.find((p) => p.id === projectId);
    const ws = project?.workspaces[workspaceIndex];
    if (ws) {
      useAppStore.getState().setActiveWorkspace(ws.path, project.hostId);
      if (ws.folderId) {
        get().setFolderExpanded(projectId, ws.folderId);
      }
    }
  },

  createWorktree: async (
    projectId: string,
    name: string,
    branch?: string,
    options: CreateWorktreeOptions = {},
  ) => {
    const { agentCommand, linkedIssue, baseBranch, useExistingBranch } =
      options;
    const project = get().projects.find((p) => p.id === projectId);
    const startScript = project?.worktreeStartScript ?? null;

    // Init setup state before IPC call
    useAppStore
      .getState()
      .initWorktreeSetup("__pending__", !!startScript, startScript);

    // Subscribe to progress events BEFORE calling IPC
    const unsubProgress = window.electronAPI.projects.onWorktreeSetupProgress(
      (event: SetupProgressEvent) => {
        useAppStore
          .getState()
          .updateWorktreeSetupStep(
            "__pending__",
            event.step,
            event.status,
            event.message,
          );
      },
    );

    let updated;
    try {
      updated = await window.electronAPI.projects.createWorktree(
        projectId,
        name,
        branch,
        linkedIssue,
        baseBranch,
        useExistingBranch,
      );
    } catch (err) {
      unsubProgress();
      useAppStore.getState().clearWorktreeSetup("__pending__");
      const detail = ipcErrorMessage(err);
      useToastStore.getState().addToast({
        id: `worktree-error-${Date.now()}`,
        message: "Failed to create workspace",
        status: "error",
        detail,
      });
      return null;
    }

    unsubProgress();

    if (!updated) {
      useAppStore.getState().clearWorktreeSetup("__pending__");
      return null;
    }

    set((s) => ({
      projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
    }));

    // Main records the group's last-used host itself (ADR-203); its
    // `projects-changed` broadcast reloads the other members' summaries.

    // Find the new workspace by name or branch.
    const branchName = branch || name;
    const newWs = updated.workspaces.find(
      (ws) =>
        !ws.isMain &&
        (ws.name === name || branchesEqual(ws.branch, branchName)),
    );
    const wsPath = newWs?.path ?? null;

    if (wsPath) {
      // Migrate __pending__ key to the real workspace path
      useAppStore.getState().migrateWorktreeSetupPath("__pending__", wsPath);

      // Force all IPC-driven steps to "done" — the successful IPC return
      // guarantees they completed, but progress events delivered via
      // webContents.send may arrive after the ipcMain.handle response,
      // racing with unsubProgress() above.
      const ipcSteps: SetupStep[] = [
        "prune",
        "fetch",
        "create-worktree",
        "persist",
      ];
      for (const step of ipcSteps) {
        useAppStore.getState().updateWorktreeSetupStep(wsPath, step, "done");
      }

      // Emit switch step as in-progress
      useAppStore
        .getState()
        .updateWorktreeSetupStep(wsPath, "switch", "in-progress");

      // Select the new workspace and switch to it
      const newIdx = updated.workspaces.findIndex((ws) => ws.path === wsPath);
      if (newIdx >= 0) get().selectWorkspace(projectId, newIdx);

      // Mark switch as done
      useAppStore.getState().updateWorktreeSetupStep(wsPath, "switch", "done");

      if (startScript) {
        // Kick off the setup script at store scope so its PTY outlives the
        // WorkspaceSetupView — the view renders an `attach`-mode MiniTerminal
        // to observe the same session without owning its lifecycle.
        startSetupScript(wsPath, startScript, project?.hostId);
        if (agentCommand) {
          // The agent doesn't wait for the script: both run in parallel. Its
          // tab replaces the setup view, so progress moves to the background
          // toast that `startSetupScript`'s exit handler removes.
          // The launch line waits on the server for the new tab's pane
          // (ADR-179 ticket 11).
          useAppStore
            .getState()
            .addTerminalTab(agentCommand, { kind: "agent-startup" });
          useToastStore.getState().addToast({
            id: `worktree-setup-${wsPath}`,
            message: `Setting up "${name}"…`,
            status: "loading",
            persistent: true,
          });
        }
      } else if (agentCommand) {
        // No start script — open the agent tab and let the server type the
        // launch line into it (ADR-179 ticket 11).
        useAppStore.getState().addTerminalTab(agentCommand, { kind: "agent-startup" });
        useAppStore.getState().clearWorktreeSetup(wsPath);
      } else {
        // No commands at all — clear setup state
        useAppStore.getState().clearWorktreeSetup(wsPath);
      }
    } else {
      useAppStore.getState().clearWorktreeSetup("__pending__");
    }

    return wsPath;
  },

  removeWorktree: async (
    projectId: string,
    worktreePath: string,
    deleteBranch?: boolean,
  ) => {
    await window.electronAPI.projects.removeWorktree(
      projectId,
      worktreePath,
      deleteBranch,
    );
    // Refresh projects to get updated worktree list
    const projects = await window.electronAPI.projects.getAll();
    set((s) => ({ projects: reconcile(projects, s.projects) }));
  },

  canQuickMerge: async (projectId: string, worktreePath: string) => {
    return window.electronAPI.projects.canQuickMerge(projectId, worktreePath);
  },

  quickMergeWorktree: async (projectId: string, worktreePath: string) => {
    await window.electronAPI.projects.quickMergeWorktree(
      projectId,
      worktreePath,
    );
    // Refresh projects to get updated worktree list
    const projects = await window.electronAPI.projects.getAll();
    set((s) => ({ projects: reconcile(projects, s.projects) }));
  },

  convertMainToWorktree: async (
    projectId: string,
    name: string,
    branch: string,
  ) => {
    let updated;
    try {
      updated = await window.electronAPI.projects.convertMainToWorktree(
        projectId,
        name,
      );
    } catch (err) {
      const detail = ipcErrorMessage(err);
      useToastStore.getState().addToast({
        id: `convert-error-${Date.now()}`,
        message: "Failed to convert to workspace",
        status: "error",
        detail,
      });
      return null;
    }
    if (!updated) return null;
    set((s) => ({
      projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
    }));
    // Find and select the new worktree workspace
    const newWs = updated.workspaces.find(
      (ws) => !ws.isMain && branchesEqual(ws.branch, branch),
    );
    const wsPath = newWs?.path ?? null;
    if (wsPath) {
      const newIdx = updated.workspaces.findIndex((ws) => ws.path === wsPath);
      if (newIdx >= 0) get().selectWorkspace(projectId, newIdx);
      const startScript = updated.worktreeStartScript;
      if (startScript) {
        useAppStore.getState().addTerminalTab(startScript);
      }
    }
    return wsPath;
  },

  reorderProjects: async (orderedIds: string[]) => {
    await window.electronAPI.projects.reorder(orderedIds);
    set((s) => {
      const selectedId = s.projects[s.selectedProjectIndex]?.id;
      const byId = new Map(s.projects.map((p) => [p.id, p]));
      const reordered = orderedIds
        .map((id) => byId.get(id))
        .filter((p): p is ProjectInfo => p != null);
      const orderedSet = new Set(orderedIds);
      for (const p of s.projects) {
        if (!orderedSet.has(p.id)) reordered.push(p);
      }
      const newSelectedIndex = selectedId
        ? Math.max(
            0,
            reordered.findIndex((p) => p.id === selectedId),
          )
        : s.selectedProjectIndex;
      return { projects: reordered, selectedProjectIndex: newSelectedIndex };
    });
  },

  linkProjects: async (projectId: string, otherId: string) => {
    try {
      await window.electronAPI.projects.link(projectId, otherId);
    } catch (err) {
      groupErrorToast(
        `link-projects-${projectId}`,
        "Couldn't link projects",
        err,
      );
      return;
    }
    clearLinkSuggestionsFor([projectId, otherId]);
    await get().loadProjects();
  },

  cloneIntoGroup: async (memberId, opts) => {
    const member = get().projects.find((p) => p.id === memberId);
    if (!member?.group) throw new Error("This project isn't linked to a group.");
    const cloned = await window.electronAPI.projects.clone({
      hostId: opts.hostId,
      repoUrl: opts.repoUrl,
      targetDir: opts.remoteDir,
      name: member.name,
    });
    try {
      await window.electronAPI.projects.link(cloned.id, memberId);
      clearLinkSuggestionsFor([cloned.id, memberId]);
    } catch (err) {
      groupErrorToast(
        `link-projects-${cloned.id}`,
        "Cloned, but couldn't link the projects",
        err,
      );
      // It stands alone now, like any other clone: offer what it could join.
      void offerLinkSuggestions(cloned.id, get().linkProjects);
    }
    await get().loadProjects();
    return get().projects.find((p) => p.id === cloned.id) ?? cloned;
  },

  linkLocalFolder: async (projectId: string) => {
    const remote = get().projects.find((p) => p.id === projectId);
    if (!remote) return;
    const selected = await window.electronAPI.dialog.openDirectory();
    if (!selected) return;

    // Already a Manor project at that path — link it as is.
    const existingLocal = get().projects.find(
      (p) => !isRemoteHost(p.hostId) && p.path === selected,
    );

    let localId: string;
    if (existingLocal) {
      localId = existingLocal.id;
    } else {
      const name = remote.group?.name ?? remote.name;
      let created;
      try {
        created = await window.electronAPI.projects.add(name, selected);
      } catch (err) {
        groupErrorToast(
          `link-local-folder-${projectId}`,
          "Couldn't add local folder",
          err,
        );
        return;
      }
      // Append like `addProject` does, but without offering link suggestions
      // for it (it is about to be linked here) or moving the selection off
      // the remote project the user is looking at.
      set((s) => ({ projects: [...s.projects, created] }));
      localId = created.id;
    }

    // `otherId` wins the group's name/settings when neither side is grouped
    // yet, so the remote project — the one the user started from — does.
    await get().linkProjects(localId, projectId);
  },

  unlinkProject: async (projectId: string) => {
    const groupId = get().projects.find((p) => p.id === projectId)?.group?.id;
    try {
      await window.electronAPI.projects.unlink(projectId);
    } catch (err) {
      groupErrorToast(
        `unlink-project-${projectId}`,
        "Couldn't unlink project",
        err,
      );
      return;
    }
    await get().loadProjects();
    forgetDissolvedGroup(groupId);
  },

  unlinkGroup: async (groupId: string) => {
    try {
      await window.electronAPI.projects.unlinkGroup(groupId);
    } catch (err) {
      groupErrorToast(
        `unlink-group-${groupId}`,
        "Couldn't unlink projects",
        err,
      );
      return;
    }
    await get().loadProjects();
    forgetDissolvedGroup(groupId);
  },

  updateGroup: async (groupId: string, updates: GroupUpdatableFields) => {
    const previous = new Map(
      get()
        .projects.filter((p) => p.group?.id === groupId)
        .map((p) => [p.id, p]),
    );
    // As main does: the name is trimmed, and a blank one changes nothing.
    const { name: rawName, ...rest } = updates;
    const name = rawName?.trim();
    const applied: GroupUpdatableFields = name ? { ...rest, name } : rest;
    const apply = (p: ProjectInfo): ProjectInfo => ({
      ...p,
      ...applied,
      group: p.group && name ? { ...p.group, name } : p.group,
    });
    set((s) => ({
      projects: s.projects.map((p) => (previous.has(p.id) ? apply(p) : p)),
    }));
    let members: ProjectInfo[];
    try {
      members = await window.electronAPI.projects.updateGroup(groupId, updates);
    } catch (err) {
      // Put back only the fields still holding this call's values, so a
      // newer update that landed meanwhile isn't clobbered.
      set((s) => ({
        projects: s.projects.map((p) => {
          const before = previous.get(p.id);
          if (!before) return p;
          const undo: Partial<ProjectInfo> = {};
          for (const key of Object.keys(
            applied,
          ) as (keyof GroupUpdatableFields)[]) {
            if (p[key] === applied[key])
              Object.assign(undo, { [key]: before[key] });
          }
          if (undo.name !== undefined) undo.group = before.group;
          return { ...p, ...undo };
        }),
      }));
      groupErrorToast(
        `update-group-${groupId}`,
        "Couldn't save shared settings",
        err,
      );
      return;
    }
    // Only the shared settings changed; take those, and keep the rest (the
    // watchers' PR and diff state on each workspace, say) as it is.
    const byId = new Map(members.map((p) => [p.id, p]));
    set((s) => ({
      projects: s.projects.map((p) => {
        const fresh = byId.get(p.id);
        if (!fresh) return p;
        const { name, color, agentCommand, linearAssociations, group } = fresh;
        return { ...p, name, color, agentCommand, linearAssociations, group };
      }),
    }));
  },

  setGroupLastUsedHost: async (groupId: string, hostId: string) => {
    const alreadyRecorded = (p: ProjectInfo) =>
      p.group?.id !== groupId || p.group.lastUsedHostId === hostId;
    if (get().projects.every(alreadyRecorded)) return;
    try {
      await window.electronAPI.projects.setGroupLastUsedHost(groupId, hostId);
    } catch {
      // Only the picker's default is lost; the workspace was made.
      return;
    }
    set((s) => ({
      projects: s.projects.map((p) =>
        alreadyRecorded(p) || !p.group
          ? p
          : { ...p, group: { ...p.group, lastUsedHostId: hostId } },
      ),
    }));
  },

  reorderSidebar: async (projectId: string, orderedKeys: string[]) => {
    await window.electronAPI.projects.reorderWorkspaces(projectId, orderedKeys);
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              sidebarOrder: orderedKeys,
              workspaces: sortWorkspacesByOrder(p.workspaces, orderedKeys),
            }
          : p,
      ),
    }));
  },

  applySidebarChange: async (projectId: string, next: SidebarItem[]) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;

    const order = serializeOrder(next, project);
    const membership = membershipOf(next);
    const changes: { path: string; folderId: string | null }[] = [];
    for (const ws of project.workspaces) {
      // Hidden workspaces aren't in the tree; their membership is untouched.
      if (!membership.has(ws.path)) continue;
      const nextFolderId = membership.get(ws.path) ?? null;
      if (nextFolderId !== (ws.folderId ?? null)) {
        changes.push({ path: ws.path, folderId: nextFolderId });
      }
    }
    const changedByPath = new Map(changes.map((c) => [c.path, c.folderId]));

    // Folder nesting is the other half of the structure (ADR-172). The map is
    // parents-first, and the calls below keep that order: main refuses a move
    // that would close a cycle, and applying a parent before its children is
    // what keeps a swap of two folders out of that state.
    const parents = folderParentsOf(next);
    const folderById = new Map(project.folders.map((f) => [f.id, f]));
    const folderChanges: { folderId: string; parentId: string | null }[] = [];
    for (const [folderId, parentId] of parents) {
      const folder = folderById.get(folderId);
      if (!folder) continue;
      if (parentId !== (folder.parentId ?? null)) {
        folderChanges.push({ folderId, parentId });
      }
    }
    const changedByFolderId = new Map(
      folderChanges.map((c) => [c.folderId, c.parentId]),
    );

    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              sidebarOrder: order,
              folders: p.folders.map((f) =>
                changedByFolderId.has(f.id)
                  ? { ...f, parentId: changedByFolderId.get(f.id) ?? null }
                  : f,
              ),
              workspaces: sortWorkspacesByOrder(
                p.workspaces.map((ws) =>
                  changedByPath.has(ws.path)
                    ? { ...ws, folderId: changedByPath.get(ws.path) ?? null }
                    : ws,
                ),
                order,
              ),
            }
          : p,
      ),
    }));

    for (const change of changes) {
      await window.electronAPI.projects.setWorkspaceFolder(
        projectId,
        change.path,
        change.folderId,
      );
    }
    for (const change of folderChanges) {
      await window.electronAPI.projects.setFolderParent(
        projectId,
        change.folderId,
        change.parentId,
      );
    }
    await window.electronAPI.projects.reorderWorkspaces(projectId, order);
  },

  renameWorkspace: async (
    projectId: string,
    workspacePath: string,
    newName: string,
  ) => {
    await window.electronAPI.projects.renameWorkspace(
      projectId,
      workspacePath,
      newName,
    );
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              workspaces: p.workspaces.map((ws) =>
                ws.path === workspacePath
                  ? { ...ws, name: newName.trim() || null }
                  : ws,
              ),
            }
          : p,
      ),
    }));
  },

  setWorkspaceHidden: async (projectId, workspacePath, hidden) => {
    await window.electronAPI.projects.setWorkspaceHidden(
      projectId,
      workspacePath,
      hidden,
    );
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              workspaces: p.workspaces.map((ws) =>
                ws.path === workspacePath ? { ...ws, hidden } : ws,
              ),
            }
          : p,
      ),
    }));
  },

  createWorkspaceFolder: async (
    projectId: string,
    name: string,
    anchorKeys?: string[],
    parentId?: string | null,
  ) => {
    const folder = await window.electronAPI.projects.createWorkspaceFolder(
      projectId,
      name,
      parentId ?? null,
    );
    if (!folder) return folder;

    // Main appends the id to the persisted order; mirror that locally.
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              folders: [...p.folders, folder],
              sidebarOrder: [...p.sidebarOrder, folder.id],
            }
          : p,
      ),
    }));

    if (anchorKeys && anchorKeys.length > 0) {
      const project = get().projects.find((p) => p.id === projectId);
      if (project) {
        const items = buildSidebarItems(project);
        await get().applySidebarChange(
          projectId,
          placeManyInFolder(
            insertFolderBefore(items, folder, anchorKeys[0]),
            anchorKeys,
            folder.id,
          ),
        );
      }
    }

    return folder;
  },

  renameWorkspaceFolder: async (
    projectId: string,
    folderId: string,
    name: string,
  ) => {
    const trimmed = name.trim();
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              folders: p.folders.map((f) =>
                f.id === folderId ? { ...f, name: trimmed } : f,
              ),
            }
          : p,
      ),
    }));
    await window.electronAPI.projects.renameWorkspaceFolder(
      projectId,
      folderId,
      name,
    );
  },

  deleteWorkspaceFolder: async (projectId: string, folderId: string) => {
    set((s) => ({
      projects: s.projects.map((p) => {
        if (p.id !== projectId) return p;
        // Main promotes rather than orphans: whatever the folder held —
        // member workspaces and child folders alike — moves up to the
        // grandparent and takes the deleted folder's slot in the order.
        const parentId =
          p.folders.find((f) => f.id === folderId)?.parentId ?? null;
        const orderIndex = new Map(
          p.sidebarOrder.map((entry, i) => [entry, i]),
        );
        const memberKeys = [
          ...p.workspaces
            .filter((ws) => ws.folderId === folderId)
            .map((ws) => ws.path),
          ...p.folders.filter((f) => f.parentId === folderId).map((f) => f.id),
        ].sort(
          (a, b) =>
            (orderIndex.get(a) ?? Infinity) - (orderIndex.get(b) ?? Infinity),
        );
        const sidebarOrder = spliceFolderOutOfOrder(
          p.sidebarOrder,
          folderId,
          memberKeys,
        );
        return {
          ...p,
          folders: p.folders
            .filter((f) => f.id !== folderId)
            .map((f) => (f.parentId === folderId ? { ...f, parentId } : f)),
          workspaces: sortWorkspacesByOrder(
            p.workspaces.map((ws) =>
              ws.folderId === folderId ? { ...ws, folderId: parentId } : ws,
            ),
            sidebarOrder,
          ),
          sidebarOrder,
        };
      }),
      collapsedFolderKeys: (() => {
        const next = new Set(s.collapsedFolderKeys);
        next.delete(folderCollapseKey(projectId, folderId));
        saveCollapsedFolderKeys(next);
        return next;
      })(),
    }));
    await window.electronAPI.projects.deleteWorkspaceFolder(
      projectId,
      folderId,
    );
  },

  setWorkspaceFolder: async (
    projectId: string,
    workspacePath: string,
    folderId: string | null,
  ) => {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              workspaces: p.workspaces.map((ws) =>
                ws.path === workspacePath ? { ...ws, folderId } : ws,
              ),
            }
          : p,
      ),
    }));
    await window.electronAPI.projects.setWorkspaceFolder(
      projectId,
      workspacePath,
      folderId,
    );
  },

  updateProject: async (projectId: string, updates: ProjectUpdatableFields) => {
    const previous = get().projects.find((p) => p.id === projectId);
    const groupId = previous?.group?.id;
    if (groupId) {
      // A grouped project's shared settings are its group's (ADR-192), so
      // they go there and show on every member at once.
      const { shared, own } = splitShared(updates);
      if (Object.keys(shared).length > 0) {
        await Promise.all([
          get().updateGroup(groupId, shared),
          Object.keys(own).length > 0
            ? get().updateProject(projectId, own)
            : null,
        ]);
        return;
      }
    }
    // Optimistic update: apply changes immediately for instant UI feedback
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, ...updates } : p,
      ),
    }));
    let updated: ProjectInfo | null;
    try {
      updated = await window.electronAPI.projects.update(projectId, updates);
    } catch (err) {
      // Main refused (e.g. an unknown hostId): undo the optimistic change —
      // but only the fields still holding this call's values, so a newer
      // update that landed meanwhile isn't clobbered — then let the caller
      // surface the error.
      if (previous) {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId) return p;
            const undo: Partial<ProjectInfo> = {};
            for (const key of Object.keys(
              updates,
            ) as (keyof ProjectUpdatableFields)[]) {
              if (p[key] === updates[key])
                Object.assign(undo, { [key]: previous[key] });
            }
            return { ...p, ...undo };
          }),
        }));
      }
      throw err;
    }
    if (updated) {
      set((s) => ({
        projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
      }));
    }
  },

  linkIssueToWorkspace: async (
    projectId: string,
    workspacePath: string,
    issue: LinkedIssue,
  ) => {
    await window.electronAPI.linear.linkIssueToWorkspace(
      projectId,
      workspacePath,
      issue,
    );
    await get().loadProjects();
  },

  updateWorkspaceBranches: (branchByKey) =>
    set((s) =>
      patchWorkspaces(s, branchByKey, (ws, branch) =>
        branchesEqual(ws.branch, branch) ? ws : { ...ws, branch },
      ),
    ),

  updateWorkspaceDiffStats: (statsByKey) =>
    set((s) =>
      patchWorkspaces(s, statsByKey, (ws, stats) =>
        ws.diffStats?.added === stats?.added &&
        ws.diffStats?.removed === stats?.removed
          ? ws
          : { ...ws, diffStats: stats },
      ),
    ),

  updateWorkspacePr: (key, pr) =>
    set((s) => {
      const projects = patch(s.projects, key, (ws) =>
        prEqual(ws.pr, pr) ? ws : { ...ws, pr },
      );
      return projects === s.projects ? s : { projects };
    }),

  setSidebarMode: (mode) => {
    try {
      localStorage.setItem(SIDEBAR_MODE_KEY, mode);
    } catch {
      /* ignore */
    }
    set((s) => ({
      sidebarMode: mode,
      lastVisibleSidebarMode:
        mode === "hidden" ? s.lastVisibleSidebarMode : mode,
    }));
  },

  toggleSidebarRail: () =>
    get().setSidebarMode(get().sidebarMode === "full" ? "rail" : "full"),

  toggleSidebarHidden: () => {
    const { sidebarMode, lastVisibleSidebarMode } = get();
    get().setSidebarMode(
      sidebarMode === "hidden" ? lastVisibleSidebarMode : "hidden",
    );
  },

  setSidebarWidth: (width: number) => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    set({ sidebarWidth: width });
  },

  setPortsHeight: (height: number) => {
    const clamped = Math.max(
      MIN_PORTS_HEIGHT,
      Math.min(MAX_PORTS_HEIGHT, height),
    );
    localStorage.setItem(PORTS_HEIGHT_KEY, String(clamped));
    set({ portsHeight: clamped });
  },

  setAgentsHeight: (height: number) => {
    const clamped = Math.max(
      MIN_AGENTS_HEIGHT,
      Math.min(MAX_AGENTS_HEIGHT, height),
    );
    localStorage.setItem(AGENTS_HEIGHT_KEY, String(clamped));
    set({ agentsHeight: clamped });
  },

  setPortsCollapsed: (collapsed: boolean) => {
    saveFlag(PORTS_COLLAPSED_KEY, collapsed);
    set({ portsCollapsed: collapsed });
  },

  setAgentsCollapsed: (collapsed: boolean) => {
    saveFlag(AGENTS_COLLAPSED_KEY, collapsed);
    set({ agentsCollapsed: collapsed });
  },

  toggleProjectCollapsed: (projectId: string) =>
    set((s) => {
      const next = new Set(s.collapsedProjectIds);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      saveCollapsedIds(next);
      return { collapsedProjectIds: next };
    }),

  setProjectExpanded: (projectId: string) =>
    set((s) => {
      // A linked project is only visible once its group is open too (ADR-192).
      const groupId = s.projects.find((p) => p.id === projectId)?.group?.id;
      const keys = groupId ? [projectId, groupId] : [projectId];
      if (!keys.some((key) => s.collapsedProjectIds.has(key))) return s;
      const next = new Set(s.collapsedProjectIds);
      for (const key of keys) next.delete(key);
      saveCollapsedIds(next);
      return { collapsedProjectIds: next };
    }),

  toggleFolderCollapsed: (projectId: string, folderId: string) =>
    set((s) => {
      const key = folderCollapseKey(projectId, folderId);
      const next = new Set(s.collapsedFolderKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsedFolderKeys(next);
      return { collapsedFolderKeys: next };
    }),

  setFolderExpanded: (projectId: string, folderId: string) =>
    set((s) => {
      const key = folderCollapseKey(projectId, folderId);
      if (!s.collapsedFolderKeys.has(key)) return s;
      const next = new Set(s.collapsedFolderKeys);
      next.delete(key);
      saveCollapsedFolderKeys(next);
      return { collapsedFolderKeys: next };
    }),
}));

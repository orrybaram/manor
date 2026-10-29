import { create } from "zustand";
import { selectActiveWorkspaceKey, useAppStore } from "./app-store";
import { provideHostLookups } from "../bridge/host-lookups";
import { workspaceKey, type WorkspaceKey } from "../lib/workspace-key";
import { toast } from "../toast";
import { runAutoJoin, startAutoJoin, type AutoJoinDeps } from "./auto-join";
import { branchesEqual } from "../utils/branch-name";
import { ipcErrorMessage } from "../lib/ipc-error";
import { splitShared } from "../lib/project-groups";
import { memberDisplayName } from "../bridge/server-set";
import { isRemoteHost } from "../lib/hosts";
import { requestUi } from "../utils/ui-request";
import { useHostStore } from "./host-store";
import { useHostProfileStore } from "./host-profile-store";
import type { TransferInputReason, TransferMode } from "../electron";
import { patch, reconcile } from "../lib/workspace-directory";
import { sharedRefresh } from "../lib/shared-refresh";
import { pickDirectory } from "../lib/pick-directory";
import { DEFAULT_AGENT_COMMAND } from "../lib/agent-command";
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
  PrReviewer,
} from "../lib/pr-info";

export type {
  ChecksSummary,
  PrCheckRun,
  PrComment,
  PrInfo,
  PrReviewer,
} from "../lib/pr-info";

/**
 * The fallback dialog's state for a transfer that needs input or failed.
 * `"failed"` is renderer-only: the transfer threw, so the dialog
 * opens on the planned (or empty) values with `error` explaining why. `"manual"` is the sidebar's
 * "Choose location…": no banner, the dialog fills its own defaults.
 */
export interface TransferDialogState {
  projectId: string;
  hostId: string;
  /** `setUp` is "Set up on"; `move` is only the repair re-clone. */
  mode: "setUp" | "move";
  reason: TransferInputReason | "failed" | "manual";
  repoUrl: string | null;
  targetDir: string;
  /** The thrown message, for `reason: "failed"`. */
  error?: string;
  /**
   * Set when `openInNewHost` opened the dialog on its pod `hostId`: the
   * submit finishes through it, so the pod is marked.
   */
  newHost?: NewHostPod;
}

/** A pod `openInNewHost` made from `profileId` and has yet to mark. */
export interface NewHostPod {
  hostId: string;
  profileId: string;
}

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

/** A new workspace's setup script, followed from the renderer. */
interface SetupScriptWatch {
  /** The workspace `createWorktree` made: follow its script to the end. */
  follow(wsPath: string, name: string, offscreen: boolean): void;
  /** No workspace came of it: stop listening. */
  cancel(): void;
}

/**
 * Follow a new workspace's setup script, which the server runs in a tab of
 * its own, until it reports the script done. When that tab is
 * not what the user is looking at — an agent tab took its place, or the
 * workspace was made in the background — a sticky toast stands in for
 * it meanwhile. Either way the end is a success toast.
 *
 * Listening starts before `projects.createWorktree` is sent, while the
 * workspace's path is not known yet: a short script can end before the
 * answer arrives, so an end heard early is kept for `follow`.
 */
function watchSetupScript(): SetupScriptWatch {
  let followed: { wsPath: string; toastId: string } | null = null;
  const endedEarly = new Map<string, SetupProgressEvent>();

  const finish = (event: SetupProgressEvent, toastId: string) => {
    unsubscribe();
    toast.dismiss(toastId);
    if (event.status === "done") {
      toast.success("Workspace setup complete", { id: `workspace-setup-${Date.now()}` });
    } else {
      toast.error("Workspace setup script failed", {
        id: `workspace-setup-${Date.now()}`,
        detail: event.message,
      });
    }
  };

  const unsubscribe = window.electronAPI.projects.onWorktreeSetupProgress(
    (event: SetupProgressEvent) => {
      if (event.step !== "setup-script" || !event.workspacePath) return;
      if (event.status !== "done" && event.status !== "error") return;
      if (!followed) endedEarly.set(event.workspacePath, event);
      else if (event.workspacePath === followed.wsPath) finish(event, followed.toastId);
    },
  );

  return {
    follow(wsPath, name, offscreen) {
      const toastId = `worktree-setup-${wsPath}`;
      followed = { wsPath, toastId };
      const ended = endedEarly.get(wsPath);
      if (ended) {
        finish(ended, toastId);
        return;
      }
      if (offscreen) {
        toast.progress(`Setting up "${name}"…`, { id: toastId, duration: "sticky" });
      }
    },
    cancel: () => unsubscribe(),
  };
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
    reviewersEqual(a.reviewers, b.reviewers) &&
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

function reviewersEqual(a?: PrReviewer[], b?: PrReviewer[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((r, i) => r.name === b[i].name && r.state === b[i].state);
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
  /** Enclosing folder, or null at the top level. */
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

/** Everything about a new worktree beyond its project and name. */
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
  /** The host this project's paths, git and terminals live on; `"local"` for this machine. */
  hostId: string;
  folders: WorkspaceFolder[];
  /**
   * Normalized, depth-first order of workspace paths and folder ids — the
   * canonical shape of what the sidebar renders.
   */
  sidebarOrder: string[];
  /**
   * The linked-project group this project is in. Absent or null
   * when it isn't linked; every member carries the same summary.
   */
  group?: ProjectGroupInfo | null;
}

/** Mirrors `ProjectGroupInfo` in `electron/projects/types.ts`. */
export interface ProjectGroupInfo {
  id: string;
  name: string;
  /** Member project ids, in the order their host sections render. */
  memberIds: string[];
  lastUsedHostId: string | null;
}

/** The optional parts of `createWorktree`, named so callers skip what they don't use. */
export interface CreateWorktreeOptions {
  /** The branch to create or check out; one named after the workspace when omitted. */
  branch?: string;
  /** Run in the new workspace once it (and any setup script) is ready. */
  agentCommand?: string;
  /**
   * Start the project's agent with this as its first message, once the
   * workspace is ready. Ignored when `agentCommand` is given.
   */
  agentPrompt?: string;
  /** Called with the pane id of the agent tab opened for `agentPrompt`. */
  onAgentPane?: (paneId: string) => void;
  linkedIssue?: LinkedIssue;
  /** What a new branch starts from; the default branch when omitted. */
  baseBranch?: string;
  /** Check out `branch` as it is instead of creating it. */
  useExistingBranch?: boolean;
  /** Sidebar folder to file it under; loose when omitted. */
  folderId?: string | null;
  /**
   * Create it without switching to it: the user stays where they are (the
   * Tasks view) and the agent tab opens in the new workspace behind them.
   */
  background?: boolean;
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
  /**
   * The workspace the step is for. Set on the `setup-script` step, which the
   * server reports after `createWorktree` has answered.
   */
  workspacePath?: string;
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

/** Mirrors `GroupUpdatableFields` in `electron/projects/types.ts`. */
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

/** What `projects.openInNewHost` takes; `repoUrl` may be left to the origin. */
export type NewHostRequest = Omit<
  Parameters<Window["electronAPI"]["projects"]["openInNewHost"]>[0],
  "repoUrl"
> & { repoUrl?: string };
export type NewHostResult = Awaited<
  ReturnType<Window["electronAPI"]["projects"]["openInNewHost"]>
>;
export type NewHostFailure = Extract<NewHostResult, { ok: false }>;

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
  /**
   * Why the first `loadProjects` failed, until one succeeds.
   * With no projects loaded, `App` shows a retry screen — never onboarding.
   */
  loadError: string | null;
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
  /** Clone a repo onto any host, then add it. */
  cloneProject: (opts: {
    hostId: string;
    repoUrl: string;
    targetDir: string;
    name: string;
  }) => Promise<ProjectInfo>;
  /** Clone an existing project onto a remote host, keeping its record. */
  moveProjectToHost: (
    projectId: string,
    opts: { hostId: string; repoUrl: string; remoteDir: string },
  ) => Promise<ProjectInfo>;
  /** The transfer fallback dialog's state; null while closed. */
  transferDialog: TransferDialogState | null;
  openTransferDialog: (state: TransferDialogState) => void;
  closeTransferDialog: () => void;
  /**
   * Copy (a new project linked to this one) or move (re-point this
   * one) `projectId` to `hostId` in one go, with a progress toast. Main picks
   * the target directory; `overrides` (both fields) replace its plan. When
   * main needs input, or the transfer throws, `transferDialog` is set
   * instead and the toast says why.
   */
  transferProject: (
    projectId: string,
    hostId: string,
    mode: TransferMode,
    overrides?: { repoUrl: string; targetDir: string },
  ) => Promise<void>;
  /**
   * "In a new pod". Makes a host from `profileId` and clones
   * `repoUrl` onto it, or, with `sourceProjectId`, sets that project up there
   * (its origin is the repo). Like `transferProject` it reports through a
   * toast: loading, then a success, the `needsInput` fallback dialog, or an
   * error that keeps the pod and offers Retry and "Delete the pod". Resolves
   * with the project on success.
   */
  openInNewHost: (request: NewHostRequest) => Promise<ProjectInfo | null>;
  /**
   * `openInNewHost` without toasts, for a caller with its own progress view
   * (Add Project). A success is loaded into the list and selected.
   */
  runOpenInNewHost: (request: NewHostRequest) => Promise<NewHostResult>;
  /** The failure toast of `openInNewHost` for a `{ok: false}` result. */
  reportNewHostFailure: (request: NewHostRequest, failure: NewHostFailure) => void;
  /** The typed "Delete the pod" confirm, for the pod `hostId`. */
  deletePodDialog: { hostId: string } | null;
  openDeletePod: (hostId: string) => void;
  closeDeletePod: () => void;
  /**
   * Switch a project to a host without cloning — to `path`, or the
   * path it last had there.
   */
  switchProjectHost: (
    projectId: string,
    hostId: string,
    path?: string,
  ) => Promise<ProjectInfo>;
  removeProject: (projectId: string) => Promise<void>;
  /**
   * The "Remove from <host>" confirm, for the member `projectId`.
   * Opened by the set-up success toast's action; the dialog itself is
   * rendered elsewhere. Named apart from the `removeFromHost` action.
   */
  removeFromHostDialog: { projectId: string } | null;
  openRemoveFromHost: (projectId: string) => void;
  closeRemoveFromHost: () => void;
  /**
   * Set `projectId` up on `hostId` (a copy transfer: clone or adopt
   * there, then join). The success toast offers "Remove from <this host>".
   * With `newHost` — the fallback dialog for an "In a new pod" that needed
   * input — a set up on that pod finishes through `openInNewHost`'s
   * `retryFrom`, so main marks the pod as the project's.
   */
  setUpOnHost: (
    projectId: string,
    hostId: string,
    overrides?: { repoUrl: string; targetDir: string },
    newHost?: NewHostPod,
  ) => Promise<void>;
  /**
   * Remove the member `memberId` from its host, leaving the rest
   * of its group (`removeProject` on the member), with a "Removed <name>
   * from <host>" toast. Files on the host are not deleted.
   */
  removeFromHost: (memberId: string) => Promise<boolean>;
  /**
   * "Keep separate…": split `projectId`'s group and remember the
   * pairs, so they are not joined again.
   */
  keepSeparate: (projectId: string) => Promise<void>;
  selectProject: (index: number) => void;
  selectWorkspace: (projectId: string, workspaceIndex: number) => void;
  createWorktree: (
    projectId: string,
    name: string,
    opts?: CreateWorktreeOptions,
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
     * every key — one row from a row's menu, a whole selection.
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
   * Set a group's shared settings, shown on every member
   * at once. Errors roll the change back, are shown as a toast, and reject.
   */
  updateGroup: (
    groupId: string,
    updates: GroupUpdatableFields,
  ) => Promise<void>;
  /**
   * Remember the host a group last made a workspace on, where the
   * New Workspace host picker starts next time. Workspace creates record it
   * in main; a failure only loses the default, so it is quiet.
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
 * After a host switch the project's workspaces live at new paths
 * on the new host; the old ones — the previous checkout and its worktrees —
 * are no longer part of it. Select the new main workspace if the window was
 * showing one of them, then close their tabs, killing their terminals, so
 * nothing is left running against a workspace that is gone. A workspace
 * whose path the new host has too keeps its tabs, moved to its key on the
 * new host, as main moves its saved layout.
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

/**
 * An error toast for a failed link or unlink. Through `toast.error`'s
 * `error`, so a rethrow isn't toasted again.
 */
function groupErrorToast(id: string, message: string, err: unknown): void {
  toast.error(message, { id, error: err });
}

/**
 * Drop a group's collapsed key once no project belongs to it any more, so a
 * dissolved group's id doesn't linger in `collapsedProjectIds`.
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

/** What auto-join needs of this store. */
function autoJoinDeps(): AutoJoinDeps {
  return {
    getProjects: () => useProjectStore.getState().projects,
    reload: () => useProjectStore.getState().loadProjects(),
  };
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
  loadError: null,
  collapsedProjectIds: loadCollapsedIds(),
  collapsedFolderKeys: loadCollapsedFolderKeys(),

  loadProjects: async () => {
    set({ loading: true });
    try {
      // Together, not one after the other: over the relay each is a round
      // trip, and the first paint waits on both.
      const [projects, selectedIndex] = await Promise.all([
        window.electronAPI.projects.getAll(),
        window.electronAPI.projects.getSelectedIndex(),
      ]);
      const firstLoad = !get().initialLoadDone;
      set((s) => ({
        projects: reconcile(projects, s.projects),
        selectedProjectIndex: selectedIndex,
        loading: false,
        initialLoadDone: true,
        loadError: null,
      }));
      // Join existing same-origin duplicates, now and as each
      // remote host first connects.
      if (firstLoad) void startAutoJoin(autoJoinDeps());
    } catch (err) {
      console.error("[projects] failed to load:", err);
      // A failed first load is not an empty list: `initialLoadDone` stays
      // false and `loadError` says why. A later re-read that fails keeps the
      // projects it already has.
      set((s) => ({
        loading: false,
        loadError: s.initialLoadDone ? s.loadError : ipcErrorMessage(err),
      }));
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
    void runAutoJoin(autoJoinDeps());
    return project;
  },

  addProjectFromDirectory: async () => {
    const selected = await pickDirectory();
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
    void runAutoJoin(autoJoinDeps());
    return project;
  },

  transferDialog: null,
  openTransferDialog: (state) => set({ transferDialog: state }),
  closeTransferDialog: () => set({ transferDialog: null }),

  transferProject: async (projectId, hostId, mode, overrides) => {
    const source = get().projects.find((p) => p.id === projectId);
    if (!source) return;
    const toastId = `transfer-${projectId}`;
    // Main's "copy" is the dialog's "setUp".
    const dialogMode = mode === "copy" ? "setUp" : "move";
    const hostName = memberDisplayName(hostId, useHostStore.getState().hosts);
    const transferring = toast.progress(
      `${mode === "copy" ? "Copying" : "Moving"} ${source.name} to ${hostName}…`,
      { id: toastId, duration: "sticky" },
    );
    const unsubscribe = window.electronAPI.projects.onCloneProgress((event) => {
      if (event.status !== "error" && event.message) {
        transferring.update({ detail: event.message });
      }
    });
    let result;
    try {
      result = await window.electronAPI.projects.transfer({
        projectId,
        hostId,
        mode,
        ...overrides,
      });
    } catch (err) {
      const error = ipcErrorMessage(err);
      toast.error(`Couldn't ${mode === "copy" ? "copy" : "move"} ${source.name} to ${hostName}`, {
        id: toastId,
        detail: error,
        action: {
          label: "Choose location…",
          onClick: () => {
            toast.dismiss(toastId);
            get().openTransferDialog({
              projectId,
              hostId,
              mode: dialogMode,
              reason: "failed",
              repoUrl: overrides?.repoUrl ?? null,
              targetDir: overrides?.targetDir ?? "",
              error,
            });
          },
        },
      });
      return;
    } finally {
      unsubscribe();
    }

    if (!result.ok) {
      const { needsInput } = result;
      transferring.dismiss();
      get().openTransferDialog({
        projectId,
        hostId,
        mode: dialogMode,
        reason: needsInput.reason,
        repoUrl: needsInput.repoUrl,
        targetDir: needsInput.targetDir,
      });
      return;
    }

    const transferred: ProjectInfo = result.project;
    toast.success(
      mode === "copy" ? `${source.name} is set up on ${hostName}` : `${source.name} is on ${hostName}`,
      {
        id: toastId,
        // A move is a set up, then this. Long enough to reach the
        // action; the default 3s dismiss hid it before it could be clicked.
        ...(mode === "copy" && {
          duration: 15_000,
          action: {
            label: `Remove from ${memberDisplayName(source.hostId, useHostStore.getState().hosts)}`,
            onClick: () => {
              toast.dismiss(toastId);
              get().openRemoveFromHost(projectId);
            },
          },
        }),
      },
    );
    await get().loadProjects();
    if (mode === "move") {
      closeWorkspacesLeftBehind(source, transferred, get().selectWorkspace);
    }

    if (isRemoteHost(hostId)) {
      // In the background: the transfer is done, this only flags a host
      // that can't run the project's tools yet.
      void window.electronAPI.hosts
        .healthCheck(hostId, transferred.path)
        .then((checks) => {
          const failed = checks.filter((c) => c.status === "fail");
          if (failed.length === 0) return;
          toast.error(
            `${source.name} on ${hostName}: ${failed.map((c) => c.label).join(", ")} failed`,
            {
              id: `transfer-health-${transferred.id}`,
              detail: failed
                .map((c) => (c.fixCommand ? `${c.detail} Fix: ${c.fixCommand}` : c.detail))
                .join("\n"),
              duration: "sticky",
              action: {
                label: "Open settings",
                onClick: () =>
                  requestUi({
                    type: "open-project-settings",
                    projectId: transferred.id,
                    section: "project-host",
                  }),
              },
            },
          );
        })
        .catch(() => {
          // The check itself failed to run; the host section shows its state.
        });
    }
  },

  openInNewHost: async (request) => {
    const toastId = `new-host-${request.sourceProjectId ?? request.profileId}`;
    const profile = useHostProfileStore
      .getState()
      .profiles.find((p) => p.id === request.profileId);
    const podName = profile ? `${profile.name} pod` : "pod";
    const starting = toast.progress(`Starting ${podName}…`, { id: toastId, duration: "sticky" });
    const unsubscribe = window.electronAPI.projects.onCloneProgress((event) => {
      if (event.status !== "error" && event.message) {
        starting.update({ detail: event.message });
      }
    });
    let result: NewHostResult;
    try {
      result = await get().runOpenInNewHost(request);
    } catch (err) {
      starting.dismiss();
      toast.error(`Couldn't start ${podName}`, { id: toastId, error: err });
      return null;
    } finally {
      unsubscribe();
    }
    starting.dismiss();
    if (!result.ok) {
      get().reportNewHostFailure(request, result);
      return null;
    }
    toast.success(`${result.project.name} is set up in ${podName}`, { id: toastId });
    return result.project;
  },

  runOpenInNewHost: async (request) => {
    let repoUrl = request.repoUrl?.trim() ?? "";
    if (!repoUrl && request.sourceProjectId) {
      repoUrl = (await window.electronAPI.projects.getOriginUrl(request.sourceProjectId)) ?? "";
      if (!repoUrl) {
        throw new Error("This project has no origin remote, so there is nothing to clone.");
      }
    }
    const result = await window.electronAPI.projects.openInNewHost({ ...request, repoUrl });
    if (result.ok) {
      await get().loadProjects();
      const index = get().projects.findIndex((p) => p.id === result.project.id);
      if (index >= 0 && !request.sourceProjectId) set({ selectedProjectIndex: index });
    }
    return result;
  },

  reportNewHostFailure: (request, failure) => {
    const toastId = `new-host-${request.sourceProjectId ?? request.profileId}`;
    const { hostId, stage, error, needsInput } = failure;
    if (needsInput && hostId && request.sourceProjectId) {
      // The copy needs an answer: the fallback dialog asks, and finishes
      // through `openInNewHost` again, so the pod is marked.
      toast.dismiss(toastId);
      get().openTransferDialog({
        projectId: request.sourceProjectId,
        hostId,
        mode: "setUp",
        reason: needsInput.reason,
        repoUrl: needsInput.repoUrl,
        targetDir: needsInput.targetDir,
        newHost: { hostId, profileId: request.profileId },
      });
      return;
    }
    toast.error(stage === "up" ? "The pod didn't start" : "The pod started, but the clone failed", {
      id: toastId,
      detail: error,
      duration: "sticky",
      action: {
        label: "Retry",
        onClick: () => {
          toast.dismiss(toastId);
          // A clone retry keeps the fallback dialog's answer, if it had one.
          const overrides = stage === "clone" ? request.retryFrom?.overrides : undefined;
          void get().openInNewHost({
            ...request,
            ...(hostId ? { retryFrom: { hostId, stage, ...(overrides && { overrides }) } } : {}),
          });
        },
      },
      ...(hostId && {
        secondaryAction: {
          label: "Delete the pod",
          onClick: () => {
            toast.dismiss(toastId);
            get().openDeletePod(hostId);
          },
        },
      }),
    });
  },

  deletePodDialog: null,
  openDeletePod: (hostId) => set({ deletePodDialog: { hostId } }),
  closeDeletePod: () => set({ deletePodDialog: null }),

  setUpOnHost: async (projectId, hostId, overrides, newHost) => {
    if (newHost && newHost.hostId === hostId && overrides) {
      await get().openInNewHost({
        profileId: newHost.profileId,
        sourceProjectId: projectId,
        repoUrl: overrides.repoUrl,
        retryFrom: { hostId, stage: "clone", overrides },
      });
      return;
    }
    await get().transferProject(projectId, hostId, "copy", overrides);
  },

  removeFromHostDialog: null,
  openRemoveFromHost: (projectId) => set({ removeFromHostDialog: { projectId } }),
  closeRemoveFromHost: () => set({ removeFromHostDialog: null }),

  removeFromHost: async (memberId) => {
    const member = get().projects.find((p) => p.id === memberId);
    if (!member) return false;
    const hostName = memberDisplayName(member.hostId, useHostStore.getState().hosts);
    try {
      await get().removeProject(memberId);
    } catch (err) {
      // `removeProject` toasted already; this one names the host instead.
      toast.dismiss(`remove-project-${memberId}`);
      groupErrorToast(
        `remove-from-host-${memberId}`,
        `Couldn't remove ${member.name} from ${hostName}`,
        err,
      );
      return false;
    }
    toast.success(`Removed ${member.name} from ${hostName}`, {
      id: `remove-from-host-${memberId}`,
    });
    return true;
  },

  keepSeparate: async (projectId) => {
    const groupId = get().projects.find((p) => p.id === projectId)?.group?.id;
    try {
      await window.electronAPI.projects.keepSeparate(projectId);
    } catch (err) {
      groupErrorToast(`keep-separate-${projectId}`, "Couldn't keep projects separate", err);
      return;
    }
    await get().loadProjects();
    forgetDissolvedGroup(groupId);
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
    const project = get().projects.find((p) => p.id === projectId);
    const groupId = project?.group?.id;
    try {
      await window.electronAPI.projects.remove(projectId);
    } catch (err) {
      toast.error(`Couldn't remove ${project?.name ?? "project"}`, {
        id: `remove-project-${projectId}`,
        error: err,
      });
      throw err;
    }
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
    opts: CreateWorktreeOptions = {},
  ) => {
    const {
      branch,
      agentPrompt,
      onAgentPane,
      linkedIssue,
      baseBranch,
      useExistingBranch,
      folderId,
      background,
    } = opts;
    const project = get().projects.find((p) => p.id === projectId);
    // The prompt is not baked into the line: it rides beside the bare command
    // and the server delivers it through a file on the pane's host.
    // An explicit `opts.agentCommand` already carries whatever it needs.
    const prompt = agentPrompt?.trim() ? agentPrompt : undefined;
    const agentCommand =
      opts.agentCommand ??
      (prompt
        ? (project?.agentCommand ?? DEFAULT_AGENT_COMMAND)
        : undefined);
    const launchPrompt = opts.agentCommand ? undefined : prompt;
    const startScript = project?.worktreeStartScript ?? null;

    // Init setup state before IPC call. The setup script is not one of its
    // steps: the server starts it in a tab of its own.
    useAppStore.getState().initWorktreeSetup("__pending__");
    const setupWatch = startScript ? watchSetupScript() : null;

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
        { branch, linkedIssue, baseBranch, useExistingBranch, folderId },
      );
    } catch (err) {
      unsubProgress();
      setupWatch?.cancel();
      useAppStore.getState().clearWorktreeSetup("__pending__");
      const detail = ipcErrorMessage(err);
      toast.error("Failed to create workspace", { id: `worktree-error-${Date.now()}`, detail });
      return null;
    }

    unsubProgress();

    if (!updated) {
      setupWatch?.cancel();
      useAppStore.getState().clearWorktreeSetup("__pending__");
      return null;
    }

    set((s) => ({
      projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
    }));

    // Main records the group's last-used host itself; its
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

      // Select the new workspace and switch to it, unless it's made in the background
      if (!background) {
        const newIdx = updated.workspaces.findIndex((ws) => ws.path === wsPath);
        if (newIdx >= 0) get().selectWorkspace(projectId, newIdx);
      }
      const key = workspaceKey(updated.hostId, wsPath);
      const addAgentTab = (command: string) => {
        const opened = background
          ? useAppStore.getState().addTerminalTabIn(key, command, {
              kind: "agent-startup",
              prompt: launchPrompt,
            })
          : useAppStore.getState().addTerminalTab(command, {
              kind: "agent-startup",
              prompt: launchPrompt,
            });
        if (opened && prompt) onAgentPane?.(opened.paneId);
      };

      // Mark switch as done
      useAppStore.getState().updateWorktreeSetupStep(wsPath, "switch", "done");
      useAppStore.getState().clearWorktreeSetup(wsPath);

      // The setup script is already running on the server, in a "Setup" tab
      // the server opened before answering. The agent doesn't
      // wait for it: both run in parallel, and the server types the launch
      // line into the agent's tab.
      setupWatch?.follow(wsPath, name, !!agentCommand || !!background);
      if (agentCommand) addAgentTab(agentCommand);
    } else {
      setupWatch?.cancel();
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
      toast.error("Failed to convert to workspace", { id: `convert-error-${Date.now()}`, detail });
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
      // Rethrown, as `updateProject` does, so an awaiting caller (the setup
      // wizard) knows it failed; the toast marked it reported.
      throw err;
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

    // Folder nesting is the other half of the structure. The map is
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
    try {
      await window.electronAPI.projects.renameWorkspace(
        projectId,
        workspacePath,
        newName,
      );
    } catch (err) {
      toast.error("Couldn't rename workspace", {
        id: `rename-workspace-${workspacePath}`,
        error: err,
      });
      throw err;
    }
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
    try {
      await window.electronAPI.projects.setWorkspaceHidden(
        projectId,
        workspacePath,
        hidden,
      );
    } catch (err) {
      toast.error(hidden ? "Couldn't hide workspace" : "Couldn't unhide workspace", {
        id: `hide-workspace-${workspacePath}`,
        error: err,
      });
      throw err;
    }
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
    let folder;
    try {
      folder = await window.electronAPI.projects.createWorkspaceFolder(
        projectId,
        name,
        parentId ?? null,
      );
    } catch (err) {
      toast.error(`Couldn't create folder "${name}"`, {
        id: `create-folder-${projectId}`,
        error: err,
      });
      throw err;
    }
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
      // A grouped project's shared settings are its group's, so
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
      // Every settings field saves through here, mostly fire-and-forget:
      // say why it snapped back.
      toast.error("Couldn't save project settings — your change was undone", {
        id: `update-project-${projectId}`,
        error: err,
      });
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
      // A linked project is only visible once its group is open too.
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

// Which host a project is on, for the bridge router.
provideHostLookups({
  project: (projectId) =>
    useProjectStore.getState().projects.find((p) => p.id === projectId)?.hostId,
});

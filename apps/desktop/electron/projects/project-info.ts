/**
 * Building what the renderer sees of a project, and the commands a new
 * project starts with.
 */

import crypto from "node:crypto";
import type { GitBackend, MachineFacts } from "../backend/types";
import { errorMessage } from "../lib/errors";
import type { PathRouter } from "./path-router";
import { resolveShared, summarizeGroup } from "./project-groups";
import { normalizeSidebarOrder } from "./workspace-folders";
import type {
  CustomCommand,
  LinkedIssue,
  PersistedProject,
  PersistedProjectGroup,
  ProjectInfo,
  WorkspaceFolder,
  WorkspaceInfo,
} from "./types";

/** The worktrees git lists for `projectPath`, or null when it lists none. */
export async function listGitWorkspaces(
  git: GitBackend,
  projectPath: string,
): Promise<WorkspaceInfo[] | null> {
  try {
    const worktrees = await git.worktreeList(projectPath);
    if (worktrees.length === 0) return null;

    return worktrees.map((wt) => ({
      path: wt.path,
      branch: wt.branch,
      isMain: wt.isMain,
      name: null,
    }));
  } catch {
    return null;
  }
}

/** How each package manager runs a `package.json` script. */
const SCRIPT_RUNNERS = {
  bun: "bun run",
  pnpm: "pnpm run",
  yarn: "yarn",
  npm: "npm run",
} as const;

type PackageManager = keyof typeof SCRIPT_RUNNERS;

/** Each package manager's lockfiles, in the order they're looked for. */
const LOCKFILES: ReadonlyArray<[PackageManager, string]> = [
  ["bun", "bun.lock"],
  ["bun", "bun.lockb"],
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["npm", "package-lock.json"],
];

/**
 * The package manager a project uses: the one `package.json`'s
 * `packageManager` field names (`"bun@1.2.0"` → bun), else the one whose
 * lockfile is present, else npm.
 */
async function detectPackageManager(
  facts: MachineFacts,
  projectPath: string,
  packageJson: { packageManager?: unknown },
): Promise<PackageManager> {
  if (typeof packageJson.packageManager === "string") {
    const name = packageJson.packageManager.split("@")[0];
    if (name in SCRIPT_RUNNERS) return name as PackageManager;
  }
  for (const [manager, lockfile] of LOCKFILES) {
    if (await facts.exists(facts.join(projectPath, lockfile))) return manager;
  }
  return "npm";
}

/**
 * One command per `package.json` script at `projectPath`, run with the
 * package manager its `packageManager` field or lockfile names (see
 * `detectPackageManager`); empty when there is no `package.json`. Read
 * through the project's host, which for a remote project is
 * not this filesystem.
 */
export async function seedCommands(
  facts: MachineFacts,
  projectPath: string,
): Promise<CustomCommand[]> {
  const text = await facts
    .readFile(facts.join(projectPath, "package.json"))
    .catch(() => null);
  if (text === null) return [];
  try {
    const packageJson: unknown = JSON.parse(text);
    if (!packageJson || typeof packageJson !== "object") return [];
    const { scripts } = packageJson as { scripts?: unknown };
    if (!scripts || typeof scripts !== "object") return [];
    const runner =
      SCRIPT_RUNNERS[
        await detectPackageManager(facts, projectPath, packageJson)
      ];
    return Object.keys(scripts).map((scriptName) => ({
      id: crypto.randomUUID(),
      name: scriptName,
      command: `${runner} ${scriptName}`,
    }));
  } catch (err) {
    console.error(
      "[ProjectManager] failed to read package.json:",
      errorMessage(err),
    );
    return [];
  }
}

/** The workspaces to show for `p`: what git lists now, else the main checkout alone. */
async function currentWorkspaces(p: PersistedProject, git: GitBackend): Promise<WorkspaceInfo[]> {
  return (
    (await listGitWorkspaces(git, p.path)) ?? [
      { path: p.path, branch: p.defaultBranch, isMain: true, name: null },
    ]
  );
}

/**
 * The renderer's view of `p`: its persisted settings over the workspaces
 * git lists now. Records those workspace paths with `paths`, which routes
 * by them. `group` is the project's linked-project group, whose
 * shared settings (name, color, agent command, Linear, theme, commands) win
 * over the project's own.
 */
export async function buildProjectInfo(
  p: PersistedProject,
  git: GitBackend,
  paths: Pick<PathRouter, "setWorkspacePaths">,
  group?: PersistedProjectGroup,
): Promise<ProjectInfo> {
  const rawWorkspaces = await currentWorkspaces(p, git);
  const rawWorkspacePaths = rawWorkspaces.map((ws) => ws.path);
  paths.setWorkspacePaths(p.id, rawWorkspacePaths);
  // Apply persisted ordering
  const order = p.workspaceOrder;
  if (order && order.length > 0) {
    const orderMap = new Map(order.map((path, i) => [path, i]));
    rawWorkspaces.sort((a, b) => {
      const ai = orderMap.get(a.path) ?? Infinity;
      const bi = orderMap.get(b.path) ?? Infinity;
      return ai - bi;
    });
  }
  const names = p.workspaceNames ?? {};
  const issues = p.workspaceIssues ?? {};
  const hiddenMap = p.workspaceHidden ?? {};
  const persistedFolders = p.workspaceFolders ?? [];
  const folderIds = p.workspaceFolderIds ?? {};
  const folderIdSet = new Set(persistedFolders.map((f) => f.id));
  // A parent absent (an older file), deleted, or pointing at the folder
  // itself reads as "top level" — the renderer never sees undefined.
  const folders: WorkspaceFolder[] = persistedFolders.map((f) => ({
    ...f,
    parentId:
      f.parentId != null && f.parentId !== f.id && folderIdSet.has(f.parentId)
        ? f.parentId
        : null,
  }));
  const workspaces = rawWorkspaces.map((ws) => {
    const mappedFolderId = folderIds[ws.path];
    return {
      ...ws,
      name: names[ws.path] ?? null,
      linkedIssues: issues[ws.path] ?? [],
      hidden: hiddenMap[ws.path] ?? false,
      folderId:
        mappedFolderId && folderIdSet.has(mappedFolderId)
          ? mappedFolderId
          : null,
    };
  });
  const shared = resolveShared(group, p);
  return {
    id: p.id,
    name: shared.name,
    path: p.path,
    defaultBranch: p.defaultBranch,
    workspaces,
    selectedWorkspaceIndex: p.selectedWorkspaceIndex,
    defaultRunCommand: p.defaultRunCommand,
    worktreePath: p.worktreePath ?? null,
    worktreeStartScript: p.worktreeStartScript ?? null,
    worktreeTeardownScript: p.worktreeTeardownScript ?? null,
    linearAssociations: shared.linearAssociations,
    color: shared.color,
    agentCommand: shared.agentCommand,
    commands: shared.commands,
    themeName: shared.themeName,
    setupComplete: p.setupComplete ?? true,
    portlessEnabled: p.portlessEnabled ?? true,
    hostId: p.hostId,
    folders,
    sidebarOrder: normalizeSidebarOrder(
      p.workspaceOrder,
      rawWorkspacePaths,
      folders.map((f) => f.id),
    ),
    group: group ? summarizeGroup(group) : null,
  };
}

/**
 * A remote host's project as this desktop shows it: what its
 * server holds, with the desktop's linked-project group over it. The host
 * knows nothing of groups: it holds its own resolved copy of the
 * shared settings, and the group's are written through to it, so the group
 * here only wins where a write has not landed yet.
 */
export function withGroup(
  info: ProjectInfo,
  group: PersistedProjectGroup | undefined,
): ProjectInfo {
  if (!group) return { ...info, group: null };
  return { ...info, ...resolveShared(group, info), group: summarizeGroup(group) };
}

/**
 * The record `projects.json` would hold for a project its host's server
 * holds, rebuilt from what that server answers: per-workspace
 * names, issues, hidden flags, folders and order come back out of its
 * workspaces. What the server never says — paths on other hosts — is absent.
 * For the desktop's own lookups (a group's members, a path's host) and for
 * taking a project back off its host to move it.
 */
export function persistedFromInfo(info: ProjectInfo): PersistedProject {
  const workspaceNames: Record<string, string> = {};
  const workspaceIssues: Record<string, LinkedIssue[]> = {};
  const workspaceHidden: Record<string, boolean> = {};
  const workspaceFolderIds: Record<string, string> = {};
  for (const ws of info.workspaces) {
    if (ws.name !== null) workspaceNames[ws.path] = ws.name;
    if (ws.linkedIssues && ws.linkedIssues.length > 0) {
      workspaceIssues[ws.path] = ws.linkedIssues.map((issue) => ({ ...issue }));
    }
    if (ws.hidden) workspaceHidden[ws.path] = true;
    if (ws.folderId) workspaceFolderIds[ws.path] = ws.folderId;
  }
  const nonEmpty = <T extends object>(record: T): T | undefined =>
    Object.keys(record).length > 0 ? record : undefined;
  const record: PersistedProject = {
    id: info.id,
    name: info.name,
    path: info.path,
    selectedWorkspaceIndex: info.selectedWorkspaceIndex,
    workspaces: [],
    defaultBranch: info.defaultBranch,
    defaultRunCommand: info.defaultRunCommand,
    worktreePath: info.worktreePath,
    worktreeStartScript: info.worktreeStartScript,
    worktreeTeardownScript: info.worktreeTeardownScript,
    linearAssociations: info.linearAssociations.map((a) => ({ ...a })),
    workspaceNames: nonEmpty(workspaceNames),
    workspaceOrder: info.sidebarOrder.length > 0 ? [...info.sidebarOrder] : undefined,
    workspaceIssues: nonEmpty(workspaceIssues),
    workspaceHidden: nonEmpty(workspaceHidden),
    workspaceFolders:
      info.folders.length > 0 ? info.folders.map((f) => ({ ...f })) : undefined,
    workspaceFolderIds: nonEmpty(workspaceFolderIds),
    color: info.color,
    agentCommand: info.agentCommand,
    commands: info.commands.map((c) => ({ ...c })),
    themeName: info.themeName,
    setupComplete: info.setupComplete,
    portlessEnabled: info.portlessEnabled,
    hostId: info.hostId,
  };
  // Absent rather than `undefined`, as a record read from disk would be.
  for (const key of Object.keys(record) as Array<keyof PersistedProject>) {
    if (record[key] === undefined) delete record[key];
  }
  return record;
}

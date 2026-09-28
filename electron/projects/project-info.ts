/**
 * Building what the renderer sees of a project, and the commands a new
 * project starts with (ADR-183 split this out of `ProjectManager`).
 */

import crypto from "node:crypto";
import { LOCAL_HOST_ID, type GitBackend, type MachineFacts } from "../backend/types";
import { errorMessage } from "../lib/errors";
import type { PathRouter } from "./path-router";
import { resolveShared, summarizeGroup } from "./project-groups";
import { normalizeSidebarOrder } from "./workspace-folders";
import type {
  CustomCommand,
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

/**
 * One command per `package.json` script at `projectPath`, run with the
 * package manager its lockfile names; empty when there is no
 * `package.json`. Read through the project's host (ADR-178 §3), which for
 * a remote project is not this filesystem.
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
    const scripts =
      packageJson && typeof packageJson === "object"
        ? (packageJson as { scripts?: unknown }).scripts
        : undefined;
    if (!scripts || typeof scripts !== "object") return [];
    const runner = (await facts.exists(facts.join(projectPath, "pnpm-lock.yaml")))
      ? "pnpm run"
      : (await facts.exists(facts.join(projectPath, "yarn.lock")))
        ? "yarn"
        : "npm run";
    return Object.keys(scripts).map((scriptName) => ({
      id: crypto.randomUUID(),
      name: scriptName,
      command: `${runner} ${scriptName}`,
    }));
  } catch (err) {
    console.error("[ProjectManager] failed to read package.json:", errorMessage(err));
    return [];
  }
}

/**
 * Each remote project's last successful workspace listing. While its host is
 * away git can't list anything; the project then keeps the workspaces it
 * last had rather than collapsing to its main checkout, so the sidebar still
 * shows what's there (ADR-192 §5). Keyed by the project and where it lives
 * (`lastKnownKey`), so a project moved to another host or path never shows
 * the old checkout's workspaces. In memory only: a host that is away from
 * launch on shows just the main checkout.
 */
export type LastKnownWorkspaces = Map<string, WorkspaceInfo[]>;

function lastKnownKey(p: PersistedProject): string {
  return JSON.stringify([p.id, p.hostId, p.path]);
}

/**
 * The workspaces to show for `p`: what git lists now, else — for a remote
 * project whose host can't answer — the last listing in `lastKnown`, else
 * the main checkout alone. A successful listing is remembered.
 */
async function currentWorkspaces(
  p: PersistedProject,
  git: GitBackend,
  lastKnown: LastKnownWorkspaces | undefined,
): Promise<WorkspaceInfo[]> {
  const listed = await listGitWorkspaces(git, p.path);
  const remote = !!p.hostId && p.hostId !== LOCAL_HOST_ID;
  const key = lastKnownKey(p);
  if (listed) {
    if (remote) lastKnown?.set(key, listed.map((ws) => ({ ...ws })));
    return listed;
  }
  const remembered = remote ? lastKnown?.get(key) : undefined;
  if (remembered) return remembered.map((ws) => ({ ...ws }));
  return [{ path: p.path, branch: p.defaultBranch, isMain: true, name: null }];
}

/**
 * The renderer's view of `p`: its persisted settings over the workspaces
 * git lists now. Records those workspace paths with `paths`, which routes
 * by them. `group` is the project's linked-project group (ADR-192), whose
 * shared settings (name, color, agent command, Linear) win over the
 * project's own. `lastKnown` stands in for the listing while a remote host
 * is away.
 */
export async function buildProjectInfo(
  p: PersistedProject,
  git: GitBackend,
  paths: PathRouter,
  group?: PersistedProjectGroup,
  lastKnown?: LastKnownWorkspaces,
): Promise<ProjectInfo> {
  const rawWorkspaces = await currentWorkspaces(p, git, lastKnown);
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
  // A parent absent (pre-ADR-172), deleted, or pointing at the folder
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
        mappedFolderId && folderIdSet.has(mappedFolderId) ? mappedFolderId : null,
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
    commands: p.commands ?? [],
    themeName: p.themeName ?? null,
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

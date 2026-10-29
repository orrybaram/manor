/**
 * The workspace lifecycle — create, create-from-issues, remove, quick-merge —
 * with every side effect each one owes: stats counters, the group's
 * last-used host, the `projects-changed` broadcast and the setup script.
 * Both transports call it: the IPC handlers (the UI) and the HTTP control
 * routes (the `manor` CLI and MCP), so a new side effect is added once
 * instead of remembered per adapter.
 *
 * The setup script runs on the server, in a tab of its own,
 * whoever asked for the workspace: there is no renderer to hand it to, and
 * none is needed. Its runner is injected so this module (and its tests)
 * spawns nothing.
 */

import type {
  IssueSeed,
  LinkedIssue,
  ProjectInfo,
  ProjectManager,
  WorkspaceFromIssue,
} from "./persistence";
import type { StatsStore } from "./stats-store";
import type { HostId } from "./backend/types";
import { branchesEqual } from "../src/utils/branch-name";

export interface WorkspaceOpsDeps {
  projectManager: Pick<
    ProjectManager,
    | "createWorktree"
    | "createWorkspacesFromIssues"
    | "removeWorktree"
    | "quickMergeWorktree"
    | "setGroupLastUsedHost"
  >;
  statsStore: Pick<StatsStore, "record">;
  /** The server's `projects.changed` broadcast. */
  notifyProjectsChanged: () => void;
  /**
   * Run a new workspace's setup script (`ServerLaunches.runSetupScript`),
   * telling `origin` how it goes. Resolves once its tab exists; never
   * rejects. `onEnd`, when given, hears once how the script ended.
   */
  runSetupScript: (
    workspacePath: string,
    script: string,
    hostId: HostId,
    origin: string | null,
    onEnd?: (end: SetupScriptEnd) => void,
  ) => Promise<void>;
  /**
   * Tell `origin` how a worktree removal is going: `projects.removeWorktreeProgress`
   * on the server's own bus, so a phone on a host server hears it too.
   * Omitted in tests that don't watch it.
   */
  publishRemoveProgress?: (origin: string | null, step: string) => void;
}

/**
 * How a setup script ended: its shell exited (null code: it was killed), it
 * never started, or it was still running when the wait gave up.
 */
export type SetupScriptEnd =
  | { status: "exited"; exitCode: number | null }
  | { status: "failed"; error: string }
  | { status: "timed-out" };

export interface CreateWorkspaceRequest {
  projectId: string;
  name: string;
  branch?: string;
  linkedIssue?: LinkedIssue;
  baseBranch?: string;
  useExistingBranch?: boolean;
  folderId?: string | null;
  /**
   * The bridge connection that asked, so its own window gets the setup
   * progress, the setup script's included; omitted or null
   * broadcasts it.
   */
  origin?: string | null;
  /**
   * False for a workspace the user didn't make by hand (an automation's
   * run): the group's last-used host — the New Workspace dialog's default —
   * stays as it was. True when omitted.
   */
  recordLastUsedHost?: boolean;
  /**
   * Wait for the setup script to end, up to `timeoutMs`, and say how in the
   * result's `setup`. Omitted, create resolves once the script's tab exists.
   */
  awaitSetup?: { timeoutMs: number };
}

export interface WorkspaceOps {
  /**
   * Create one workspace, and start its project's setup script in it.
   * `project` is the manager's updated project (null when the project was
   * not found); `workspacePath` is the created workspace's path, or null if
   * it could not be found in `project`.
   */
  create(req: CreateWorkspaceRequest): Promise<{
    project: ProjectInfo | null;
    workspacePath: string | null;
    /** How the setup script ended: only with `awaitSetup`, when one ran. */
    setup?: SetupScriptEnd;
  }>;
  /**
   * Create one workspace per issue in `project`. Takes the project itself,
   * not its id: the manager's results do not carry it, and the last-used
   * host needs its group. Setup scripts are not run for batch creates.
   */
  createFromIssues(
    project: ProjectInfo,
    seeds: IssueSeed[],
    baseBranch?: string,
  ): Promise<WorkspaceFromIssue[]>;
  remove(
    projectId: string,
    worktreePath: string,
    deleteBranch?: boolean,
    onProgress?: (step: string) => void,
  ): Promise<void>;
  /** Address one removal step to the connection that asked for the removal. */
  publishRemoveProgress(origin: string | null, step: string): void;
  quickMerge(projectId: string, worktreePath: string): Promise<void>;
}

/**
 * Remember `project`'s host as its group's last-used host, the way the New
 * Workspace dialog does, so the dialog's default follows CLI creates too.
 * An ungrouped project writes nothing; `setGroupLastUsedHost` itself skips
 * the host already recorded (checked there, not against a possibly stale
 * snapshot here). A failure only costs the picker its default, so it is logged, not thrown:
 * the workspace was made.
 */
function recordLastUsedHost(
  pm: Pick<ProjectManager, "setGroupLastUsedHost">,
  project: ProjectInfo,
): void {
  const group = project.group;
  if (!group) return;
  try {
    pm.setGroupLastUsedHost(group.id, project.hostId);
  } catch (err) {
    console.warn(
      `[projects] Could not record ${project.hostId} as group ${group.id}'s last-used host:`,
      err,
    );
  }
}

/** `ended`, or `timed-out` once `timeoutMs` passes first. */
function within(ended: Promise<SetupScriptEnd>, timeoutMs: number): Promise<SetupScriptEnd> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<SetupScriptEnd>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs);
  });
  return Promise.race([ended, timedOut]).finally(() => clearTimeout(timer));
}

export function createWorkspaceOps(deps: WorkspaceOpsDeps): WorkspaceOps {
  const { projectManager: pm, statsStore } = deps;

  return {
    async create(req) {
      const project = await pm.createWorktree(req.projectId, req.name, {
        branch: req.branch,
        linkedIssue: req.linkedIssue,
        baseBranch: req.baseBranch,
        useExistingBranch: req.useExistingBranch,
        folderId: req.folderId,
        origin: req.origin ?? null,
      });
      if (project) {
        statsStore.record("worktreesCreated");
        if (req.recordLastUsedHost !== false) recordLastUsedHost(pm, project);
      }
      deps.notifyProjectsChanged();

      // Same rule the renderer's `createWorktree` uses to find what it made.
      const branchName = req.branch || req.name;
      const created = project?.workspaces.find(
        (ws) =>
          !ws.isMain &&
          (ws.name === req.name || branchesEqual(ws.branch, branchName)),
      );
      const workspacePath = created?.path ?? null;

      if (project?.worktreeStartScript && workspacePath) {
        const args = [
          workspacePath,
          project.worktreeStartScript,
          project.hostId,
          req.origin ?? null,
        ] as const;
        if (req.awaitSetup) {
          let onEnd!: (end: SetupScriptEnd) => void;
          const ended = new Promise<SetupScriptEnd>((resolve) => (onEnd = resolve));
          await deps.runSetupScript(...args, onEnd);
          const setup = await within(ended, req.awaitSetup.timeoutMs);
          return { project, workspacePath, setup };
        }
        await deps.runSetupScript(...args);
      }
      return { project, workspacePath };
    },

    async createFromIssues(project, seeds, baseBranch) {
      const results = await pm.createWorkspacesFromIssues(project.id, seeds, baseBranch);
      const createdCount = results.filter((r) => !!r.worktreePath && !r.error).length;
      if (createdCount > 0) {
        statsStore.record("worktreesCreated", createdCount);
        recordLastUsedHost(pm, project);
      }
      deps.notifyProjectsChanged();
      return results;
    },

    async remove(projectId, worktreePath, deleteBranch, onProgress) {
      await pm.removeWorktree(projectId, worktreePath, deleteBranch, onProgress);
      statsStore.record("worktreesRemoved");
      deps.notifyProjectsChanged();
    },

    publishRemoveProgress(origin, step) {
      deps.publishRemoveProgress?.(origin, step);
    },

    async quickMerge(projectId, worktreePath) {
      await pm.quickMergeWorktree(projectId, worktreePath);
      statsStore.record("worktreesMerged");
      deps.notifyProjectsChanged();
    },
  };
}

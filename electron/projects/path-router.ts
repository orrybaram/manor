/**
 * Where a project's paths are, on its own host (ADR-183 split this out of
 * `ProjectManager`): which host a bare path belongs to, and where a
 * project's worktrees go. Every host answers through its `MachineFacts`,
 * so nothing here asks whether a host is this machine.
 */

import { LOCAL_HOST_ID, type MachineFacts } from "../backend/types";
import { errorMessage } from "../lib/errors";
import { toDirSlug } from "../branch-name";
import type { PersistedProject } from "./types";
import { ownerHostIdForPath, type WorkspaceKeyOwner } from "../../src/lib/workspace-key";

/**
 * The workspace paths `projects.json` remembers for `project` without asking
 * git: every key of its per-workspace settings and its sidebar order. The
 * order also holds folder ids, which no path lies within, so they are inert.
 */
function rememberedWorkspacePaths(project: PersistedProject): string[] {
  return [
    ...new Set([
      ...Object.keys(project.workspaceNames ?? {}),
      ...Object.keys(project.workspaceIssues ?? {}),
      ...Object.keys(project.workspaceHidden ?? {}),
      ...Object.keys(project.workspaceFolderIds ?? {}),
      ...(project.workspaceOrder ?? []),
    ]),
  ];
}

/** `promise`'s value, or `fallback` once `ms` pass or it rejects. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Expands a leading `~` in `p` against `home`, joining as that host does. */
export function expandHome(
  p: string,
  home: string,
  join: (...parts: string[]) => string,
): string {
  if (p.startsWith("~/") || p === "~") {
    return join(home, p.slice(1));
  }
  return p;
}

export class PathRouter {
  /**
   * Each host's home directory, once asked (ADR-178 §3), so `hostIdForPath`
   * can read it synchronously. A host not yet in here has its `~` roots
   * skipped there.
   */
  private homeDirs = new Map<string, string>();
  /** Each host's default worktree root per project name, once asked. */
  private defaultRoots = new Map<string, Map<string, string>>();
  /**
   * Workspace paths git last reported per project id. Worktrees may live
   * outside the project's worktree directory, so `hostIdForPath` needs them.
   */
  private workspacePaths = new Map<string, string[]>();

  constructor(
    private readonly projects: () => readonly PersistedProject[],
    private readonly factsFor: (hostId: string) => MachineFacts,
  ) {}

  /** Record the workspace paths git reported for a project. */
  setWorkspacePaths(projectId: string, paths: string[]): void {
    this.workspacePaths.set(projectId, paths);
  }

  /**
   * Forget a project's workspace paths — when it moves host, the old host's
   * paths would otherwise route to the new one until git is asked again.
   */
  forgetWorkspacePaths(projectId: string): void {
    this.workspacePaths.delete(projectId);
  }

  /**
   * Drop what is cached about `hostId`'s machine: the host may now be
   * reachable at a different address (or machine) with a different home.
   */
  forgetHost(hostId: string): void {
    this.homeDirs.delete(hostId);
    this.defaultRoots.delete(hostId);
  }

  /** `hostId`'s home directory, asked of its facts and cached. */
  async homeDir(hostId: string): Promise<string> {
    const home = await this.factsFor(hostId).homeDir();
    this.homeDirs.set(hostId, home);
    return home;
  }

  private async defaultRoot(project: PersistedProject): Promise<string> {
    const root = await this.factsFor(project.hostId).defaultWorktreeRoot(project.name);
    let byName = this.defaultRoots.get(project.hostId);
    if (!byName) {
      byName = new Map();
      this.defaultRoots.set(project.hostId, byName);
    }
    byName.set(project.name, root);
    return root;
  }

  /**
   * The one rule for a project's worktree root: its own root, with a
   * leading `~` expanded against its host's home, else its host's default.
   * Null when the input the rule needs is not known.
   */
  private baseDirFrom(
    project: PersistedProject,
    home: string | undefined,
    defaultRoot: string | undefined,
  ): string | null {
    const root = project.worktreePath;
    if (!root) return defaultRoot ?? null;
    if (!root.startsWith("~")) return root;
    if (home === undefined) return null;
    return expandHome(root, home, this.factsFor(project.hostId).join);
  }

  /**
   * The directory this project's worktrees are created in. Asks the
   * project's host only for what the root needs; for a remote project this
   * fails loudly if the host is unreachable rather than falling back to a
   * local path.
   */
  async worktreeBaseDir(project: PersistedProject): Promise<string> {
    const root = project.worktreePath;
    const home = root?.startsWith("~") ? await this.homeDir(project.hostId) : undefined;
    const fallback = root ? undefined : await this.defaultRoot(project);
    // Non-null: whichever input the root needs was just fetched.
    return this.baseDirFrom(project, home, fallback)!;
  }

  /**
   * The deterministic path a worktree named `name` would occupy in this
   * project. Single source of truth for `createWorktree` and callers that
   * need to know that path in advance.
   */
  async worktreePathFor(project: PersistedProject, name: string): Promise<string> {
    const base = await this.worktreeBaseDir(project);
    return this.factsFor(project.hostId).join(base, toDirSlug(name));
  }

  /** `worktreeBaseDir` from cached answers only, for `hostIdForPath`. */
  private knownWorktreeBaseDir(project: PersistedProject): string | null {
    return this.baseDirFrom(
      project,
      this.homeDirs.get(project.hostId),
      this.defaultRoots.get(project.hostId)?.get(project.name),
    );
  }

  /**
   * Best-effort: asks every host a project lives on for what
   * `hostIdForPath` needs, so it can route worktree roots. One log line per
   * host that cannot answer.
   */
  warm(): void {
    const byHost = new Map<string, PersistedProject[]>();
    for (const project of this.projects()) {
      const list = byHost.get(project.hostId) ?? [];
      list.push(project);
      byHost.set(project.hostId, list);
    }
    for (const [hostId, projects] of byHost) {
      this.homeDir(hostId)
        .then(() =>
          Promise.all(
            projects.filter((p) => !p.worktreePath).map((p) => this.defaultRoot(p)),
          ),
        )
        .catch((err: unknown) => {
          console.error(
            `[ProjectManager] failed to resolve home directory for ${hostId}:`,
            errorMessage(err),
          );
        });
    }
  }

  /**
   * Every project as a `WorkspaceKeyOwner`, for a one-time migration of
   * path-keyed data to workspace keys (ADR-191): its root, its worktree
   * directory expanded for its host, and every workspace path it is known to
   * have — remembered in `projects.json` and listed by `listWorkspaces`.
   *
   * Null when a remote project's worktree directory or listing is not known
   * within `timeoutMs`: an owner that is missing a path would send that
   * path's data to the wrong host for good, so the caller must retry later
   * instead. A local project that can't be listed (its checkout was deleted,
   * say) still counts: its paths already read as local.
   */
  async workspaceKeyOwners(
    timeoutMs: number,
    listWorkspaces: (project: PersistedProject) => Promise<string[]>,
  ): Promise<WorkspaceKeyOwner[] | null> {
    const described = await Promise.all(
      this.projects().map(async (project) => {
        const [worktreeRoot, listed] = await Promise.all([
          within<string | null>(this.worktreeBaseDir(project), timeoutMs, null),
          within<string[] | null>(listWorkspaces(project), timeoutMs, null),
        ]);
        const owner: WorkspaceKeyOwner = {
          hostId: project.hostId,
          path: project.path,
          worktreeRoot,
          workspaces: [
            ...new Set([
              ...rememberedWorkspacePaths(project),
              ...(this.workspacePaths.get(project.id) ?? []),
              ...(listed ?? []),
            ]),
          ].map((path) => ({ path })),
        };
        const complete =
          project.hostId === LOCAL_HOST_ID || (worktreeRoot !== null && listed !== null);
        return { owner, complete };
      }),
    );
    if (described.some((d) => !d.complete)) return null;
    return described.map((d) => d.owner);
  }

  /**
   * The host a filesystem path belongs to: the host of the project whose
   * root, worktree directory, or known workspace contains it most closely.
   * Paths outside every project — and every path, while no project lives on
   * a remote host — are local. When a local and a remote root match equally
   * closely, local wins.
   *
   * A worktree directory that needs its host's home or default root counts
   * only once that has been asked (see `warm`); until then it is skipped.
   */
  hostIdForPath(p: string): string {
    const projects = this.projects();
    if (!projects.some((pr) => pr.hostId !== LOCAL_HOST_ID)) {
      return LOCAL_HOST_ID;
    }
    return ownerHostIdForPath(
      projects.map((project) => ({
        hostId: project.hostId,
        path: project.path,
        worktreeRoot: this.knownWorktreeBaseDir(project),
        workspaces: (this.workspacePaths.get(project.id) ?? []).map((path) => ({ path })),
      })),
      p,
    );
  }
}

import { repoFromOrigin, type ProjectRepos } from "./github-source";

interface ScopeProject {
  id: string;
  linearAssociations: Array<{ teamId: string }>;
}

export interface ProjectScopeDeps {
  getProjects(): Promise<ScopeProject[]>;
  /** Null when it has no origin; throws when its host can't say. */
  readOriginUrl(projectId: string): Promise<string | null>;
}

/** Origins hardly ever change, and a remote project's costs a call to its host. */
const ORIGIN_MAX_AGE_MS = 10 * 60_000;

/**
 * Which GitHub repos and Linear teams belong to Manor projects.
 *
 * A project's last known repo is kept when its host can't be reached, so a
 * remote host going offline doesn't put its repo out of scope. One never known
 * (after a relaunch, say) makes the answer incomplete: see `InboxFetch.hold`.
 */
export class ProjectScope {
  private repoByProject = new Map<string, { repo: string; at: number }>();

  constructor(
    private readonly deps: ProjectScopeDeps,
    private readonly now: () => number = Date.now,
  ) {}

  async repos(): Promise<ProjectRepos> {
    const projects = await this.deps.getProjects();
    let complete = true;
    await Promise.all(
      projects.map(async ({ id }) => {
        const known = this.repoByProject.get(id);
        if (known && this.now() - known.at < ORIGIN_MAX_AGE_MS) return;
        try {
          const origin = await this.deps.readOriginUrl(id);
          const repo = origin ? repoFromOrigin(origin) : null;
          if (repo) this.repoByProject.set(id, { repo, at: this.now() });
          else this.repoByProject.delete(id);
        } catch {
          if (!known) complete = false;
        }
      }),
    );
    const repos = new Set<string>();
    for (const { id } of projects) {
      const known = this.repoByProject.get(id);
      if (known) repos.add(known.repo);
    }
    return { repos, complete };
  }

  /** The ids of the Linear teams linked to projects. */
  async teams(): Promise<Set<string>> {
    const projects = await this.deps.getProjects();
    return new Set(projects.flatMap((p) => p.linearAssociations.map((a) => a.teamId)));
  }
}

import { repoFromOrigin } from "./github-source";

interface ScopeProject {
  id: string;
  linearAssociations: Array<{ teamId: string }>;
}

export interface ProjectScopeDeps {
  getProjects(): Promise<ScopeProject[]>;
  getOriginUrl(projectId: string): Promise<string | null>;
}

/** Origins hardly ever change, and a remote project's costs a call to its host. */
const ORIGIN_MAX_AGE_MS = 10 * 60_000;

/**
 * Which GitHub repos and Linear teams belong to Manor projects.
 *
 * A project's last known repo is kept when its host can't be reached, so a
 * remote host going offline doesn't put its repo out of scope for a while.
 */
export class ProjectScope {
  private repoByProject = new Map<string, { repo: string; at: number }>();

  constructor(
    private readonly deps: ProjectScopeDeps,
    private readonly now: () => number = Date.now,
  ) {}

  /** Lowercase `owner/repo` of every project. */
  async repos(): Promise<Set<string>> {
    const projects = await this.deps.getProjects();
    await Promise.all(
      projects.map(async ({ id }) => {
        const known = this.repoByProject.get(id);
        if (known && this.now() - known.at < ORIGIN_MAX_AGE_MS) return;
        const origin = await this.deps.getOriginUrl(id).catch(() => null);
        const repo = origin ? repoFromOrigin(origin) : null;
        if (repo) this.repoByProject.set(id, { repo, at: this.now() });
      }),
    );
    const repos = new Set<string>();
    for (const { id } of projects) {
      const known = this.repoByProject.get(id);
      if (known) repos.add(known.repo);
    }
    return repos;
  }

  /** The ids of the Linear teams linked to projects. */
  async teams(): Promise<Set<string>> {
    const projects = await this.deps.getProjects();
    return new Set(projects.flatMap((p) => p.linearAssociations.map((a) => a.teamId)));
  }
}

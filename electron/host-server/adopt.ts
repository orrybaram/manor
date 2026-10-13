/**
 * Adoption (ADR-227 D3): the host server takes over the records the desktop
 * held for this host, over the owner channel (`hostServer.adopt`).
 *
 * The bundle is this host's projects (`ManifestProject`, group settings
 * resolved, `hostPaths` dropped), its agents and its part of the layout,
 * rekeyed to bare paths (`HostLayoutSnapshot`). The handler checks it whole
 * first (`./owner.ts` `assertAdoptionBundle`); then:
 *
 * 1. **Merge by id into the live stores**, the host winning every conflict:
 *    projects by id (workspace records per path, `projects/adopt-records.ts`),
 *    agents by id or agent session, layout per workspace path. Each store
 *    writes its file before the next is touched.
 * 2. **Ownership becomes `host` last**, so a crash part-way leaves it
 *    `pending` and the desktop sends the bundle again — which merges to the
 *    same result, since nothing it adds can overwrite.
 * 3. **Tell whoever is connected**: `layout.changed` for each workspace
 *    added (the store broadcasts those itself), `agents.updated` for each
 *    agent, and `projects.changed` once the projects are readable.
 *
 * Calls are run one at a time. Electron-free.
 */

import type { AgentInfo, AgentManager } from "../agent-persistence";
import type { LayoutStore } from "../layout/layout-store";
import type { ProjectManager } from "../projects/project-manager";
import type { HostLayoutSnapshot } from "./layout";
import type { ManifestProject } from "./manifest";
import type { OwnershipState } from "./ownership";

/** What the desktop hands over on adoption. */
export interface AdoptionBundle {
  projects: ManifestProject[];
  agents: AgentInfo[];
  layout: HostLayoutSnapshot;
}

export interface AdoptionDeps {
  projectManager: Pick<ProjectManager, "adoptProjects">;
  agentManager: Pick<AgentManager, "adoptAgents">;
  layoutStore: Pick<LayoutStore, "adopt">;
  ownership: Pick<OwnershipState, "set">;
  /** `projects.changed`, to every connection. */
  publishProjectsChanged(): void;
  /** `agents.updated` for one agent the host did not have. */
  publishAgent(agent: AgentInfo): void;
}

/** Adopt a checked bundle; resolves once ownership is `host`. */
export type Adopt = (bundle: AdoptionBundle) => Promise<void>;

export function createAdoption(deps: AdoptionDeps): Adopt {
  let tail: Promise<unknown> = Promise.resolve();

  async function adoptNow(bundle: AdoptionBundle): Promise<void> {
    deps.projectManager.adoptProjects(bundle.projects);
    const agents = deps.agentManager.adoptAgents(bundle.agents);
    await deps.layoutStore.adopt(
      bundle.layout.workspaces,
      bundle.layout.lastActiveWorkspacePath,
    );
    deps.ownership.set("host");
    deps.publishProjectsChanged();
    for (const agent of agents) deps.publishAgent(agent);
  }

  return (bundle) => {
    const run = tail.then(() => adoptNow(bundle));
    tail = run.catch(() => {});
    return run;
  };
}

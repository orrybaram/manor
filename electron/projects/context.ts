/**
 * What `ProjectManager` shares with the modules it composes (ADR-183): the
 * state, the per-host backends, and the lookups every operation starts from.
 */

import type { HostRecords } from "./host-records";
import type { PathRouter } from "./path-router";
import type { StateStore } from "./state-store";
import type { PersistedProject, ProjectHost, ProjectInfo } from "./types";

export interface ProjectContext {
  readonly store: StateStore;
  readonly hosts: HostRecords;
  readonly paths: PathRouter;
  /** The backend of `hostId`. */
  host(hostId: string): ProjectHost;
  find(projectId: string): PersistedProject | undefined;
  /** The project that lives at `dir` on `hostId`, if any. */
  findAt(hostId: string, dir: string): PersistedProject | undefined;
  /** The renderer's view of `project`, asking its host's git. */
  info(project: PersistedProject): Promise<ProjectInfo>;
}

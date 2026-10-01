/**
 * What `ProjectManager` shares with the modules it composes (ADR-183): the
 * state, the per-host backends, and the lookups every operation starts from.
 */

import type { HostRecords } from "./host-records";
import type { PathRouter } from "./path-router";
import type { StateStore } from "./state-store";
import type { PersistedProject, ProjectHost, ProjectInfo } from "./types";

/**
 * What removing a worktree or a project needs of `LayoutStore`: to forget a
 * workspace — its panes ended, every renderer told (ADR-182 D7).
 */
export interface WorkspaceLayoutOwner {
  remove(workspaceKey: string): void;
}

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
  /** The server's layout store, when there is one (tests may omit it). */
  readonly layout?: WorkspaceLayoutOwner;
}

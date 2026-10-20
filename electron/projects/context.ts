/**
 * What `ProjectManager` shares with the modules it composes: the
 * state, the per-host backends, and the lookups every operation starts from.
 */

import type { HostRecords } from "./host-records";
import type { ProjectProgress } from "./progress";
import type { PathRouter } from "./path-router";
import type { StateStore } from "./state-store";
import type { PersistedProject, ProjectHost, ProjectInfo, RemoteProjects } from "./types";
import type { LayoutEntry } from "../../src/lib/layout/protocol";

/**
 * What removing a worktree or a project needs of `LayoutStore`: to forget a
 * workspace — its panes ended, every renderer told. A project
 * moving off an adopted host also brings its layouts here (`take`) for the
 * move to carry on, and lets them go again (`release`) if it fails.
 */
export interface WorkspaceLayoutOwner {
  remove(workspaceKey: string): void;
  take?(entries: Readonly<Record<string, LayoutEntry>>): Promise<void>;
  release?(workspaceKeys: readonly string[]): Promise<void>;
}

export interface ProjectContext {
  readonly store: StateStore;
  readonly hosts: HostRecords;
  readonly paths: PathRouter;
  /** The backend of `hostId`. */
  host(hostId: string): ProjectHost;
  find(projectId: string): PersistedProject | undefined;
  /**
   * `find`, or a remote host's project as its server holds it,
   * rebuilt as a record: a copy, so writing to it changes nothing. For a
   * group's members, which may live on any host.
   */
  member(projectId: string): PersistedProject | undefined;
  /**
   * Every project, this desktop's and remote hosts' (as `member` builds
   * them), in the sidebar's order: what link suggestions look through.
   */
  all(): PersistedProject[];
  /** Remote hosts' projects, on the desktop; absent on a host server. */
  readonly remote?: RemoteProjects;
  /** The project that lives at `dir` on `hostId`, if any. */
  findAt(hostId: string, dir: string): PersistedProject | undefined;
  /** The renderer's view of `project`, asking its host's git. */
  info(project: PersistedProject): Promise<ProjectInfo>;
  /** Where setup and clone progress go. */
  readonly progress: ProjectProgress;
  /** The server's layout store, when there is one (tests may omit it). */
  readonly layout?: WorkspaceLayoutOwner;
}

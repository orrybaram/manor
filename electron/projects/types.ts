/**
 * The shapes `ProjectManager` hands out and the ones it persists in
 * `projects.json` (ADR-183 split them out of `persistence.ts`).
 */

import type { LinearAssociation, LinkedIssue } from "../linear";
import type {
  GitBackend,
  HostSpec,
  MachineFacts,
  ShellBackend,
} from "../backend/types";

export type { LinkedIssue };

export interface CustomCommand {
  id: string;
  name: string;
  command: string;
}

export interface WorkspaceFolder {
  id: string;
  name: string;
  /** Enclosing folder, or null at the top level. */
  parentId: string | null;
}

/**
 * The part of a folder the parent walk needs. Folders persisted before
 * ADR-172 have no `parentId` at all, so the walk reads it as optional.
 */
export interface FolderLink {
  id: string;
  parentId?: string | null;
}

export interface WorkspaceInfo {
  path: string;
  branch: string;
  isMain: boolean;
  name: string | null;
  linkedIssues?: LinkedIssue[];
  hidden?: boolean;
  folderId?: string | null;
}

/** Pre-fetched issue data needed to create a workspace for it. */
export interface IssueSeed {
  number: number;
  title: string;
  url: string;
  body?: string | null;
}

/** Result of creating one workspace from an issue (partial-success friendly). */
export interface WorkspaceFromIssue {
  number: number;
  title: string;
  body: string | null;
  url: string;
  worktreePath?: string;
  error?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  // Bare local branch name (no "origin/" prefix). origin/ is prepended at use-sites — see ADR-081/144.
  defaultBranch: string;
  workspaces: WorkspaceInfo[];
  selectedWorkspaceIndex: number;
  defaultRunCommand: string | null;
  /**
   * The project's own worktree root, as the user wrote it: a leading `~`
   * stays unexpanded, since it means the home of whichever host the
   * project is on (ADR-183).
   */
  worktreePath: string | null;
  worktreeStartScript: string | null;
  worktreeTeardownScript: string | null;
  linearAssociations: LinearAssociation[];
  color: string | null;
  agentCommand: string | null;
  commands: CustomCommand[];
  themeName: string | null;
  setupComplete: boolean;
  /** Whether dev-server ports get `.localhost` preview hostnames. Defaults to true. */
  portlessEnabled: boolean;
  /** The host this project's paths, git and terminals live on (ADR-160). */
  hostId: string;
  folders: WorkspaceFolder[];
  /**
   * Normalized, depth-first order of workspace paths and folder ids — the
   * canonical shape of what the sidebar renders. See `normalizeSidebarOrder`.
   */
  sidebarOrder: string[];
  /**
   * The linked-project group this project belongs to (ADR-192), or null.
   * Every member carries the same summary, so the sidebar builds groups
   * from the project list alone. Always set by `buildProjectInfo`; optional
   * so fixtures and the renderer's mirror type need not name it.
   */
  group?: ProjectGroupInfo | null;
}

/**
 * The settings a linked-project group shares across its members (ADR-192
 * ticket 2). A grouped project's `ProjectInfo` carries the group's values
 * for these; everything else stays per member, per host.
 */
export type GroupSharedFields = Pick<
  ProjectInfo,
  "name" | "color" | "agentCommand" | "linearAssociations"
>;

export type GroupUpdatableFields = Partial<GroupSharedFields>;

/** What the renderer sees of a project group (ADR-192). */
export interface ProjectGroupInfo {
  id: string;
  name: string;
  /** Member project ids, in the order their host sections render. */
  memberIds: string[];
  /** The host a workspace was last created on in this group, if known. */
  lastUsedHostId: string | null;
}

/**
 * A project or group Manor suggests linking a project with, because their
 * `origin` URLs match (ADR-192 ticket 5). Only a suggestion: nothing is
 * linked until the user accepts.
 */
export interface LinkSuggestion {
  /** The project to pass to `linkProjects`: a lone project, or a group's first member. */
  projectId: string;
  /** The project's name, or its group's. */
  name: string;
  /** `projectId`'s host. */
  hostId: string;
  /** Where it lives, for the prompt: its host's label, or a group's hosts' labels. */
  hostLabel: string;
  /** The group it would join, or null for a lone project. */
  groupId: string | null;
}

export type ProjectUpdatableFields = Partial<
  Pick<
    ProjectInfo,
    | "name"
    | "defaultRunCommand"
    | "worktreePath"
    | "worktreeStartScript"
    | "worktreeTeardownScript"
    | "linearAssociations"
    | "color"
    | "agentCommand"
    | "commands"
    | "themeName"
    | "setupComplete"
    | "portlessEnabled"
  >
>;

export interface PersistedProject {
  id: string;
  name: string;
  path: string;
  selectedWorkspaceIndex: number;
  workspaces: unknown[];
  // Bare local branch name (no "origin/" prefix). origin/ is prepended at use-sites — see ADR-081/144.
  defaultBranch: string;
  defaultRunCommand: string | null;
  /** As the user wrote it — a leading `~` is expanded only when read (ADR-183). */
  worktreePath: string | null;
  worktreeStartScript?: string | null;
  worktreeTeardownScript?: string | null;
  linearAssociations?: LinearAssociation[];
  workspaceNames?: Record<string, string>;
  workspaceOrder?: string[];
  workspaceIssues?: Record<string, LinkedIssue[]>;
  workspaceHidden?: Record<string, boolean>;
  // `parentId` is absent in files written before ADR-172; read it as null.
  workspaceFolders?: Array<{
    id: string;
    name: string;
    parentId?: string | null;
  }>;
  workspaceFolderIds?: Record<string, string>;
  color?: string | null;
  agentCommand?: string | null;
  commands?: CustomCommand[];
  themeName?: string | null;
  setupComplete?: boolean;
  portlessEnabled?: boolean;
  /**
   * The host the project lives on. Always set in memory; absent on disk
   * for `"local"`, so files written before ADR-160 load unchanged and a
   * local record is written back byte-for-byte (see `StateStore`).
   */
  hostId: string;
  /**
   * The root path this project last had on each host it has lived on, keyed
   * by host id (ADR-179). Lets a move back to a host restore its path
   * instead of keeping the current host's, which does not exist there.
   */
  hostPaths?: Record<string, string>;
}

/**
 * A registered remote host. A record rather than a bare spec so per-host
 * state that is not part of how to reach it — ADR-178's provider settings
 * and hook-replay position (`lastHookSeq`) — can sit beside `spec` without
 * a migration.
 */
export interface PersistedHost {
  spec: HostSpec;
  /**
   * The last seq of this host's hook journal Electron main has ingested
   * (ADR-178 §2). Absent until the journal is first met — then the hook
   * feed starts at the journal's head instead of replaying its history.
   * Kept when the spec changes (a new address is usually the same box); if
   * it is a different box, its journal has a different `hookJournalEpoch`
   * and the hook feed starts over.
   */
  lastHookSeq?: number;
  /** The epoch of the journal `lastHookSeq` counts in (ADR-178 §2). */
  hookJournalEpoch?: string;
}

/**
 * A linked-project group (ADR-192): single-host projects of the same repo,
 * shown as one sidebar entry with a section per host. A project is in at
 * most one group, a group has at most one member per host and at least two
 * members — see `project-groups.ts`.
 */
export interface PersistedProjectGroup {
  id: string;
  name: string;
  memberIds: string[];
  lastUsedHostId: string | null;
  /**
   * Shared settings (ticket 2). Absent means "not set on the group": a
   * member then shows its own value. Groups linked before ticket 2 have
   * none, so they load and write back unchanged.
   */
  color?: string | null;
  agentCommand?: string | null;
  linearAssociations?: LinearAssociation[];
  /**
   * The group's repo as a normalized `origin` URL (`originKey`, ADR-192
   * ticket 5), so link suggestions can match it while its hosts are away.
   * Absent until a member's host has reported one.
   */
  originUrl?: string;
}

export interface PersistedState {
  projects: PersistedProject[];
  selectedProjectIndex: number;
  /** Remote hosts by hostId. Absent in files written before ADR-160. */
  hosts?: Record<string, PersistedHost>;
  /** Linked-project groups (ADR-192). Absent when there are none. */
  groups?: PersistedProjectGroup[];
  /**
   * Pairs of project ids the user declined to link when it was suggested
   * (ADR-192 ticket 5), each in sorted order. Absent when there are none.
   */
  dismissedLinkSuggestions?: Array<[string, string]>;
}

/**
 * What `ProjectManager` needs of one host (ADR-183): its git, its shell
 * for scripts, and the facts about its machine. A `WorkspaceBackend` is one.
 */
export interface ProjectHost {
  readonly git: GitBackend;
  readonly shell: ShellBackend;
  readonly facts: MachineFacts;
}

/** Resolves a host id to its backend (see `BackendRegistry.get`). */
export type ProjectHostResolver = (hostId: string) => ProjectHost;

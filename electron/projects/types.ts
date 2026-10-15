/**
 * The shapes `ProjectManager` hands out and the ones it persists in
 * `projects.json` (ADR-183 split them out of `persistence.ts`).
 */

import type { LayoutEntry } from "../../src/lib/layout/protocol";
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

/** Everything about a new worktree beyond its project and name. */
export interface CreateWorktreeOptions {
  /** The branch to create or check out; defaults to one named after `name`. */
  branch?: string;
  linkedIssue?: LinkedIssue;
  /** The ref a new branch starts from; defaults to the project's default. */
  baseBranch?: string;
  /** Check `branch` out as it is rather than creating it. */
  useExistingBranch?: boolean;
  /** Sidebar folder to file it under; an unknown id leaves it loose. */
  folderId?: string | null;
  /**
   * The bridge connection that asked, so its own window gets the setup
   * progress (ADR-180 D5). Null — the default, and what the CLI, MCP and the
   * issue-batch path pass — broadcasts it instead.
   */
  origin?: string | null;
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
 * ticket 2; `themeName` and `commands` joined in ADR-193 ticket 1). A
 * grouped project's `ProjectInfo` carries the group's values for these;
 * everything else stays per member, per host.
 */
export type GroupSharedFields = Pick<
  ProjectInfo,
  "name" | "color" | "agentCommand" | "linearAssociations" | "themeName" | "commands"
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
  /** Where it lives, for the prompt: its host's label, or a group's hosts' labels. */
  hostLabel: string;
}

/** Whether a transfer clones a new linked project or re-points this one (ADR-213). */
export type TransferMode = "copy" | "move";

/**
 * Why a transfer can't go ahead without the user (ADR-213): the project
 * has no usable `origin`, the target directory holds something else or
 * belongs to another project, or the group already has a member there.
 */
export type TransferInputReason = "no-origin" | "dir-taken" | "host-taken";

/**
 * Where a transfer onto a host would go, worked out without changing
 * anything (ADR-213). `targetDir` is either absolute or `~/…`, expanded
 * against the target host's home when the transfer runs.
 */
export type TransferPlan =
  | {
      kind: "ready";
      repoUrl: string;
      targetDir: string;
      via: "remembered" | "adopt" | "mirror" | "default";
    }
  | {
      kind: "needsInput";
      reason: TransferInputReason;
      repoUrl: string | null;
      targetDir: string;
    };

/** What `transferProject` hands back: the project on the target, or what to ask. */
export type TransferResult =
  | { ok: true; project: ProjectInfo }
  | {
      ok: false;
      needsInput: Extract<TransferPlan, { kind: "needsInput" }> & {
        mode: TransferMode;
        hostId: string;
      };
    };

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
 * and the adoption marks — can sit beside `spec` without a migration.
 */
export interface PersistedHost {
  spec: HostSpec;
  /**
   * The host's server owns its projects, agents and layout, and this desktop
   * has handed over what it held for it (ADR-227 D3,
   * `backend/host-adoption.ts`). Absent until then.
   */
  adopted?: true;
  /**
   * The ids of the projects handed over, which now live only on the host. A
   * linked-project group (ADR-192) still names them in `memberIds`, so
   * loading `projects.json` keeps them there (`normalizeGroups`) rather than
   * dropping them as unknown.
   */
  adoptedProjectIds?: string[];
  /**
   * "Phones paired with this Mac can reach <host>" (ADR-228 D9): false when
   * the user turned it off, so `remoteControl.linkHostPairings` mints nothing
   * here. Absent is on.
   */
  linkPhones?: false;
  /**
   * Linked pairings on the host's server still to revoke: their desktop
   * device was revoked, or the switch above turned off, while the host was
   * away. Each is the host's own device id; `HostServerSync` revokes them on
   * the next owner connect. Absent when there are none.
   */
  pendingRevokes?: string[];
  /**
   * Pairings this desktop started minting on the host's server whose answer
   * was not handled yet (ADR-230 D11), each under a label unique to it. One
   * still here on the next owner connect lost its answer: `HostServerSync`
   * revokes whatever the host made under that label. Absent when there are
   * none.
   */
  pendingMints?: Array<{ label: string; startedAt: number }>;
  /**
   * "Keep Manor running when <host> restarts" (ADR-229 D4): the host's
   * daemon and server go under its own supervisor, installed on connect when
   * the host reports none. True for hosts added since, and for recipe hosts;
   * absent (off) for ssh hosts added before, whose boxes the user set up.
   */
  supervise?: boolean;
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
  /** ADR-193 ticket 1: shared like `color` (absent falls through, null is a value). */
  themeName?: string | null;
  /** ADR-193 ticket 1: shared like `linearAssociations`. */
  commands?: CustomCommand[];
  /**
   * The group's repo as a normalized `origin` key (`originKey` in
   * `origin-links.ts`, ADR-192 ticket 5), so link suggestions can match it
   * while its hosts are away. Absent until a member's host has reported one;
   * cleared when a member leaves, and derived again from those that remain.
   */
  originKey?: string;
}

export interface PersistedState {
  projects: PersistedProject[];
  selectedProjectIndex: number;
  /**
   * The sidebar's order of every project, remote hosts' included (ADR-227
   * D4): `projects` holds only this desktop's own, so a host's projects
   * keep their place here once handed over. Absent until first needed;
   * ids it lacks sort after it, in `projects` order.
   */
  projectOrder?: string[];
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

/**
 * The projects that live on remote hosts' servers, as the desktop reaches
 * them (ADR-227 D4): one `HostProxy` per adopted host. `ProjectManager`
 * holds this machine's projects (and a host's not yet handed over); these
 * it only reads, and writes through.
 */
export interface RemoteProjects {
  /**
   * Every adopted host's projects in the desktop's form (`hostId` stamped),
   * live, or the cache's while a host is away.
   */
  list(): ProjectInfo[];
  /** Whether `hostId`'s projects live on its server: a new one goes there. */
  owns(hostId: string): boolean;
  /**
   * `projects.<method>(...args)` on `hostId`'s server, arguments and answer
   * in the desktop's form. Rejects while the host is away.
   */
  call(hostId: string, method: string, args: unknown[]): Promise<unknown>;
  /**
   * Hand what this desktop holds for `hostId` — `projectIds`, and its
   * `<hostId>:*` layout — to that host's server, then let go of it
   * (`HostAdoption.handOver`): how a project moved onto the host gets there.
   */
  handOver(hostId: string, projectIds: readonly string[]): Promise<void>;
  /** `hostId`'s layout as its server holds it, keyed `<hostId>:<path>`. */
  layoutOf(hostId: string): Record<string, LayoutEntry>;
}

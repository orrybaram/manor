/**
 * MCP tools for project and workspace management.
 */

import { LOCAL_HOST_ID } from "../backend/types";
import {
  resolveContext,
  resolveProjectId,
  resolveWorkspacePath,
} from "./context";
import type { Http, ToolDef, ToolModule } from "./types";
import { text } from "./types";

/** Shared by every tool that takes an optional, inferrable project. */
const PROJECT_ID_PROP = {
  type: "string",
  description: "Project ID. Defaults to the project this agent is running in.",
} as const;

/**
 * The optional `host` of every workspace-creating tool (`create_workspace`
 * here, `batch_create_workspaces` in tools-agents.ts); the routes resolve it
 * the same way.
 */
export const CREATE_HOST_PROP = {
  type: "string",
  description:
    "For a linked project: the host to create on (a host id or ssh target, or 'local'), which picks that host's member of the group. Defaults to the caller's own host when it is a remote pane, then the group's last-used host.",
} as const;

// ── Project & workspace types ──

export interface WorkspaceFolder {
  id: string;
  name: string;
  /** Enclosing folder, or null at the top level. */
  parentId?: string | null;
}

export interface WorkspaceInfo {
  path: string;
  branch: string;
  isMain: boolean;
  name: string | null;
  folderId?: string | null;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  workspaces: WorkspaceInfo[];
  /** Shell script run in a freshly created workspace, if the project sets one. */
  worktreeStartScript?: string | null;
  folders?: WorkspaceFolder[];
  sidebarOrder?: string[];
  /** The host the project lives on. */
  hostId?: string;
  /** That host's label: its ssh target, or "this Mac". */
  host?: string;
  /** Its linked-project group, as `GET /projects` lists it. */
  group?: ProjectGroupListing | null;
}

/** One member of a linked-project group: a project on one host. */
interface ProjectGroupMember {
  projectId: string;
  name: string;
  hostId: string;
  /** The host's label: its ssh target, or "this Mac". */
  host: string;
}

interface ProjectGroupListing {
  id: string;
  name: string;
  members?: ProjectGroupMember[];
  lastUsedHostId: string | null;
}

/** " on <host>" for a reply naming where something landed, or "". */
function hostOf(p: ProjectInfo): string {
  const host = p.host ?? p.hostId;
  return host ? ` on ${host}` : "";
}

function projectLine(p: ProjectInfo, host?: string): string {
  const on = host ? ` on ${host}` : "";
  return `${p.id}: ${p.name} (${p.path})${on} — ${p.workspaces.length} workspace(s)`;
}

/**
 * `list_projects`' text: each linked group once, where its first member
 * sits, with a line per member naming its host; unlinked projects one line
 * each, with their host when it isn't this machine.
 */
function formatProjectListing(projects: ProjectInfo[]): string {
  const lines: string[] = [];
  const seenGroups = new Set<string>();
  for (const p of projects) {
    const group = p.group;
    if (!group) {
      const remote = p.hostId !== undefined && p.hostId !== LOCAL_HOST_ID;
      lines.push(projectLine(p, remote ? (p.host ?? p.hostId) : undefined));
      continue;
    }
    if (seenGroups.has(group.id)) continue;
    seenGroups.add(group.id);
    const lastUsed = group.members?.find((m) => m.hostId === group.lastUsedHostId);
    lines.push(
      `group ${group.id}: ${group.name}${lastUsed ? ` (last used: ${lastUsed.host})` : ""}`,
    );
    for (const member of group.members ?? []) {
      const project = projects.find((q) => q.id === member.projectId);
      lines.push(
        project
          ? `  ${projectLine(project, member.host)}`
          : `  ${member.projectId}: ${member.name} on ${member.host}`,
      );
    }
  }
  return lines.join("\n");
}

// ── Moving a workspace to another host ──

/** What `POST /workspaces/move-to-host` answers (`WorkspaceMoveAnswer`). */
type WorkspaceMoveAnswer = {
  sourceHost: string;
  targetHost: string;
} & (
  | {
      ok: true;
      targetPath: string;
      reused: boolean;
      sourceRemoved: boolean;
    }
  | { ok: false; refusals: MoveRefusal[] }
  | { ok: false; needsInput: { reason: string; repoUrl: string | null; targetDir: string } }
  | { ok: false; step: string; error: string }
);

type MoveRefusal = { code: string; files?: Array<{ code: string; path: string }> };

/** A move's step, as the error names it. */
const MOVE_STEP_LABELS: Record<string, string> = {
  push: "Pushing the branch",
  setUp: "Setting the project up",
  create: "Creating the workspace",
  setupScript: "Running the setup script",
  restore: "Restoring the tabs",
  agents: "Starting the agents",
  removeSource: "Removing the old workspace",
};

/** Why a move was refused, as a line (and the files, for a dirty tree). */
function formatMoveRefusal(r: MoveRefusal, targetHost: string): string {
  // Where the host's name starts the sentence.
  const TargetHost = targetHost === "this machine" ? "This machine" : targetHost;
  const files = (r.files ?? []).map((f) => `    ${f.code} ${f.path}`);
  const count = (n: number) => `${n} changed file${n === 1 ? "" : "s"}`;
  switch (r.code) {
    case "dirty":
      return [`  Commit or discard ${count(files.length)} first:`, ...files].join("\n");
    case "target-dirty":
      return [
        `  ${TargetHost} already has this branch checked out, with ${count(files.length)}:`,
        ...files,
      ].join("\n");
    case "no-origin":
      return "  The repository has no 'origin' remote to push the branch to.";
    case "main-workspace":
      return "  It is the project's main workspace; only other workspaces move.";
    case "same-host":
      return `  It is already on ${targetHost}.`;
    case "detached":
      return "  It is not on a branch (detached HEAD).";
    case "target-main-on-branch":
      return `  The project's main checkout on ${targetHost} is on this branch.`;
    case "target-cannot-fast-forward":
      return `  ${TargetHost}'s checkout of this branch has commits this one doesn't, so it can't be fast-forwarded.`;
    default:
      return `  ${r.code}`;
  }
}

/** A host's name mid-sentence: "this machine", or the remote host's name as it is. */
function midSentence(host: string): string {
  return host === "This machine" ? "this machine" : host;
}

/** `move_workspace_to_host`'s text for each way a move ends. */
export function formatWorkspaceMove(worktreePath: string, answer: WorkspaceMoveAnswer): string {
  const sourceHost = midSentence(answer.sourceHost);
  const targetHost = midSentence(answer.targetHost);
  if (answer.ok) {
    const lines = [`Moved workspace to ${targetHost}: ${answer.targetPath}`];
    if (answer.reused) lines.push(`Used the workspace ${targetHost} already had on this branch.`);
    lines.push(
      answer.sourceRemoved
        ? `Removed ${worktreePath} from ${sourceHost}; the branch is kept.`
        : `Kept ${worktreePath} on ${sourceHost}.`,
    );
    return lines.join("\n");
  }
  if ("refusals" in answer) {
    return [
      `Can't move ${worktreePath} to ${targetHost}:`,
      ...answer.refusals.map((r) => formatMoveRefusal(r, targetHost)),
      "Nothing was changed.",
    ].join("\n");
  }
  if ("needsInput" in answer) {
    return `Can't move ${worktreePath}: set the project up on ${targetHost} first (Set up on… in the sidebar), then move it again. Nothing was changed.`;
  }
  const label = MOVE_STEP_LABELS[answer.step] ?? answer.step;
  // The push and the removal run on the source; every other step on the target.
  const onSource = answer.step === "push" || answer.step === "removeSource";
  const left =
    answer.step === "removeSource"
      ? `The workspace is on ${targetHost} now; ${worktreePath} may still be on ${sourceHost}.`
      : `${worktreePath} is still on ${sourceHost}, as it was.`;
  return `Couldn't move ${worktreePath}: ${label} on ${onSource ? sourceHost : targetHost} failed: ${answer.error}\n${left}`;
}

/**
 * The project a move names: the one given, else the caller's own as
 * `remove_workspace` finds it (`resolveProjectId`), when that project has the
 * workspace — so an agent in a linked group's workspace names its own host's
 * member. Otherwise none, and the route finds the project by the path.
 */
async function moveProjectId(
  http: Http,
  projectId: string | undefined,
  worktreePath: string,
): Promise<string | undefined> {
  if (projectId) return projectId;
  try {
    const own = await resolveProjectId(http);
    if (!own) return undefined;
    const project = (await http.get(`/projects/${encodeURIComponent(own)}`)) as ProjectInfo;
    return project.workspaces?.some((ws) => ws.path === worktreePath) ? own : undefined;
  } catch {
    // Not in a Manor pane, or its project is gone: the path decides.
    return undefined;
  }
}

/**
 * A move pushes, may clone, and waits for the setup script up to 30
 * minutes (`START_SCRIPT_MAX_WAIT_MS`, which the server's move passes on;
 * not imported, as the CLI bundle stays clear of the server). Ten more
 * cover the push, the clone, the tabs and the agents.
 */
const MOVE_TIMEOUT_MS = 40 * 60_000;

export function formatWorkspace(
  ws: WorkspaceInfo,
  folders: WorkspaceFolder[] = [],
): string {
  const label = ws.name ? `${ws.name} ` : "";
  const main = ws.isMain ? " [main]" : "";
  const folder = ws.folderId
    ? folders.find((f) => f.id === ws.folderId)
    : undefined;
  const folderLabel = folder ? ` [folder: ${folder.name}]` : "";
  return `  - ${label}${ws.path} (${ws.branch})${main}${folderLabel}`;
}

export function formatProject(p: ProjectInfo): string {
  const lines = [
    `${p.id}: ${p.name}`,
    `  path: ${p.path}`,
    `  default branch: ${p.defaultBranch}`,
    `  workspaces (${p.workspaces.length}):`,
    ...p.workspaces.map((ws) => formatWorkspace(ws, p.folders)),
  ];
  return lines.join("\n");
}

/** The `LinkedIssue` shape `link_issue`/`list_workspace_issues` speak on the wire. */
export interface LinkedIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

// ── Tool definitions ──

const tools: ToolDef[] = [
  {
    name: "list_projects",
    description:
      "List all projects in Manor with their IDs, names, paths, hosts, and workspace counts. Linked projects (the same repo on several hosts) are listed under their group, one member per host.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_project",
    description:
      "Get full details for a project including all of its workspaces.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
      },
    },
  },
  {
    name: "add_project",
    description: "Add a new project to Manor by name and directory path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Display name for the project." },
        path: {
          type: "string",
          description: "Absolute path to the project directory.",
        },
      },
      required: ["name", "path"],
    },
  },
  {
    name: "create_workspace",
    description:
      "Create a new workspace (git worktree) in a project. Creates a new branch by default, or checks out an existing one. Runs the project's setup script afterwards, if one is configured. Provide 'name', 'branch', or both.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        name: {
          type: "string",
          description:
            "Workspace name (also used as the branch name unless 'branch' is given). Defaults to 'branch' when omitted.",
        },
        branch: {
          type: "string",
          description:
            "Branch name, if different from the workspace name. Defaults to 'name' when omitted.",
        },
        baseBranch: {
          type: "string",
          description: "Base branch/ref to branch from (e.g. 'origin/main').",
        },
        useExistingBranch: {
          type: "boolean",
          description:
            "Check out an existing branch instead of creating a new one.",
        },
        host: CREATE_HOST_PROP,
      },
    },
  },
  {
    name: "list_workspaces",
    description: "List all workspaces (git worktrees) for a project.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
      },
    },
  },
  {
    name: "remove_workspace",
    description: "Remove a workspace (git worktree) from a project.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        worktreePath: {
          type: "string",
          description: "Filesystem path of the workspace to remove.",
        },
        deleteBranch: {
          type: "boolean",
          description: "Also delete the workspace's git branch.",
        },
      },
      required: ["worktreePath"],
    },
  },
  {
    name: "move_workspace_to_host",
    description:
      "Move a workspace (not a project's main one) to another host: push its branch, set the project up on that host if needed, make the workspace there on the same branch and run its setup script, bring back its tabs, start its agents fresh with a handoff of their session, then remove it here. Refused while the workspace has uncommitted changes. Prints the new workspace's path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        worktreePath: {
          type: "string",
          description: "Filesystem path of the workspace to move.",
        },
        host: {
          type: "string",
          description:
            "The host to move it to: a host id or ssh target, or 'local' for this machine.",
        },
        keepSource: {
          type: "boolean",
          description: "Keep the workspace where it is as well, rather than removing it.",
        },
        projectId: {
          type: "string",
          description:
            "The workspace's project, when more than one host has a workspace at that path.",
        },
      },
      required: ["worktreePath", "host"],
    },
  },
  {
    name: "current_workspace",
    description:
      "Identify the Manor project and workspace this agent is running in, and which issue sources are available.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },

  // ── Folders ──

  {
    name: "list_folders",
    description: "List the sidebar folders defined in a project.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
      },
    },
  },
  {
    name: "create_folder",
    description: "Create a new sidebar folder in a project.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        name: { type: "string", description: "Folder name." },
        parentId: {
          type: ["string", "null"],
          description:
            "Folder id to nest the new folder inside. Omit or pass null to create it at the top level.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "rename_folder",
    description: "Rename a sidebar folder.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        folderId: { type: "string", description: "Folder to rename." },
        name: { type: "string", description: "New folder name." },
      },
      required: ["folderId", "name"],
    },
  },
  {
    name: "move_folder",
    description:
      "Nest a sidebar folder inside another folder, or move it back to the top level.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        folderId: { type: "string", description: "Folder to move." },
        parentId: {
          type: ["string", "null"],
          description:
            "Folder id to nest it inside. Omit or pass null to move it to the top level. A folder cannot be moved inside itself or one of its own descendants.",
        },
      },
      required: ["folderId"],
    },
  },
  {
    name: "delete_folder",
    description:
      "Destructive: permanently deletes a sidebar folder. Workspaces inside it are not deleted — they are unfiled, not removed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        folderId: { type: "string", description: "Folder to delete." },
      },
      required: ["folderId"],
    },
  },
  {
    name: "set_workspace_folder",
    description:
      "Move a workspace into a sidebar folder, or out of one. 'workspacePath' defaults to the workspace this agent is running in.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        workspacePath: {
          type: "string",
          description:
            "Filesystem path of the workspace to move. Defaults to the workspace this agent is running in.",
        },
        folderId: {
          type: ["string", "null"],
          description:
            "Folder id to move the workspace into. Omit or pass null to remove it from its current folder.",
        },
      },
    },
  },

  // ── Workspace metadata ──

  {
    name: "rename_workspace",
    description:
      "Rename a workspace's display name in the sidebar (does not rename its branch or directory). 'workspacePath' defaults to the workspace this agent is running in. An empty 'name' clears the custom name back to the branch name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        workspacePath: {
          type: "string",
          description:
            "Filesystem path of the workspace to rename. Defaults to the workspace this agent is running in.",
        },
        name: { type: "string", description: "New display name." },
      },
      required: ["name"],
    },
  },
  {
    name: "set_workspace_hidden",
    description:
      "Show or hide a workspace in the sidebar. 'workspacePath' defaults to the workspace this agent is running in.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        workspacePath: {
          type: "string",
          description:
            "Filesystem path of the workspace. Defaults to the workspace this agent is running in.",
        },
        hidden: {
          type: "boolean",
          description: "Whether to hide the workspace.",
        },
      },
      required: ["hidden"],
    },
  },
  {
    name: "reorder_workspaces",
    description:
      "Persist the sidebar order for a project's workspaces and folders.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        orderedKeys: {
          type: "array",
          items: { type: "string" },
          description:
            "Workspace paths and/or folder ids, in the desired sidebar order.",
        },
      },
      required: ["orderedKeys"],
    },
  },
  {
    name: "convert_main_to_worktree",
    description:
      "Convert the main workspace's current branch into its own worktree, checking the main workspace back out onto the project's default branch. Fails if the main workspace is already on the default branch.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        name: {
          type: "string",
          description: "Name for the new worktree.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "can_quick_merge",
    description:
      "Check whether a workspace can be fast-forward merged into the project's default branch without conflicts. 'workspacePath' defaults to the workspace this agent is running in.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        workspacePath: {
          type: "string",
          description:
            "Filesystem path of the workspace. Defaults to the workspace this agent is running in.",
        },
      },
    },
  },
  {
    name: "quick_merge_workspace",
    description:
      "Destructive: fast-forward merges a workspace's branch into the project's default branch, then removes the workspace and its branch. Check can_quick_merge first — this fails loudly if the merge is not a clean fast-forward. 'workspacePath' defaults to the workspace this agent is running in.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        workspacePath: {
          type: "string",
          description:
            "Filesystem path of the workspace to merge and remove. Defaults to the workspace this agent is running in.",
        },
      },
    },
  },

  // ── Issue links ──

  {
    name: "list_workspace_issues",
    description:
      "List the issues linked to a workspace. 'workspacePath' defaults to the workspace this agent is running in.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        workspacePath: {
          type: "string",
          description:
            "Filesystem path of the workspace. Defaults to the workspace this agent is running in.",
        },
      },
    },
  },
  {
    name: "link_issue",
    description:
      "Link an issue to a workspace. 'workspacePath' defaults to the workspace this agent is running in.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        workspacePath: {
          type: "string",
          description:
            "Filesystem path of the workspace. Defaults to the workspace this agent is running in.",
        },
        id: { type: "string", description: "Issue id." },
        identifier: {
          type: "string",
          description:
            "Human-readable issue identifier (e.g. '#42' or 'ENG-123').",
        },
        title: { type: "string", description: "Issue title." },
        url: { type: "string", description: "Issue URL." },
      },
      required: ["id", "identifier", "title", "url"],
    },
  },
  {
    name: "unlink_issue",
    description:
      "Unlink an issue from a workspace. 'workspacePath' defaults to the workspace this agent is running in.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        workspacePath: {
          type: "string",
          description:
            "Filesystem path of the workspace. Defaults to the workspace this agent is running in.",
        },
        issueId: { type: "string", description: "Id of the issue to unlink." },
      },
      required: ["issueId"],
    },
  },

  // ── Branches ──

  {
    name: "list_branches",
    description:
      "List a project's local or remote git branches, most recently created first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        scope: {
          type: "string",
          enum: ["local", "remote"],
          description: "Which branches to list. Defaults to 'local'.",
        },
      },
    },
  },

  // ── Project management ──

  {
    name: "update_project",
    description: "Update a project's settings.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        name: { type: "string", description: "Display name for the project." },
        defaultRunCommand: {
          type: "string",
          description: "Default command run in new workspaces.",
        },
        worktreePath: {
          type: "string",
          description: "Base directory new worktrees are created under.",
        },
        worktreeStartScript: {
          type: "string",
          description: "Shell script run after a new worktree is created.",
        },
        worktreeTeardownScript: {
          type: "string",
          description: "Shell script run before a worktree is removed.",
        },
        color: { type: "string", description: "Sidebar accent color." },
        agentCommand: {
          type: "string",
          description: "Command used to launch an agent in this project.",
        },
        themeName: { type: "string", description: "Terminal theme name." },
        setupComplete: {
          type: "boolean",
          description: "Whether the project's setup flow has been completed.",
        },
        portlessEnabled: {
          type: "boolean",
          description:
            "Whether dev-server ports get '.localhost' preview hostnames.",
        },
      },
    },
  },
  {
    name: "remove_project",
    description:
      "Destructive: removes a project from Manor's project list. This does not delete any files or git worktrees on disk, but the project must be re-added with add_project to reappear in Manor.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
      },
    },
  },
  {
    name: "reorder_projects",
    description: "Persist the sidebar order for all projects.",
    inputSchema: {
      type: "object" as const,
      properties: {
        orderedIds: {
          type: "array",
          items: { type: "string" },
          description: "Project ids in the desired sidebar order.",
        },
      },
      required: ["orderedIds"],
    },
  },
  {
    name: "resync_default_branches",
    description:
      "Re-detect the default branch (main/master/etc.) for every project from its git remote.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// ── Tool handlers ──

const handlers: ToolModule["handlers"] = {
  async list_projects(_args, http) {
    const projects = (await http.get("/projects")) as ProjectInfo[];
    if (projects.length === 0) {
      return text("No projects in Manor yet.");
    }
    return text(formatProjectListing(projects));
  },

  async get_project(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const project = (await http.get(
      `/projects/${encodeURIComponent(projectId)}`,
    )) as ProjectInfo;
    return text(formatProject(project));
  },

  async add_project(args, http) {
    const project = (await http.post("/projects", {
      name: args.name,
      path: args.path,
    })) as ProjectInfo;
    return text(`Added project "${project.name}" (${project.id})`);
  },

  async create_workspace(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    // `name` and `branch` each default to the other; the control server rejects
    // the request when neither is supplied.
    const label = (args.name ?? args.branch) as string | undefined;
    const body: Record<string, unknown> = {};
    if (args.name !== undefined) body.name = args.name;
    if (args.branch !== undefined) body.branch = args.branch;
    if (args.baseBranch !== undefined) body.baseBranch = args.baseBranch;
    if (args.useExistingBranch !== undefined)
      body.useExistingBranch = args.useExistingBranch;
    if (args.host !== undefined) body.host = args.host;
    const project = (await http.post(
      `/projects/${encodeURIComponent(projectId)}/workspaces`,
      body,
    )) as ProjectInfo;
    const setupNote = project.worktreeStartScript
      ? "\n\nThe project's setup script is running in the new workspace."
      : "";
    return text(
      `Created workspace "${label}" in project "${project.name}" (${project.id}${hostOf(project)}).${setupNote}\n\nWorkspaces now:\n${project.workspaces
        .map((ws) => formatWorkspace(ws, project.folders))
        .join("\n")}`,
    );
  },

  async list_workspaces(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const project = (await http.get(
      `/projects/${encodeURIComponent(projectId)}`,
    )) as ProjectInfo;
    if (project.workspaces.length === 0) {
      return text("No workspaces in this project.");
    }
    return text(
      project.workspaces
        .map((ws) => formatWorkspace(ws, project.folders))
        .join("\n"),
    );
  },

  async remove_workspace(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    await http.del(`/projects/${encodeURIComponent(projectId)}/workspaces`, {
      worktreePath: args.worktreePath,
      ...(args.deleteBranch !== undefined
        ? { deleteBranch: args.deleteBranch }
        : {}),
    });
    return text(`Removed workspace at ${args.worktreePath}.`);
  },

  async move_workspace_to_host(args, http) {
    const worktreePath = args.worktreePath as string;
    const body: Record<string, unknown> = { worktreePath, host: args.host };
    if (args.keepSource !== undefined) body.keepSource = args.keepSource;
    const projectId = await moveProjectId(http, args.projectId as string | undefined, worktreePath);
    if (projectId !== undefined) body.projectId = projectId;
    const answer = (await http.post(
      "/workspaces/move-to-host",
      body,
      MOVE_TIMEOUT_MS,
    )) as WorkspaceMoveAnswer;
    return text(formatWorkspaceMove(worktreePath, answer));
  },

  async current_workspace(_args, http) {
    const ctx = await resolveContext(http);
    // An empty `sources` is information, not an omission — say so out loud.
    const sources =
      ctx.sources.length > 0 ? ctx.sources.join(", ") : "none configured";
    const lines = [
      `${ctx.projectName} (project ${ctx.projectId})`,
      `  path: ${ctx.projectPath}`,
      `  workspace: ${ctx.workspacePath}`,
      `  branch: ${ctx.branch}${ctx.isMain ? " (main workspace)" : ""}`,
      `  issue sources: ${sources}`,
    ];
    return text(lines.join("\n"));
  },

  // ── Folders ──

  async list_folders(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const folders = (await http.get(
      `/projects/${encodeURIComponent(projectId)}/folders`,
    )) as WorkspaceFolder[];
    if (folders.length === 0) {
      return text("No folders in this project.");
    }
    return text(
      folders
        .map((f) =>
          f.parentId
            ? `${f.id}: ${f.name} (inside ${f.parentId})`
            : `${f.id}: ${f.name}`,
        )
        .join("\n"),
    );
  },

  async create_folder(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const parentId = (args.parentId as string | null | undefined) ?? null;
    const folder = (await http.post(
      `/projects/${encodeURIComponent(projectId)}/folders`,
      { name: args.name, parentId },
    )) as WorkspaceFolder;
    return text(`Created folder "${folder.name}" (${folder.id}).`);
  },

  async move_folder(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const folderId = args.folderId as string;
    const parentId = (args.parentId as string | null | undefined) ?? null;
    await http.post(
      `/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/parent`,
      { parentId },
    );
    return parentId
      ? text(`Moved folder ${folderId} inside ${parentId}.`)
      : text(`Moved folder ${folderId} to the top level.`);
  },

  async rename_folder(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    await http.post(
      `/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(args.folderId as string)}/rename`,
      { name: args.name },
    );
    return text(`Renamed folder ${args.folderId} to "${args.name}".`);
  },

  async delete_folder(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    await http.del(
      `/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(args.folderId as string)}`,
    );
    return text(`Deleted folder ${args.folderId}.`);
  },

  async set_workspace_folder(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const workspacePath = await resolveWorkspacePath(
      http,
      args.workspacePath as string | undefined,
    );
    const folderId = (args.folderId as string | null | undefined) ?? null;
    await http.post(
      `/projects/${encodeURIComponent(projectId)}/workspaces/folder`,
      { workspacePath, folderId },
    );
    return folderId
      ? text(`Moved ${workspacePath} into folder ${folderId}.`)
      : text(`Removed ${workspacePath} from its folder.`);
  },

  // ── Workspace metadata ──

  async rename_workspace(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const workspacePath = await resolveWorkspacePath(
      http,
      args.workspacePath as string | undefined,
    );
    await http.post(
      `/projects/${encodeURIComponent(projectId)}/workspaces/rename`,
      { workspacePath, name: args.name },
    );
    return text(`Renamed workspace ${workspacePath} to "${args.name}".`);
  },

  async set_workspace_hidden(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const workspacePath = await resolveWorkspacePath(
      http,
      args.workspacePath as string | undefined,
    );
    await http.post(
      `/projects/${encodeURIComponent(projectId)}/workspaces/hidden`,
      { workspacePath, hidden: args.hidden },
    );
    return text(`${args.hidden ? "Hid" : "Unhid"} workspace ${workspacePath}.`);
  },

  async reorder_workspaces(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    await http.post(
      `/projects/${encodeURIComponent(projectId)}/workspaces/reorder`,
      { orderedKeys: args.orderedKeys },
    );
    return text(`Reordered workspaces in project ${projectId}.`);
  },

  async convert_main_to_worktree(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const project = (await http.post(
      `/projects/${encodeURIComponent(projectId)}/workspaces/convert-main`,
      { name: args.name },
    )) as ProjectInfo;
    return text(
      `Converted the main workspace's branch into worktree "${args.name}".\n\n${formatProject(project)}`,
    );
  },

  async can_quick_merge(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const workspacePath = await resolveWorkspacePath(
      http,
      args.workspacePath as string | undefined,
    );
    const result = (await http.get(
      `/projects/${encodeURIComponent(projectId)}/workspaces/quick-merge?workspacePath=${encodeURIComponent(workspacePath)}`,
    )) as { canMerge: boolean; reason?: string };
    return text(
      result.canMerge
        ? `${workspacePath} can be quick-merged.`
        : `${workspacePath} cannot be quick-merged: ${result.reason}`,
    );
  },

  async quick_merge_workspace(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const workspacePath = await resolveWorkspacePath(
      http,
      args.workspacePath as string | undefined,
    );
    await http.post(
      `/projects/${encodeURIComponent(projectId)}/workspaces/quick-merge`,
      { workspacePath },
    );
    return text(`Merged and removed workspace ${workspacePath}.`);
  },

  // ── Issue links ──

  async list_workspace_issues(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const workspacePath = await resolveWorkspacePath(
      http,
      args.workspacePath as string | undefined,
    );
    const issues = (await http.get(
      `/projects/${encodeURIComponent(projectId)}/workspaces/issues?workspacePath=${encodeURIComponent(workspacePath)}`,
    )) as LinkedIssue[];
    if (issues.length === 0) {
      return text(`No issues linked to ${workspacePath}.`);
    }
    return text(
      issues.map((i) => `${i.identifier}: ${i.title} (${i.url})`).join("\n"),
    );
  },

  async link_issue(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const workspacePath = await resolveWorkspacePath(
      http,
      args.workspacePath as string | undefined,
    );
    await http.post(
      `/projects/${encodeURIComponent(projectId)}/workspaces/issues`,
      {
        workspacePath,
        issue: {
          id: args.id,
          identifier: args.identifier,
          title: args.title,
          url: args.url,
        },
      },
    );
    return text(`Linked ${args.identifier} to ${workspacePath}.`);
  },

  async unlink_issue(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const workspacePath = await resolveWorkspacePath(
      http,
      args.workspacePath as string | undefined,
    );
    await http.del(
      `/projects/${encodeURIComponent(projectId)}/workspaces/issues`,
      { workspacePath, issueId: args.issueId },
    );
    return text(`Unlinked issue ${args.issueId} from ${workspacePath}.`);
  },

  // ── Branches ──

  async list_branches(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const scope = (args.scope as string | undefined) ?? "local";
    const branches = (await http.get(
      `/projects/${encodeURIComponent(projectId)}/branches?scope=${encodeURIComponent(scope)}`,
    )) as string[];
    if (branches.length === 0) {
      return text(`No ${scope} branches found.`);
    }
    return text(branches.join("\n"));
  },

  // ── Project management ──

  async update_project(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const body: Record<string, unknown> = {};
    for (const key of [
      "name",
      "defaultRunCommand",
      "worktreePath",
      "worktreeStartScript",
      "worktreeTeardownScript",
      "color",
      "agentCommand",
      "themeName",
      "setupComplete",
      "portlessEnabled",
    ] as const) {
      if (args[key] !== undefined) body[key] = args[key];
    }
    const project = (await http.post(
      `/projects/${encodeURIComponent(projectId)}/update`,
      body,
    )) as ProjectInfo;
    return text(`Updated project "${project.name}" (${project.id}).`);
  },

  async remove_project(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    await http.del(`/projects/${encodeURIComponent(projectId)}`);
    return text(`Removed project ${projectId}.`);
  },

  async reorder_projects(args, http) {
    await http.post("/projects/reorder", { orderedIds: args.orderedIds });
    return text("Reordered projects.");
  },

  async resync_default_branches(_args, http) {
    await http.post("/projects/resync-default-branches");
    return text("Resynced default branches for every project.");
  },
};

export const projectsModule: ToolModule = { tools, handlers };

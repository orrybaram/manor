/**
 * MCP tools for project and workspace management.
 */

import type { ToolDef, ToolModule } from "./types";
import { text } from "./types";

// ── Project & workspace types ──

export interface WorkspaceInfo {
  path: string;
  branch: string;
  isMain: boolean;
  name: string | null;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  workspaces: WorkspaceInfo[];
  /** Shell script run in a freshly created workspace, if the project sets one. */
  worktreeStartScript?: string | null;
}

export function formatWorkspace(ws: WorkspaceInfo): string {
  const label = ws.name ? `${ws.name} ` : "";
  const main = ws.isMain ? " [main]" : "";
  return `  - ${label}${ws.path} (${ws.branch})${main}`;
}

export function formatProject(p: ProjectInfo): string {
  const lines = [
    `${p.id}: ${p.name}`,
    `  path: ${p.path}`,
    `  default branch: ${p.defaultBranch}`,
    `  workspaces (${p.workspaces.length}):`,
    ...p.workspaces.map(formatWorkspace),
  ];
  return lines.join("\n");
}

// ── Tool definitions ──

const tools: ToolDef[] = [
  {
    name: "list_projects",
    description:
      "List all projects in Manor with their IDs, names, paths, and workspace counts.",
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
        projectId: { type: "string", description: "Project ID." },
      },
      required: ["projectId"],
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
        projectId: { type: "string", description: "Project ID." },
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
          description: "Check out an existing branch instead of creating a new one.",
        },
      },
      required: ["projectId"],
    },
  },
  {
    name: "list_workspaces",
    description: "List all workspaces (git worktrees) for a project.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID." },
      },
      required: ["projectId"],
    },
  },
  {
    name: "remove_workspace",
    description: "Remove a workspace (git worktree) from a project.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID." },
        worktreePath: {
          type: "string",
          description: "Filesystem path of the workspace to remove.",
        },
        deleteBranch: {
          type: "boolean",
          description: "Also delete the workspace's git branch.",
        },
      },
      required: ["projectId", "worktreePath"],
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
    const listing = projects
      .map(
        (p) =>
          `${p.id}: ${p.name} (${p.path}) — ${p.workspaces.length} workspace(s)`,
      )
      .join("\n");
    return text(listing);
  },

  async get_project(args, http) {
    const project = (await http.get(
      `/projects/${encodeURIComponent(args.projectId as string)}`,
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
    const projectId = args.projectId as string;
    // `name` and `branch` each default to the other; the control server rejects
    // the request when neither is supplied.
    const label = (args.name ?? args.branch) as string | undefined;
    const body: Record<string, unknown> = {};
    if (args.name !== undefined) body.name = args.name;
    if (args.branch !== undefined) body.branch = args.branch;
    if (args.baseBranch !== undefined) body.baseBranch = args.baseBranch;
    if (args.useExistingBranch !== undefined)
      body.useExistingBranch = args.useExistingBranch;
    const project = (await http.post(
      `/projects/${encodeURIComponent(projectId)}/workspaces`,
      body,
    )) as ProjectInfo;
    const setupNote = project.worktreeStartScript
      ? "\n\nThe project's setup script is running in the new workspace."
      : "";
    return text(
      `Created workspace "${label}" in project "${project.name}".${setupNote}\n\nWorkspaces now:\n${project.workspaces
        .map(formatWorkspace)
        .join("\n")}`,
    );
  },

  async list_workspaces(args, http) {
    const workspaces = (await http.get(
      `/projects/${encodeURIComponent(args.projectId as string)}/workspaces`,
    )) as WorkspaceInfo[];
    if (workspaces.length === 0) {
      return text("No workspaces in this project.");
    }
    return text(workspaces.map(formatWorkspace).join("\n"));
  },

  async remove_workspace(args, http) {
    await http.del(
      `/projects/${encodeURIComponent(args.projectId as string)}/workspaces`,
      {
        worktreePath: args.worktreePath,
        ...(args.deleteBranch !== undefined
          ? { deleteBranch: args.deleteBranch }
          : {}),
      },
    );
    return text(`Removed workspace at ${args.worktreePath}.`);
  },
};

export const projectsModule: ToolModule = { tools, handlers };

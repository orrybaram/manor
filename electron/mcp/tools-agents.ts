/**
 * MCP tools for GitHub issues and agent launching.
 */

import type { ToolDef, ToolModule } from "./types";
import { text } from "./types";

// ── Tool definitions ──

const tools: ToolDef[] = [
  {
    name: "list_issues",
    description: "List a project's GitHub issues (assigned to you by default).",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID." },
        filter: {
          type: "string",
          description: "Which issues to list: 'assigned' (default) or 'all'.",
        },
        state: {
          type: "string",
          description: "Issue state: 'open', 'closed', or 'all'.",
        },
        limit: {
          type: "number",
          description: "Maximum number of issues to return.",
        },
      },
      required: ["projectId"],
    },
  },
  {
    name: "start_agent",
    description:
      "Launch an agent session in a workspace, optionally with an initial prompt. Fire-and-forget: returns once the launch is dispatched.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID." },
        workspacePath: {
          type: "string",
          description: "Filesystem path of the workspace to launch the agent in.",
        },
        prompt: {
          type: "string",
          description: "Optional initial prompt for the agent.",
        },
      },
      required: ["projectId", "workspacePath"],
    },
  },
  {
    name: "batch_create_workspaces",
    description:
      "Create one workspace per GitHub issue and (by default) launch an agent in each — fan a backlog out into parallel agent workspaces.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID." },
        issues: {
          type: "array",
          items: { type: "number" },
          description: "GitHub issue numbers to create workspaces for.",
        },
        baseBranch: {
          type: "string",
          description: "Base branch/ref to branch each workspace from.",
        },
        assign: {
          type: "boolean",
          description: "Assign each issue to you.",
        },
        startAgent: {
          type: "boolean",
          description: "Launch an agent in each workspace (default true).",
        },
        promptTemplate: {
          type: "string",
          description:
            "Prompt template for the launched agents. Supports {number}, {title}, {body}.",
        },
      },
      required: ["projectId", "issues"],
    },
  },
];

// ── Tool handlers ──

const handlers: ToolModule["handlers"] = {
  async list_issues(args, http) {
    const projectId = args.projectId as string;
    const params = new URLSearchParams();
    if (args.filter !== undefined) params.set("filter", String(args.filter));
    if (args.state !== undefined) params.set("state", String(args.state));
    if (args.limit !== undefined) params.set("limit", String(args.limit));
    const qs = params.toString();
    const issues = (await http.get(
      `/projects/${encodeURIComponent(projectId)}/issues?${qs}`,
    )) as Array<{
      number: number;
      title: string;
      url: string;
      state: string;
      labels: Array<{ name: string }>;
      assignees: unknown;
    }>;
    if (issues.length === 0) {
      return text("No issues found.");
    }
    const listing = issues
      .map((issue) => {
        const labels =
          issue.labels && issue.labels.length > 0
            ? ` [${issue.labels.map((l) => l.name).join(", ")}]`
            : "";
        return `#${issue.number} ${issue.title}${labels}`;
      })
      .join("\n");
    return text(listing);
  },

  async start_agent(args, http) {
    const body: Record<string, unknown> = {
      projectId: args.projectId,
      workspacePath: args.workspacePath,
    };
    if (args.prompt !== undefined) body.prompt = args.prompt;
    await http.post("/agents", body);
    return text(`Launched agent in ${args.workspacePath}.`);
  },

  async batch_create_workspaces(args, http) {
    const projectId = args.projectId as string;
    const body: Record<string, unknown> = { issues: args.issues };
    if (args.baseBranch !== undefined) body.baseBranch = args.baseBranch;
    if (args.assign !== undefined) body.assign = args.assign;
    if (args.startAgent !== undefined) body.startAgent = args.startAgent;
    if (args.promptTemplate !== undefined)
      body.promptTemplate = args.promptTemplate;
    const result = (await http.post(
      `/projects/${encodeURIComponent(projectId)}/workspaces/batch`,
      body,
    )) as {
      results: Array<{
        number: number;
        title: string;
        workspacePath: string;
        started: boolean;
        error?: string;
      }>;
    };
    const listing = result.results
      .map((r) => {
        const status = r.error
          ? `(failed: ${r.error})`
          : r.started
            ? "(agent started)"
            : "(workspace created)";
        return `#${r.number} → ${r.workspacePath} ${status}`;
      })
      .join("\n");
    return text(listing);
  },
};

export const agentsModule: ToolModule = { tools, handlers };

/**
 * MCP tools for GitHub issues and agent launching.
 */

import { resolveProjectId } from "./context";
// Type-only: `issue-sources.ts` is pure, and the edge erases at runtime, so the
// MCP process stays Electron-free while sharing the one wire shape.
import type { McpIssue, McpIssueDetail } from "../issue-sources";
import type { ToolDef, ToolModule } from "./types";
import { text } from "./types";

/** Shared by every tool that takes an optional, inferrable project. */
const PROJECT_ID_PROP = {
  type: "string",
  description: "Project ID. Defaults to the project this agent is running in.",
} as const;

/** Shared by every tool that reads issues. The routes 400 on anything else. */
const ISSUE_SOURCE_PROP = {
  type: "string",
  enum: ["github", "linear"],
  description: "Issue source: 'github' (default) or 'linear'.",
} as const;

// ── Tool definitions ──

const tools: ToolDef[] = [
  {
    name: "list_issues",
    description: "List a project's issues from GitHub (default) or Linear.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
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
        source: ISSUE_SOURCE_PROP,
      },
    },
  },
  {
    name: "get_issue_detail",
    description:
      "Read a single issue's full detail, including its description body. Works for GitHub and Linear.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        issue: {
          type: "string",
          description:
            "Issue ref exactly as returned by list_issues: '#42' for GitHub, 'ENG-123' for Linear.",
        },
        source: ISSUE_SOURCE_PROP,
      },
      required: ["issue"],
    },
  },
  {
    name: "start_agent",
    description:
      "Launch an agent session in a workspace, optionally with an initial prompt. Fire-and-forget: returns once the launch is dispatched.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        workspacePath: {
          type: "string",
          description: "Filesystem path of the workspace to launch the agent in.",
        },
        prompt: {
          type: "string",
          description: "Optional initial prompt for the agent.",
        },
      },
      required: ["workspacePath"],
    },
  },
  {
    name: "batch_create_workspaces",
    description:
      "Create one workspace per GitHub issue and (by default) launch an agent in each — fan a backlog out into parallel agent workspaces.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: PROJECT_ID_PROP,
        issues: {
          type: "array",
          items: { type: "number" },
          description: "GitHub issue numbers to create workspaces for.",
        },
        source: {
          type: "string",
          enum: ["github"],
          description:
            "Issue source. Only 'github' is supported; Linear issues are rejected.",
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
      required: ["issues"],
    },
  },
];

// ── Tool handlers ──

const handlers: ToolModule["handlers"] = {
  async list_issues(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const params = new URLSearchParams();
    if (args.filter !== undefined) params.set("filter", String(args.filter));
    if (args.state !== undefined) params.set("state", String(args.state));
    if (args.limit !== undefined) params.set("limit", String(args.limit));
    if (args.source !== undefined) params.set("source", String(args.source));
    const qs = params.toString();
    const issues = (await http.get(
      `/projects/${encodeURIComponent(projectId)}/issues?${qs}`,
    )) as McpIssue[];
    if (issues.length === 0) {
      return text("No issues found.");
    }
    const listing = issues
      .map((issue) => {
        const labels =
          issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
        return `${issue.ref} ${issue.title}${labels}`;
      })
      .join("\n");
    return text(listing);
  },

  async get_issue_detail(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const issue = args.issue as string;
    const params = new URLSearchParams();
    if (args.source !== undefined) params.set("source", String(args.source));
    const qs = params.toString();
    const detail = (await http.get(
      `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issue)}?${qs}`,
    )) as McpIssueDetail;
    const lines = [`${detail.ref} ${detail.title}`, `State: ${detail.state}`];
    if (detail.labels.length > 0) {
      lines.push(`Labels: ${detail.labels.join(", ")}`);
    }
    if (detail.assignees.length > 0) {
      lines.push(`Assignees: ${detail.assignees.join(", ")}`);
    }
    lines.push(`URL: ${detail.url}`);
    lines.push("");
    lines.push(detail.body && detail.body.length > 0 ? detail.body : "(no description)");
    return text(lines.join("\n"));
  },

  async start_agent(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const body: Record<string, unknown> = {
      projectId,
      workspacePath: args.workspacePath,
    };
    if (args.prompt !== undefined) body.prompt = args.prompt;
    await http.post("/agents", body);
    return text(`Launched agent in ${args.workspacePath}.`);
  },

  async batch_create_workspaces(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const body: Record<string, unknown> = { issues: args.issues };
    if (args.source !== undefined) body.source = args.source;
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

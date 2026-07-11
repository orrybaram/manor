/**
 * MCP tools for session state (ADR-153): `list_tasks` lets the orchestrator
 * *see* every session Manor knows about — `send_to_session` (ticket 3) will
 * live in this same module and let it *steer* one.
 */

// Type-only: `routes/tasks.ts` is pure data shaping over `TaskManager`, and the
// edge erases at runtime, so the MCP process stays Electron-free while
// sharing the one wire shape.
import type { TaskSummary } from "../routes/tasks";
import type { ToolDef, ToolModule } from "./types";
import { text } from "./types";

// ── Tool definitions ──

const tools: ToolDef[] = [
  {
    name: "list_tasks",
    description:
      "See every agent session Manor knows about — across every project and workspace, not just the one this agent is running in. Each row shows a stable handle (the task id) plus its live status, project, and pane. With no filters, only active sessions are returned. The handle is reusable as the 'target' for send_to_session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description:
            "Restrict to sessions in this project. Omit to see every project.",
        },
        status: {
          type: "string",
          enum: ["active", "completed", "error", "abandoned"],
          description:
            "Restrict to sessions with this lifecycle status. Omit (with no other filter) to default to 'active'.",
        },
        limit: {
          type: "number",
          description: "Maximum number of sessions to return.",
        },
      },
    },
  },
];

// ── Formatting ──

/** A stable, human-readable handle for a task — reusable as send_to_session's target. */
function handleFor(task: TaskSummary): string {
  return task.name ? `${task.id} (${task.name})` : task.id;
}

function formatTask(task: TaskSummary): string {
  const project = task.projectName ?? task.projectId ?? "no project";
  const status = task.lastAgentStatus ?? task.status;
  const pane = task.paneId ?? "no pane";
  return `${handleFor(task)}  [${status}]  ${project}  pane:${pane}`;
}

// ── Tool handlers ──

const handlers: ToolModule["handlers"] = {
  async list_tasks(args, http) {
    const params = new URLSearchParams();
    if (args.projectId !== undefined) params.set("projectId", String(args.projectId));
    if (args.status !== undefined) params.set("status", String(args.status));
    if (args.limit !== undefined) params.set("limit", String(args.limit));
    const qs = params.toString();
    const tasks = (await http.get(`/tasks?${qs}`)) as TaskSummary[];
    if (tasks.length === 0) {
      return text("No sessions found.");
    }
    return text(tasks.map(formatTask).join("\n"));
  },
};

export const tasksModule: ToolModule = { tools, handlers };

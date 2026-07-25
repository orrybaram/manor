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

/** The wire shape `POST /sessions/send` returns. */
interface SendResult {
  ok: boolean;
  target: { id: string; paneId: string; lastAgentStatus: string | null };
}

/** The wire shape `POST /sessions/read` returns. */
interface ReadResult {
  ok: boolean;
  target: { id: string; paneId: string; lastAgentStatus: string | null };
  source: "live" | "scrollback";
  text: string;
  lineCount: number;
  truncated: boolean;
}

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
  {
    name: "send_to_session",
    description:
      "Steer another running agent session: gracefully interrupt its current turn, then inject a new prompt. This INTERRUPTS the target — it ends whatever the agent is currently doing (without killing the process) and may discard its in-flight work, so use it deliberately. Check the target's status with list_tasks first; the response reports the target's status as it was just before the interrupt so you can tell whether you cut off a working agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string",
          description:
            "Which session to steer. Accepts a task id (from list_tasks), a raw pane id, '#<issue>', or a workspace branch.",
        },
        text: {
          type: "string",
          description: "The new prompt to submit after interrupting the target.",
        },
        interrupt: {
          type: "string",
          description:
            "Optional override for the interrupt key sequence, for custom harnesses. Omit to use the harness default.",
        },
      },
      required: ["target", "text"],
    },
  },
  {
    name: "read_session",
    description:
      "Read another session's rendered output (its conversation/transcript) by the handle list_tasks returns. Plain text by default; pass raw:true for the ANSI stream. Read-only — does not touch the session. Works for running sessions (live rendered buffer) and ended ones (persisted scrollback).",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string",
          description:
            "Which session to read. Accepts a task id (from list_tasks), a raw pane id, '#<issue>', or a workspace branch.",
        },
        tailLines: {
          type: "number",
          description: "How many trailing lines to return. Defaults to 200.",
        },
        maxBytes: {
          type: "number",
          description: "Additionally cap the returned text to this many bytes, from the end.",
        },
        raw: {
          type: "boolean",
          description: "Return the raw ANSI stream instead of plain (stripped) text.",
        },
      },
      required: ["target"],
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

  async send_to_session(args, http) {
    const res = (await http.post("/sessions/send", {
      target: args.target,
      text: args.text,
      interrupt: args.interrupt,
    })) as SendResult;

    const status = res.target.lastAgentStatus ?? "unknown";
    return text(
      `Interrupted session ${res.target.id} (was ${status}) and sent the new prompt.`,
    );
  },

  async read_session(args, http) {
    const res = (await http.post("/sessions/read", {
      target: args.target,
      tailLines: args.tailLines,
      maxBytes: args.maxBytes,
      raw: args.raw,
    })) as ReadResult;

    const header = `source=${res.source} lines=${res.lineCount}${res.truncated ? " (truncated)" : ""}`;
    return text(`${header}\n\n${res.text}`);
  },
};

export const tasksModule: ToolModule = { tools, handlers };

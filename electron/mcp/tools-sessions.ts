/**
 * MCP tools for session state (ADR-153): `list_agents` lets the orchestrator
 * *see* every session Manor knows about — `send_to_session` (ticket 3) will
 * live in this same module and let it *steer* one.
 */

// Type-only: `routes/agents.ts` is pure data shaping over `AgentManager`, and the
// edge erases at runtime, so the MCP process stays Electron-free while
// sharing the one wire shape.
import type { AgentSummary } from "../routes/agents";
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
  target: {
    id: string;
    paneId: string;
    lastAgentStatus: string | null;
    kind: "session" | "pane";
  };
  source: "live" | "scrollback";
  text: string;
  lineCount: number;
  truncated: boolean;
}

// ── Tool definitions ──

const tools: ToolDef[] = [
  {
    name: "list_agents",
    description:
      "See every agent session Manor knows about — across every project and workspace, not just the one this agent is running in. Each row shows a stable handle (the agent id) plus its live status, project, and pane. With no filters, only active sessions are returned. The handle is reusable as the 'target' for send_to_session.",
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
      "Steer another running agent session: gracefully interrupt its current turn, then inject a new prompt. This INTERRUPTS the target — it ends whatever the agent is currently doing (without killing the process) and may discard its in-flight work, so use it deliberately. Check the target's status with list_agents first; the response reports the target's status as it was just before the interrupt so you can tell whether you cut off a working agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string",
          description:
            "Which session to steer. Accepts an agent id (from list_agents), a raw pane id, '#<issue>', or a workspace branch.",
        },
        text: {
          type: "string",
          description:
            "The new prompt to submit after interrupting the target.",
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
      "Read any terminal pane's rendered output — an agent session's conversation/transcript, or a plain terminal's scrollback. Targets accept an agent handle from list_agents OR a raw paneId from list_panes, so panes that were never started as agent sessions are readable too. Plain text by default; pass raw:true for the ANSI stream. Read-only — does not touch the pane. Works for live panes (rendered buffer, up to 10k lines of scrollback) and ended ones (persisted scrollback). Returns the last 200 lines by default — raise tailLines to read further back.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string",
          description:
            "Which pane to read. Accepts an agent id (from list_agents), a raw paneId (from list_panes — including plain, non-agent terminals), '#<issue>', or a workspace branch.",
        },
        tailLines: {
          type: "number",
          description:
            "How many trailing lines to return. Defaults to 200; raise it (e.g. 5000) to read the full scrollback.",
        },
        maxBytes: {
          type: "number",
          description:
            "Additionally cap the returned text to this many bytes, from the end.",
        },
        raw: {
          type: "boolean",
          description:
            "Return the raw ANSI stream instead of plain (stripped) text.",
        },
      },
      required: ["target"],
    },
  },
];

// ── Formatting ──

/** A stable, human-readable handle for an agent — reusable as send_to_session's target. */
function handleFor(agent: AgentSummary): string {
  return agent.name ? `${agent.id} (${agent.name})` : agent.id;
}

function formatAgent(agent: AgentSummary): string {
  const project = agent.projectName ?? agent.projectId ?? "no project";
  const status = agent.lastAgentStatus ?? agent.status;
  const pane = agent.paneId ?? "no pane";
  return `${handleFor(agent)}  [${status}]  ${project}  pane:${pane}`;
}

// ── Tool handlers ──

const handlers: ToolModule["handlers"] = {
  async list_agents(args, http) {
    const params = new URLSearchParams();
    if (args.projectId !== undefined)
      params.set("projectId", String(args.projectId));
    if (args.status !== undefined) params.set("status", String(args.status));
    if (args.limit !== undefined) params.set("limit", String(args.limit));
    const qs = params.toString();
    const agents = (await http.get(`/agents?${qs}`)) as AgentSummary[];
    if (agents.length === 0) {
      return text("No sessions found.");
    }
    return text(agents.map(formatAgent).join("\n"));
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

    const header = `${res.target.kind}=${res.target.id} source=${res.source} lines=${res.lineCount}${res.truncated ? " (truncated)" : ""}`;
    return text(`${header}\n\n${res.text}`);
  },
};

export const sessionsModule: ToolModule = { tools, handlers };

/**
 * MCP tools for session state: `list_agents` lets the orchestrator
 * *see* every session Manor knows about, `send_to_session`/`read_session` let
 * it *steer* and *read* one, and `interrupt_session`/`end_session`
 * cover the two ways to stop one — pausing its current turn versus killing
 * the process outright.
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
  /** `/sessions/send` only: whether the agent's turn was stopped first. */
  interrupted?: boolean;
}

/** The wire shape `POST /sessions/end` returns. */
interface EndResult {
  ok: boolean;
  target: { id: string; paneId: string };
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

const INTERRUPT_KEYS_PROP = {
  type: "string",
  description:
    "The key sequence that stops this agent's turn, for custom harnesses. Omit to use the harness default (Esc for Claude, Ctrl-C otherwise).",
};

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
        workspace: {
          type: "string",
          description:
            "Restrict to agents in this workspace: its full path, or its last path segment (usually the branch).",
        },
        pane: {
          type: "string",
          description: "Restrict to the agent in this pane.",
        },
        all: {
          type: "boolean",
          description:
            "Also list agents with no pane (records of sessions whose terminal is gone). Hidden by default: there is nothing to read or steer.",
        },
      },
    },
  },
  {
    name: "send_to_session",
    description:
      "Send a prompt to another running agent session and submit it. If the agent is mid-turn (working, or waiting on a question), its turn is interrupted first — without killing the process — which may discard in-flight work; pass queue to let the turn finish instead. An idle agent is not interrupted. The response says whether it interrupted and the target's status just before.",
    positional: "text",
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
            "The prompt to submit. Also accepted as the command's bare argument.",
        },
        queue: {
          type: "boolean",
          description:
            "Don't interrupt a busy agent: submit the prompt for it to run once its turn ends.",
        },
        interruptKeys: INTERRUPT_KEYS_PROP,
      },
      required: ["target", "text"],
    },
  },
  {
    name: "interrupt_session",
    description:
      "Stop a running agent without saying anything to it: gracefully ends its current turn, leaving the process alive and idle. Less disruptive than end_session — the agent can still be resumed or steered with send_to_session — but may still discard in-flight work if it was mid-turn. Check the target's status with list_agents first; the response reports the target's status as it was just before the interrupt.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string",
          description:
            "Which session to stop. Accepts an agent id (from list_agents), a raw pane id, '#<issue>', or a workspace branch.",
        },
        interruptKeys: INTERRUPT_KEYS_PROP,
      },
      required: ["target"],
    },
  },
  {
    name: "end_session",
    description:
      "Destructive: kill a running agent's process outright, ending the session for good — not just its current turn. Unlike interrupt_session, the process does not survive this and any in-flight work is lost; there is nothing left to resume. The agent's Manor record is marked abandoned, not removed — use delete_agent afterward to also drop it from list_agents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string",
          description:
            "Which session to end. Accepts an agent id (from list_agents), a raw pane id, '#<issue>', or a workspace branch.",
        },
      },
      required: ["target"],
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
  const workspace = agent.workspacePath ? `  ws:${lastSegment(agent.workspacePath)}` : "";
  return `${handleFor(agent)}  [${status}]  ${project}${workspace}  pane:${pane}`;
}

function lastSegment(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() ?? p;
}

/** `workspace` names this agent's workspace: its whole path or last segment. */
function inWorkspace(agent: AgentSummary, workspace: string): boolean {
  const ws = agent.workspacePath;
  if (!ws) return false;
  const want = workspace.replace(/\/+$/, "");
  return ws.replace(/\/+$/, "") === want || lastSegment(ws) === want;
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
    const fetched = (await http.get(`/agents?${qs}`)) as AgentSummary[];
    const matching = fetched.filter(
      (a) =>
        (args.workspace === undefined || inWorkspace(a, String(args.workspace))) &&
        (args.pane === undefined || a.paneId === args.pane),
    );
    const agents = args.all === true ? matching : matching.filter((a) => a.paneId !== null);
    const hidden = matching.length - agents.length;
    const note = hidden > 0 ? `\n(${hidden} without a pane hidden; --all shows them)` : "";
    if (agents.length === 0) {
      return text(`No sessions found.${note}`);
    }
    return text(agents.map(formatAgent).join("\n") + note);
  },

  async send_to_session(args, http) {
    const res = (await http.post("/sessions/send", {
      target: args.target,
      text: args.text,
      queue: args.queue,
      interruptKeys: args.interruptKeys,
    })) as SendResult;

    const status = res.target.lastAgentStatus ?? "unknown";
    return text(
      res.interrupted
        ? `Interrupted session ${res.target.id} (was ${status}) and submitted the prompt.`
        : `Submitted the prompt to session ${res.target.id} (was ${status}; not interrupted).`,
    );
  },

  async interrupt_session(args, http) {
    const res = (await http.post("/sessions/interrupt", {
      target: args.target,
      interruptKeys: args.interruptKeys,
    })) as SendResult;

    const status = res.target.lastAgentStatus ?? "unknown";
    return text(`Interrupted session ${res.target.id} (was ${status}).`);
  },

  async end_session(args, http) {
    const res = (await http.post("/sessions/end", {
      target: args.target,
    })) as EndResult;

    return text(
      `Ended session ${res.target.id} (pane ${res.target.paneId}) — process killed.`,
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

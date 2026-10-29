/**
 * The shell's whole world: a few agents in a few workspaces. One state object
 * drives the sidebar, tab, agents list and panes, so a status changed in a
 * pane shows up everywhere at once. Each mount gets its own copy.
 */

export type AgentStatus = "thinking" | "working" | "requires_input" | "responded" | "error" | "idle";

export type AgentId = "hero" | "gtf" | "sweep" | "suite" | "cron" | "flood" | "pr";

export type Agent = {
  title: string;
  kind: "claude" | "codex" | "opencode";
  ws: string;
  status: AgentStatus;
  /** Seconds on Claude's "Composing…" timer. */
  secs: number;
  /** Lines the agent has added since the page loaded, as terminal HTML. */
  log: string[];
};

export type Workspace = {
  id: string;
  branch: string;
  panes: AgentId[];
  local?: boolean;
};

export type ShellState = {
  agents: Record<AgentId, Agent>;
  workspaces: Workspace[];
  /** The open workspace's id. */
  ws: string;
  focus: AgentId | null;
  /** What's been typed into "Automations suite" and not yet sent. */
  typing: string;
  /** Ambient frame count: spinners and the sweep's progress read it. */
  tick: number;
};

const RANK: Record<AgentStatus, number> = { requires_input: 5, error: 4, working: 3, thinking: 3, responded: 2, idle: 1 };

const agent = (title: string, kind: Agent["kind"], ws: string, status: AgentStatus, secs = 0): Agent => ({
  title, kind, ws, status, secs, log: [],
});

export function createState(initial: { focus?: AgentId | null } = {}): ShellState {
  return {
    agents: {
      hero: agent("Build the hero", "claude", "homepage", "working", 38),
      gtf: agent("Wire up Go to File", "codex", "homepage", "requires_input"),
      sweep: agent("Temperature sweep", "opencode", "homepage", "thinking"),
      suite: agent("Automations suite", "claude", "homepage", "responded"),
      cron: agent("Cron catch-up", "claude", "automations", "responded"),
      flood: agent("Flood benchmark", "claude", "bench-flood", "error"),
      pr: agent("Go to File PR", "claude", "go-to-file", "responded"),
    },
    workspaces: [
      { id: "local", branch: "main", panes: [], local: true },
      { id: "automations", branch: "automations", panes: ["cron"] },
      { id: "bench-flood", branch: "bench-flood", panes: ["flood"] },
      { id: "go-to-file", branch: "go-to-file", panes: ["pr"] },
      { id: "homepage", branch: "homepage", panes: ["hero", "gtf", "sweep", "suite"] },
    ],
    ws: "homepage",
    focus: initial.focus === undefined ? "hero" : initial.focus,
    typing: "",
    tick: 0,
  };
}

/** The loudest status among a workspace's panes, or null for an empty one. */
export function workspaceStatus(state: ShellState, w: Workspace): AgentStatus | null {
  let best: AgentStatus | null = null;
  for (const id of w.panes) {
    const s = state.agents[id].status;
    if (!best || RANK[s] > RANK[best]) best = s;
  }
  return best;
}

export function openWorkspace(state: ShellState): Workspace {
  return state.workspaces.find((w) => w.id === state.ws) ?? state.workspaces[0]!;
}

export function isAgentId(state: ShellState, id: string | undefined): id is AgentId {
  return id !== undefined && Object.hasOwn(state.agents, id);
}

/**
 * The shell's whole world: a few Agents in a few workspaces of a project. One
 * state object drives the sidebar, tab, agents list and panes, so a status
 * changed in a pane shows up everywhere at once. Each mount gets its own copy.
 *
 * The status rules are the app's: `AgentStatus` and the rollup from
 * apps/desktop/src/store/agent-rollup.ts, the sidebar's collapse from
 * apps/desktop/src/lib/workspace-indicator.ts.
 */

export type AgentStatus = "thinking" | "working" | "requires_input" | "responded" | "error" | "idle";

export type AgentKind = "claude" | "codex" | "pi" | "opencode";

export type AgentId = "hero" | "gtf" | "sweep" | "suite" | "cron" | "flood" | "pr";

export type Agent = {
  title: string;
  kind: AgentKind;
  /** The workspace whose pane it runs in. */
  ws: string;
  status: AgentStatus;
  /** Its status changed off screen and hasn't been looked at: this is what makes a dot pulse. */
  unseen: boolean;
  /** Seconds on Claude's "Composing…" timer. */
  secs: number;
  /** Rows the agent has added since the page loaded, as terminal HTML. */
  log: string[];
};

export type Workspace = {
  id: string;
  branch: string;
  panes: AgentId[];
  /** The project's main checkout: named "local", with a branch icon. */
  isMain?: boolean;
};

export type Project = {
  name: string;
  /** A palette variable's name (`cyan` gives `var(--cyan)`), as `project.color` is in the app. */
  color: string;
  workspaces: Workspace[];
};

export type ShellState = {
  agents: Record<AgentId, Agent>;
  projects: Project[];
  /** The open workspace's id. */
  ws: string;
  focus: AgentId | null;
  /** What's been typed into "Automations suite" and not yet sent. */
  typing: string;
  /** Ambient frame count: spinners and the sweep's progress read it. */
  tick: number;
};

/** The one Agent status a dot shows for a set of panes, and whether it pulses. */
export type AgentRollup = { status: AgentStatus | null; pulse: boolean };

export type WorkspaceIndicator = { kind: "thinking" | "working" | "needs_you" | "done_unread"; pulse: boolean } | null;

const STATUS_PRIORITY: Record<AgentStatus, number> = {
  requires_input: 5,
  working: 4,
  thinking: 3,
  error: 2,
  responded: 1,
  idle: 0,
};

const agent = (title: string, kind: AgentKind, ws: string, status: AgentStatus, secs = 0, unseen = false): Agent => ({
  title, kind, ws, status, unseen, secs, log: [],
});

export function createState(initial: { focus?: AgentId | null } = {}): ShellState {
  return {
    agents: {
      hero: agent("Build the hero", "claude", "homepage", "working", 38),
      gtf: agent("Wire up Go to File", "codex", "homepage", "requires_input"),
      sweep: agent("Temperature sweep", "opencode", "homepage", "thinking"),
      suite: agent("Automations suite", "claude", "homepage", "responded"),
      cron: agent("Cron catch-up", "claude", "automations", "responded", 0, true),
      flood: agent("Flood benchmark", "claude", "bench-flood", "error"),
      pr: agent("Go to File PR", "claude", "go-to-file", "responded", 0, true),
    },
    projects: [
      {
        name: "manor",
        color: "cyan",
        workspaces: [
          { id: "local", branch: "main", panes: [], isMain: true },
          { id: "automations", branch: "automations", panes: ["cron"] },
          { id: "bench-flood", branch: "bench-flood", panes: ["flood"] },
          { id: "go-to-file", branch: "go-to-file", panes: ["pr"] },
          { id: "homepage", branch: "homepage", panes: ["hero", "gtf", "sweep", "suite"] },
        ],
      },
    ],
    ws: "homepage",
    focus: initial.focus === undefined ? "hero" : initial.focus,
    typing: "",
    tick: 0,
  };
}

const onScreen = (state: ShellState, a: Agent) => a.ws === state.ws;

/** A dot pulses only for a status that's unseen and off screen: a pane on screen has been read. */
export function agentPulse(state: ShellState, a: Agent): boolean {
  return a.unseen && !onScreen(state, a) && (a.status === "responded" || a.status === "requires_input");
}

/** Change an Agent's status; off screen, a finished turn or a question waits to be seen. */
export function setAgentStatus(state: ShellState, id: AgentId, status: AgentStatus): void {
  const a = state.agents[id];
  a.status = status;
  a.unseen = (status === "responded" || status === "requires_input") && !onScreen(state, a);
}

/** The loudest status among some panes; on a tie, an unseen one wins. */
export function rollup(state: ShellState, ids: readonly AgentId[]): AgentRollup {
  let best: Agent | null = null;
  for (const id of ids) {
    const a = state.agents[id];
    if (a.status === "idle") continue;
    if (
      !best ||
      STATUS_PRIORITY[a.status] > STATUS_PRIORITY[best.status] ||
      (a.status === best.status && agentPulse(state, a) && !agentPulse(state, best))
    ) {
      best = a;
    }
  }
  return { status: best?.status ?? null, pulse: best ? agentPulse(state, best) : false };
}

/** The sidebar's dot answers one question, "does this workspace need me?", in four states plus quiet. */
export function toWorkspaceIndicator({ status, pulse }: AgentRollup): WorkspaceIndicator {
  switch (status) {
    case "thinking":
    case "working":
      return { kind: status, pulse: false };
    case "requires_input":
      return { kind: "needs_you", pulse };
    case "error":
      return { kind: "needs_you", pulse: false };
    case "responded":
      return pulse ? { kind: "done_unread", pulse: true } : null;
    default:
      return null;
  }
}

function allWorkspaces(state: ShellState): Workspace[] {
  return state.projects.flatMap((p) => p.workspaces);
}

export function openWorkspace(state: ShellState): Workspace {
  const all = allWorkspaces(state);
  return all.find((w) => w.id === state.ws) ?? all[0]!;
}

export function projectOf(state: ShellState, workspaceId: string): Project {
  return state.projects.find((p) => p.workspaces.some((w) => w.id === workspaceId)) ?? state.projects[0]!;
}

/** Open a workspace, which reads whatever its Agents had waiting. */
export function selectWorkspace(state: ShellState, id: string, focus?: AgentId): void {
  const w = allWorkspaces(state).find((x) => x.id === id);
  if (!w) return;
  state.ws = w.id;
  state.focus = focus ?? w.panes[0] ?? null;
  for (const paneId of w.panes) state.agents[paneId].unseen = false;
}

export function isAgentId(state: ShellState, id: string | undefined): id is AgentId {
  return id !== undefined && Object.hasOwn(state.agents, id);
}

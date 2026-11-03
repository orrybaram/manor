import type { AgentManager } from "../agent-persistence";
import type { LayoutStore } from "../layout/layout-store";
import type { PaneFacts } from "../terminal-host/types";
import { allPaneIds } from "../../src/lib/layout/pane-tree";
import { LOCAL_HOST_ID, workspaceKey } from "../../src/lib/workspace-key";
import type { Automation, AutomationAgentKind, AutomationRun } from "../../src/lib/automations";
import { findAgent, type RunAgentDeps } from "./run-agent";
import type { AutomationFireResult } from "./scheduler";

/**
 * A same-pane run: the automation's prompt sent to the agent pane its last run
 * left, instead of a new tab.
 *
 * Nothing is typed unless the pane's agent is at its prompt: a prompt must not
 * land in a shell, in a permission dialog, or in a turn in progress. So a run
 * either sends, or skips while the agent is occupied, or (null) leaves it to
 * the caller to open a new tab, which later runs then use: the pane has closed,
 * the agent has exited to its shell, or it is another kind of agent now.
 *
 * Unlike the scheduler's overlap check this also counts Needs input, and it is
 * also what a Run now goes through.
 */

/**
 * What starts a new conversation in each agent's TUI. Only `claude`'s has
 * been run from here; the others are from their CLIs' documentation.
 */
const CLEAR_COMMAND: Record<AutomationAgentKind, string> = {
  claude: "/clear",
  codex: "/new",
  pi: "/new",
  opencode: "/new",
};

/** An agent launched this recently with no Agent record yet is still starting. */
const STARTING_MS = 60_000;
/** A run this recent may not have reported its turn yet, Agent record or not. */
const JUST_SENT_MS = 5_000;
/** How long a clear gets to replace the root session. The prompt follows regardless. */
const CLEAR_TIMEOUT_MS = 5_000;
/** A TUI that sends no hooks: the wait before typing after its clear. */
const UNHOOKED_CLEAR_MS = 1_000;
/** From a clear's new session to its prompt being ready for input. */
const SETTLE_MS = 300;
const POLL_MS = 100;

export interface PaneSenderDeps extends RunAgentDeps {
  agentManager: RunAgentDeps["agentManager"] & Pick<AgentManager, "getAgentByPaneId">;
  lastStartedRun: (automationId: string) => AutomationRun | null;
  layout: Pick<LayoutStore, "get">;
  /** The pane's facts, or null when its host has no such session. */
  paneFacts: (paneId: string) => Promise<PaneFacts | null>;
  typeIntoPane: (paneId: string, text: string) => Promise<void>;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createPaneSender(
  deps: PaneSenderDeps,
): (automation: Automation, workspacePath: string) => Promise<AutomationFireResult | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** Automations mid-send: a Run now during a clear's wait must not type too. */
  const sending = new Set<string>();

  return async (automation, workspacePath) => {
    const run = deps.lastStartedRun(automation.id);
    const paneId = run?.paneId;
    if (!run || !paneId || run.workspacePath !== workspacePath) return null;
    if (!paneInWorkspace(deps, paneId, workspacePath)) return null;
    const facts = await deps.paneFacts(paneId);
    if (!facts) return null;

    const skip = (reason: AutomationRun["reason"], detail: string): AutomationFireResult => ({
      outcome: "skipped",
      reason,
      detail,
      paneId,
      workspacePath,
    });
    const starting = skip("agent-starting", "The agent is still starting");
    if (sending.has(automation.id)) return starting;

    const foreground = facts.foreground;
    if (!foreground) return isStarting(deps, run) ? starting : null;
    if (foreground.kind && foreground.kind !== automation.agentKind) return null;

    const state = deps.agentStatus.getPaneState(paneId);
    const status = state?.status ?? null;
    if (status === "thinking" || status === "working") {
      return skip("still-working", "The previous run is still working");
    }
    if (status === "requires_input") return skip("waiting-for-input", "The agent is waiting for input");
    // Not the agent itself, and no turn that explains it: the user's program.
    if (!foreground.kind) return skip("still-working", "The pane is running something else");
    if (isStarting(deps, run)) return starting;

    sending.add(automation.id);
    try {
      const fresh = automation.workspace.mode === "reuse" && automation.workspace.pane === "fresh";
      // Named now: clearing retires this Agent, and the run's is the next one.
      const agent = fresh ? null : deps.agentManager.getAgentByPaneId(paneId);
      if (fresh) {
        await deps.typeIntoPane(paneId, CLEAR_COMMAND[automation.agentKind]);
        await waitForNewSession(deps, sleep, paneId, state?.rootSessionId ?? null);
      }
      await deps.typeIntoPane(paneId, automation.prompt);
      return {
        outcome: "started",
        sentToPane: true,
        paneId,
        workspacePath,
        ...(agent ? { agentId: agent.id } : {}),
      };
    } finally {
      sending.delete(automation.id);
    }
  };
}

function paneInWorkspace(deps: Pick<PaneSenderDeps, "layout">, paneId: string, workspacePath: string): boolean {
  const entry = deps.layout.get(workspaceKey(LOCAL_HOST_ID, workspacePath));
  if (!entry) return false;
  return Object.values(entry.layout.panels).some((panel) =>
    panel.tabs.some((tab) => allPaneIds(tab.rootNode).includes(paneId)),
  );
}

function isStarting(deps: PaneSenderDeps, run: AutomationRun): boolean {
  const age = deps.now() - Date.parse(run.firedAt);
  return age < JUST_SENT_MS || (age < STARTING_MS && !findAgent(deps, run));
}

/** Until a clear has replaced the pane's root session, or it has had its time. */
async function waitForNewSession(
  deps: Pick<PaneSenderDeps, "agentStatus">,
  sleep: (ms: number) => Promise<void>,
  paneId: string,
  rootBefore: string | null,
): Promise<void> {
  if (rootBefore === null) {
    await sleep(UNHOOKED_CLEAR_MS);
    return;
  }
  for (let waited = 0; waited < CLEAR_TIMEOUT_MS; waited += POLL_MS) {
    const root = deps.agentStatus.getPaneState(paneId)?.rootSessionId ?? null;
    if (root !== null && root !== rootBefore) break;
    await sleep(POLL_MS);
  }
  await sleep(SETTLE_MS);
}

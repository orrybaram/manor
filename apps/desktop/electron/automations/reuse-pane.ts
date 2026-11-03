import type { AgentManager } from "../agent-persistence";
import type { PaneAgentState } from "../agent-status/types";
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
 * Unlike the scheduler's overlap check this also counts Needs input, a turn
 * that went quiet without ending (`stalled`, which may yet resume) and a pane
 * whose state isn't known yet, and it is also what a Run now goes through.
 *
 * A `fresh` run types its prompt only once the clear has taken: when the agent
 * reports sessions, a new one must have started, and in any case no turn may
 * have. Otherwise the run fails where it can be seen, rather than continue the
 * old conversation or type into whatever the clear did instead.
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
/** How long a clear gets to replace the root session. */
const CLEAR_TIMEOUT_MS = 5_000;
/** A TUI that sends no hooks: the wait before typing after its clear. */
const UNHOOKED_CLEAR_MS = 1_000;
/** From a clear's new session to its prompt being ready for input. */
const SETTLE_MS = 300;
const POLL_MS = 100;

export interface PaneSenderDeps extends RunAgentDeps {
  agentManager: RunAgentDeps["agentManager"] & Pick<AgentManager, "getAgentByPaneId">;
  lastStartedRun: (automationId: string) => AutomationRun | null;
  /** Names a run's Agent for good, before clearing takes it off the pane. */
  linkRunAgent: (automationId: string, runId: string, agentId: string) => void;
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
    const state = deps.agentStatus.getPaneState(paneId);
    const kind = foreground.kind ?? state?.kind ?? null;
    if (kind && kind !== automation.agentKind) return null;

    // No signal yet (the server has just restarted, say): it could be mid-turn.
    if (!state) return starting;
    if (state.status === "requires_input") return skip("waiting-for-input", "The agent is waiting for input");
    if (inTurn(state)) return skip("still-working", "The previous run is still working");
    // A name we don't know, at rest: the status reconciler calls that the agent
    // gone too, whether it's the user's program or a wrapper around the agent.
    if (!foreground.kind && !state.hookDriven) {
      return skip("still-working", "The pane is running something else");
    }
    if (isStarting(deps, run)) return starting;

    sending.add(automation.id);
    try {
      const fresh = automation.workspace.mode === "reuse" && automation.workspace.pane === "fresh";
      if (fresh) {
        // Clearing takes this Agent off the pane, where the last run finds it.
        const previous = run.agentId ? null : findAgent(deps, run);
        if (previous) deps.linkRunAgent(automation.id, run.id, previous.id);
        await deps.typeIntoPane(paneId, CLEAR_COMMAND[automation.agentKind]);
        if (!(await clearTook(deps, sleep, paneId, state.rootSessionId))) {
          return {
            outcome: "failed",
            reason: "error",
            detail: "The agent didn't start a new conversation, so the prompt wasn't sent",
            paneId,
            workspacePath,
          };
        }
      }
      // A retired Agent keeps its pane until the next one starts: not this run's.
      const current = fresh ? null : deps.agentManager.getAgentByPaneId(paneId);
      const agent = current?.status === "active" ? current : null;
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
  if (age < JUST_SENT_MS) return true;
  // A run sent to an agent found it running; only a launch can still be starting.
  return !run.sentToPane && age < STARTING_MS && !findAgent(deps, run);
}

/**
 * Whether a turn is open or may still be: only `none` and `responded` are the
 * agent at its prompt.
 */
function inTurn(state: PaneAgentState): boolean {
  if (state.status === "thinking" || state.status === "working" || state.status === "requires_input") return true;
  return state.phase !== "none" && state.phase !== "responded";
}

/** Waits out a clear. True when the agent is at its prompt in a new conversation. */
async function clearTook(
  deps: Pick<PaneSenderDeps, "agentStatus">,
  sleep: (ms: number) => Promise<void>,
  paneId: string,
  rootBefore: string | null,
): Promise<boolean> {
  const now = () => deps.agentStatus.getPaneState(paneId);
  if (rootBefore === null) {
    await sleep(UNHOOKED_CLEAR_MS);
  } else {
    let replaced = false;
    for (let waited = 0; waited < CLEAR_TIMEOUT_MS && !replaced; waited += POLL_MS) {
      const root = now()?.rootSessionId ?? null;
      replaced = root !== null && root !== rootBefore;
      if (!replaced) await sleep(POLL_MS);
    }
    if (!replaced) return false;
    await sleep(SETTLE_MS);
  }
  const after = now();
  return !!after && !inTurn(after);
}

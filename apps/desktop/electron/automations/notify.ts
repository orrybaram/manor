import type { NotificationKind, NotificationTarget } from "../notification-store";
import type { Automation, AutomationAgentKind, AutomationRun } from "../../src/lib/automations";

/**
 * What a recorded run says in the server's notification log: a run that
 * started its agent ran, one that could not failed to start. A skipped run
 * says nothing — the run history has it, and a laptop opened after a night
 * of missed runs should not wake to a pile of them.
 *
 * The record points at the automation, not the agent: a run's Agent is made
 * by its first hook, after the run is recorded (`./run-agent.ts`), and the
 * automation's page links each run to its agent.
 */

const AGENT_KIND_LABEL: Record<AutomationAgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  pi: "Pi",
  opencode: "OpenCode",
};

export interface RunNotification {
  kind: NotificationKind;
  title: string;
  body: string;
  target: NotificationTarget;
}

export function runNotification(
  automation: Pick<Automation, "id" | "name" | "agentKind">,
  run: Pick<AutomationRun, "outcome" | "detail">,
  /** The run's workspace as the sidebar names it, when it has one. */
  workspaceName: string | null,
): RunNotification | null {
  const target: NotificationTarget = { type: "automation", automationId: automation.id };
  if (run.outcome === "started") {
    const agent = AGENT_KIND_LABEL[automation.agentKind] ?? "an agent";
    return {
      kind: "automation-ran",
      title: `${automation.name} ran`,
      body: workspaceName ? `Started ${agent} in ${workspaceName}` : `Started ${agent}`,
      target,
    };
  }
  if (run.outcome === "failed") {
    return {
      kind: "automation-failed",
      title: `${automation.name} failed to start`,
      body: run.detail ?? "The run could not start its agent",
      target,
    };
  }
  return null;
}

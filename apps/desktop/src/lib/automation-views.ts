/**
 * Automations as every surface shows them: the HTTP routes, the bridge's
 * `automations.*` and the MCP tools / `manor` CLI all answer these, built by
 * one function in main (`electron/automations/views.ts`).
 *
 * A view is the stored record plus what is true of it now: when it runs
 * next, and each run's live Agent status. A run stores no status of its
 * own; its status is its Agent's, read when the view is built.
 */

import type { AgentStatus } from "../electron";
import type { Automation, AutomationRun } from "./automations";

/** How many upcoming occurrences a view lists. */
export const AUTOMATION_NEXT_RUNS = 3;

export interface AutomationRunView extends AutomationRun {
  /**
   * The run's Agent status now; null when it has none (a skipped or failed
   * run, or a started one whose agent has not reported yet).
   */
  status: AgentStatus | null;
  /** The run's Agent, once its first hook has made one. */
  agentId?: string;
}

export interface AutomationView extends Automation {
  /**
   * The server's host, as the caller knows it: `local` from the server
   * itself, the host's id once the desktop or the renderer's router has
   * stamped it.
   */
  hostId: string;
  /** The next `AUTOMATION_NEXT_RUNS` occurrences, ISO, whether or not it is enabled. */
  nextRuns: string[];
  /** The newest run, or null before the first. */
  lastRun: AutomationRunView | null;
}

/** One automation with its run history, newest first. */
export interface AutomationDetail extends AutomationView {
  runs: AutomationRunView[];
}

/** What `automations.changed` carries: which server's automation changed. */
export interface AutomationsChanged {
  hostId: string;
  automationId: string;
}

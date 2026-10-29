/**
 * Automations: an agent started on a cron schedule by the Manor server that
 * owns the target host. Shared by the renderer and main, so this file imports
 * nothing.
 *
 * Each firing is a **Run**. The store keeps the automation, the server's
 * scheduler decides when to fire it, and every outcome — started, skipped or
 * failed — is recorded as an `AutomationRun`, so nothing the scheduler does is
 * silent.
 */

export type AutomationAgentKind = "claude" | "codex" | "pi" | "opencode";

const AGENT_KINDS: readonly AutomationAgentKind[] = ["claude", "codex", "pi", "opencode"];

/**
 * Where a run's agent starts: a fresh workspace per run (optionally keeping
 * only the last `keepLast` of them), or a new agent tab in one existing
 * workspace.
 */
export type AutomationWorkspace =
  | { mode: "new"; keepLast?: number }
  | { mode: "reuse"; workspacePath: string };

export interface AutomationSchedule {
  /** A 5-field cron expression, read in `timezone`. */
  cron: string;
  /** An IANA zone, e.g. `Europe/London`. */
  timezone: string;
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  schedule: AutomationSchedule;
  projectId: string;
  prompt: string;
  agentKind: AutomationAgentKind;
  workspace: AutomationWorkspace;
  /** How late a missed occurrence may still fire as a catch-up. */
  missedGraceMinutes: number;
  createdAt: string;
  updatedAt: string;
  /**
   * ISO time of the last occurrence the scheduler handled, fired or skipped.
   * Set to the creation time, and reset on resume or a schedule change, so
   * occurrences before then never fire.
   */
  lastScheduledFor: string;
  /** The next occurrence; null while paused. */
  nextRunAt: string | null;
}

/** What create accepts; update takes any part of it. */
export interface AutomationInput {
  name: string;
  /** Defaults to false: a new automation starts paused. */
  enabled?: boolean;
  schedule: AutomationSchedule;
  projectId: string;
  prompt: string;
  agentKind: AutomationAgentKind;
  workspace: AutomationWorkspace;
  /** Defaults to `DEFAULT_MISSED_GRACE_MINUTES`. */
  missedGraceMinutes?: number;
}

export type AutomationRunTrigger = "schedule" | "catch-up" | "manual";

export type AutomationRunOutcome = "started" | "skipped" | "failed";

export type AutomationRunReason =
  | "missed"
  | "still-working"
  | "project-missing"
  | "workspace-failed"
  | "agent-command-missing"
  | "error";

export interface AutomationRun {
  id: string;
  automationId: string;
  /** The occurrence this run is for; for a folded `missed` run, the earliest. */
  scheduledFor: string;
  firedAt: string;
  trigger: AutomationRunTrigger;
  outcome: AutomationRunOutcome;
  reason?: AutomationRunReason;
  /** A human-readable message, e.g. the error a failed run hit. */
  detail?: string;
  /** How many occurrences a `missed` run folds together. */
  missedCount?: number;
  /**
   * The Agent's id, when it is known. A started run usually has none: the
   * Agent record is made by its first hook, after the run is recorded, so
   * the run is linked to it through `paneId` (`runAgent` in
   * `electron/automations/run-agent.ts`).
   */
  agentId?: string;
  /** The pane the run's agent was launched in. */
  paneId?: string;
  workspacePath?: string;
}

/** Twelve hours: a laptop opened the next morning still gets last night's run. */
export const DEFAULT_MISSED_GRACE_MINUTES = 720;

/**
 * Checks what can be checked without a cron parser. The cron is only
 * checked for 5 fields here; main parses it properly (`isValidCron`).
 * Returns the first problem, or null.
 */
export function validateAutomationInput(input: AutomationInput): string | null {
  if (typeof input.name !== "string" || input.name.trim() === "") return "Name is required";
  if (typeof input.prompt !== "string" || input.prompt.trim() === "") return "Prompt is required";
  if (typeof input.projectId !== "string" || input.projectId === "") return "Project is required";
  if (!AGENT_KINDS.includes(input.agentKind)) return `Unknown agent kind: ${String(input.agentKind)}`;
  if (typeof input.schedule?.cron !== "string" || input.schedule.cron.trim().split(/\s+/).length !== 5) {
    return "Cron must have 5 fields: minute hour day-of-month month day-of-week";
  }
  if (!isValidTimezone(input.schedule.timezone)) {
    return `Unknown timezone: ${String(input.schedule.timezone)}`;
  }
  const workspace = input.workspace;
  if (workspace?.mode === "new") {
    if (workspace.keepLast !== undefined && !(Number.isInteger(workspace.keepLast) && workspace.keepLast > 0)) {
      return "Keep last must be a whole number above 0";
    }
  } else if (workspace?.mode === "reuse") {
    if (typeof workspace.workspacePath !== "string" || workspace.workspacePath === "") {
      return "Pick a workspace to reuse";
    }
  } else {
    return "Workspace must be new or reuse";
  }
  const grace = input.missedGraceMinutes;
  if (grace !== undefined && !(Number.isFinite(grace) && grace >= 0)) {
    return "Missed-run grace must be 0 or more minutes";
  }
  return null;
}

function isValidTimezone(timezone: unknown): boolean {
  if (typeof timezone !== "string" || timezone === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

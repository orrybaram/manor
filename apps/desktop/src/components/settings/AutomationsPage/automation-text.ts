/**
 * The Automations page's words: when a run was or will be, what a run did,
 * and its status, from the views main answers with. Pure, so the page and
 * its tests read the same lines. Times are the viewer's own clock.
 */

import type { AgentStatus } from "../../../electron.d";
import type { AutomationAgentKind, AutomationWorkspace } from "../../../lib/automations";
import type { AutomationRunView, AutomationView } from "../../../lib/automation-views";
import { clockTime } from "../../../lib/cron-describe";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const AGENT_KIND_LABEL: Record<AutomationAgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  pi: "pi",
  opencode: "opencode",
};

export const AGENT_KINDS = Object.keys(AGENT_KIND_LABEL) as AutomationAgentKind[];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function time(d: Date): string {
  return clockTime(d.getHours(), d.getMinutes());
}

/** "Today 14:15", "Tomorrow 09:00", "Thu 09:00", "3 Nov 09:00". */
export function relativeWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  if (days === 0) return `Today ${time(d)}`;
  if (days === 1) return `Tomorrow ${time(d)}`;
  if (days === -1) return `Yesterday ${time(d)}`;
  if (days > 1 && days < 7) return `${DAYS[d.getDay()]} ${time(d)}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${time(d)}`;
}

/** "Thu 30 Oct 09:00". */
export function dayAndTime(date: Date): string {
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${time(date)}`;
}

/** "29 Oct 09:00": a history row's time. */
export function historyTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${time(d)}`;
}

/** How a run's dot and label are coloured. */
export type RunTone = "ok" | "input" | "work" | "skip" | "fail";

export interface RunStatusText {
  label: string;
  tone: RunTone;
}

const STATUS_TEXT: Record<AgentStatus, RunStatusText> = {
  thinking: { label: "Thinking", tone: "work" },
  working: { label: "Working", tone: "work" },
  requires_input: { label: "Needs input", tone: "input" },
  responded: { label: "Responded", tone: "ok" },
  error: { label: "Error", tone: "fail" },
  idle: { label: "Exited", tone: "skip" },
};

/** A run's status: its Agent's for a started run, else what kept it from starting. */
export function runStatusText(run: AutomationRunView): RunStatusText {
  if (run.outcome === "skipped") return { label: "Skipped", tone: "skip" };
  if (run.outcome === "failed") return { label: "Failed to start", tone: "fail" };
  if (run.status) return STATUS_TEXT[run.status];
  // Started, and no live status: its agent has gone, or not reported yet.
  return run.agentId ? { label: "Exited", tone: "skip" } : { label: "Starting", tone: "work" };
}

/** The list's Last run column: "Project missing" outranks the run's own status. */
export function lastRunText(view: AutomationView): RunStatusText | null {
  if (!view.lastRun) return null;
  if (isProjectMissing(view)) return { label: "Project missing", tone: "fail" };
  return runStatusText(view.lastRun);
}

/** The newest run failed because the project isn't on the host any more. */
export function isProjectMissing(view: AutomationView): boolean {
  return view.lastRun?.outcome === "failed" && view.lastRun.reason === "project-missing";
}

/**
 * What a run did, for its history row: "Caught up · host was asleep",
 * "Skipped · previous run still working", "Missed 3 scheduled runs", or the
 * workspace it opened. `workspaceName` names a run's workspace by its path.
 */
export function runWhatText(
  run: AutomationRunView,
  opts: { local: boolean; workspaceName: (path: string) => string | null },
): string {
  if (run.outcome === "skipped") {
    if (run.reason === "missed") {
      const n = run.missedCount ?? 1;
      return n > 1 ? `Missed ${n} scheduled runs` : "Missed a scheduled run";
    }
    if (run.reason === "still-working") return "Skipped · previous run still working";
    return run.detail ?? "Skipped";
  }
  if (run.outcome === "failed") {
    switch (run.reason) {
      case "project-missing":
        return "Project isn't set up on this host";
      case "workspace-failed":
        return run.detail ? `Couldn't make the workspace · ${run.detail}` : "Couldn't make the workspace";
      case "agent-command-missing":
        return "No command to start this agent on this host";
      default:
        return run.detail ?? "Failed to start";
    }
  }
  const where = run.workspacePath ? opts.workspaceName(run.workspacePath) : null;
  if (run.trigger === "catch-up") {
    const why = opts.local ? "Manor was closed" : "host was asleep";
    return `Caught up · ${why}`;
  }
  if (run.trigger === "manual") return where ? `Run now · ${where}` : "Run now";
  return where ? `Opened ${where}` : "Started";
}

/** "new workspace", "reuse “main”". */
export function workspaceChipText(
  workspace: AutomationWorkspace,
  workspaceName: (path: string) => string | null,
): string {
  if (workspace.mode === "new") return "new workspace";
  return `reuse “${workspaceName(workspace.workspacePath) ?? lastSegment(workspace.workspacePath)}”`;
}

export function lastSegment(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The catch-up note under the sentence, or the local-only one for this computer. */
export function scheduleNote(local: boolean, hostName: string, graceMinutes: number): string {
  if (local) return "Runs only while Manor is open on this computer";
  const hours = Math.round((graceMinutes / 60) * 10) / 10;
  return `If ${hostName} is asleep at that time, it runs once when it wakes (within ${hours} h).`;
}

/**
 * The Automations page's words: when a run was or will be, what a run did,
 * and its status, from the views main answers with. Pure, so the page and
 * its tests read the same lines. A run's past times are the viewer's own
 * clock; upcoming ones can be read in the schedule's zone (`timeZone`).
 */

import type { AgentStatus } from "../../../electron.d";
import type { AutomationAgentKind, AutomationWorkspace } from "../../../lib/automations";
import type { AutomationRunView, AutomationView } from "../../../lib/automation-views";
import { clockTime, localTimezone, timezoneLabel } from "../../../lib/cron-describe";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const AGENT_KIND_LABEL: Record<AutomationAgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  pi: "pi",
  opencode: "opencode",
};

export const AGENT_KINDS = Object.keys(AGENT_KIND_LABEL) as AutomationAgentKind[];

/** A moment's calendar fields, in `timeZone` or the viewer's own zone. */
interface Fields {
  /** Days since the epoch of its calendar date, for counting days between. */
  dayNumber: number;
  weekday: number;
  date: number;
  month: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function fieldsOf(d: Date, timeZone?: string): Fields {
  if (!timeZone) {
    return {
      dayNumber: Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000),
      weekday: d.getDay(),
      date: d.getDate(),
      month: d.getMonth(),
      hour: d.getHours(),
      minute: d.getMinutes(),
    };
  }
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    formatters.set(timeZone, format);
  }
  const part = (type: string) =>
    Number(format.formatToParts(d).find((p) => p.type === type)?.value ?? 0);
  const year = part("year");
  const month = part("month") - 1;
  const date = part("day");
  const utc = Date.UTC(year, month, date);
  return {
    dayNumber: Math.round(utc / 86_400_000),
    weekday: new Date(utc).getUTCDay(),
    date,
    month,
    hour: part("hour") % 24,
    minute: part("minute"),
  };
}

function time(f: Fields): string {
  return clockTime(f.hour, f.minute);
}

/**
 * "Today 14:15", "Tomorrow 09:00", "Thu 09:00", "3 Nov 09:00": in
 * `timeZone` when given (today being that zone's), else the viewer's own.
 */
export function relativeWhen(iso: string, now: Date = new Date(), timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const f = fieldsOf(d, timeZone);
  const days = f.dayNumber - fieldsOf(now, timeZone).dayNumber;
  if (days === 0) return `Today ${time(f)}`;
  if (days === 1) return `Tomorrow ${time(f)}`;
  if (days === -1) return `Yesterday ${time(f)}`;
  if (days > 1 && days < 7) return `${DAYS[f.weekday]} ${time(f)}`;
  return `${f.date} ${MONTHS[f.month]} ${time(f)}`;
}

/** "Thu 30 Oct 09:00", in `timeZone` when given. */
export function dayAndTime(date: Date, timeZone?: string): string {
  const f = fieldsOf(date, timeZone);
  return `${DAYS[f.weekday]} ${f.date} ${MONTHS[f.month]} ${time(f)}`;
}

/**
 * "(London time)" beside a schedule's times when its zone isn't the
 * viewer's; null when it is.
 */
export function zoneNote(timeZone: string, viewer: string = localTimezone()): string | null {
  if (sameZone(timeZone, viewer)) return null;
  return `(${timezoneLabel(timeZone)} time)`;
}

function sameZone(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const zone = (tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
    return zone(a) === zone(b);
  } catch {
    return false;
  }
}

/** "29 Oct 09:00": a history row's time. */
export function historyTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const f = fieldsOf(d);
  return `${f.date} ${MONTHS[f.month]} ${time(f)}`;
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

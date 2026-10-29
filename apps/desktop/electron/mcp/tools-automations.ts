/**
 * MCP tools for automations: agents Manor starts on a cron schedule. Thin
 * wrappers over `/automations` (`../routes/automations.ts`), which also give
 * the `manor` CLI `list-automations`, `create-automation` and the rest.
 *
 * Every Manor server keeps and fires its own host's automations, so each
 * tool takes an optional `hostId`: without one it means the server the
 * caller reaches (the desktop's, or a remote box's own when run there); a
 * create goes to its project's host by itself.
 */

import { resolveProjectId } from "./context";
import type { Http, ToolDef, ToolModule } from "./types";
import { text } from "./types";
// Type-only, so the MCP process stays Electron-free.
import type {
  AutomationDetail,
  AutomationRunView,
  AutomationView,
} from "../../src/lib/automation-views";

const HOST_ID_PROP = {
  type: "string",
  description:
    "Host whose automations these are, as list_projects names hosts. Defaults to the Manor server this command reaches.",
} as const;

const ID_PROP = {
  type: "string",
  description: "Automation id, as list_automations shows it.",
} as const;

/** The fields create and update share; update takes any of them. */
const EDITABLE_PROPS = {
  name: { type: "string", description: "A name for the automation, e.g. 'Nightly triage'." },
  cron: {
    type: "string",
    description:
      "When it runs: a 5-field cron expression (minute hour day-of-month month day-of-week), e.g. '0 9 * * 1-5' for weekdays at 09:00.",
  },
  timezone: {
    type: "string",
    description: "IANA timezone the cron is read in, e.g. 'Europe/London'.",
  },
  prompt: { type: "string", description: "What the agent is asked to do on each run." },
  agentKind: {
    type: "string",
    enum: ["claude", "codex", "pi", "opencode"],
    description: "Which agent runs it.",
  },
  workspace: {
    type: "string",
    enum: ["new", "reuse"],
    description:
      "'new' makes a fresh workspace per run in the project's Automations folder; 'reuse' opens a new agent tab in workspacePath.",
  },
  workspacePath: {
    type: "string",
    description: "The workspace a 'reuse' automation runs in (one of the project's workspace paths).",
  },
  keepLast: {
    type: "number",
    description: "For 'new': keep only this many run workspaces. Off when unset.",
  },
  missedGraceMinutes: {
    type: "number",
    description:
      "How late a run missed while the server was down may still fire once as a catch-up. Default 720 (12h).",
  },
} as const;

const tools: ToolDef[] = [
  {
    name: "list_automations",
    description:
      "List automations: agents Manor starts on a cron schedule, with each one's next run and last run.",
    inputSchema: {
      type: "object" as const,
      properties: { hostId: HOST_ID_PROP },
    },
  },
  {
    name: "get_automation",
    description:
      "Show one automation: its schedule, prompt, next runs and run history with each run's agent status.",
    inputSchema: {
      type: "object" as const,
      properties: { id: ID_PROP, hostId: HOST_ID_PROP },
      required: ["id"],
    },
  },
  {
    name: "create_automation",
    description:
      "Create an automation that starts an agent in a project on a cron schedule. It starts paused unless enabled is true; the server on the project's host runs it (a local one only while Manor desktop is open).",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...EDITABLE_PROPS,
        timezone: {
          ...EDITABLE_PROPS.timezone,
          description: `${EDITABLE_PROPS.timezone.description} Defaults to the timezone of the machine running this command, which on a remote box is often UTC: name one to be sure.`,
        },
        agentKind: { ...EDITABLE_PROPS.agentKind, description: "Which agent runs it. Default 'claude'." },
        workspace: {
          ...EDITABLE_PROPS.workspace,
          description: `${EDITABLE_PROPS.workspace.description} Default 'new'.`,
        },
        projectId: {
          type: "string",
          description: "Project the agent runs in. Defaults to the project this agent is running in.",
        },
        enabled: {
          type: "boolean",
          description: "Start it on its schedule straight away. Default false (paused).",
        },
        hostId: {
          ...HOST_ID_PROP,
          description: "Host to create it on. Defaults to the project's host.",
        },
      },
      required: ["name", "cron", "prompt"],
    },
  },
  {
    name: "update_automation",
    description:
      "Change an automation: only the fields given change. Changing the schedule never fires the runs it skipped.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: ID_PROP,
        ...EDITABLE_PROPS,
        workspace: {
          ...EDITABLE_PROPS.workspace,
          description: `${EDITABLE_PROPS.workspace.description} Changes the mode only when given; workspacePath or keepLast alone edit the current mode's ('reuse' needs workspacePath unless it already reuses one).`,
        },
        keepLast: {
          ...EDITABLE_PROPS.keepLast,
          description: "For 'new': keep only this many run workspaces; 0 turns it off.",
        },
        projectId: { type: "string", description: "Move it to another project on the same host." },
        hostId: HOST_ID_PROP,
      },
      required: ["id"],
    },
  },
  {
    name: "pause_automation",
    description: "Pause an automation: it stops firing on its schedule until resumed.",
    inputSchema: {
      type: "object" as const,
      properties: { id: ID_PROP, hostId: HOST_ID_PROP },
      required: ["id"],
    },
  },
  {
    name: "resume_automation",
    description:
      "Resume a paused automation. It fires at its next occurrence; the ones missed while paused are not run.",
    inputSchema: {
      type: "object" as const,
      properties: { id: ID_PROP, hostId: HOST_ID_PROP },
      required: ["id"],
    },
  },
  {
    name: "run_automation",
    description:
      "Run an automation now, paused or not, and print the run: its workspace and pane, or why it failed to start.",
    inputSchema: {
      type: "object" as const,
      properties: { id: ID_PROP, hostId: HOST_ID_PROP },
      required: ["id"],
    },
  },
  {
    name: "list_automation_runs",
    description:
      "List an automation's runs, newest first: started (with the agent's status now), skipped or failed, and why.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: ID_PROP,
        limit: { type: "number", description: "Show at most this many runs." },
        hostId: HOST_ID_PROP,
      },
      required: ["id"],
    },
  },
  {
    name: "delete_automation",
    description:
      "Delete an automation and its run history. The workspaces its runs made are left as they are.",
    inputSchema: {
      type: "object" as const,
      properties: { id: ID_PROP, hostId: HOST_ID_PROP },
      required: ["id"],
    },
  },
];

// ── Wire helpers ──

/** Writes that make a workspace and start an agent may take a while. */
const RUN_TIMEOUT_MS = 10 * 60_000;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function automationPath(id: unknown, suffix = ""): string {
  return `/automations/${encodeURIComponent(String(id))}${suffix}`;
}

/** `?hostId=` for a read, when one is named. */
function hostQuery(args: Record<string, unknown>): string {
  const hostId = str(args.hostId);
  return hostId ? `?hostId=${encodeURIComponent(hostId)}` : "";
}

/** `{ hostId }` for a write, when one is named. */
function hostBody(args: Record<string, unknown>): Record<string, unknown> {
  const hostId = str(args.hostId);
  return hostId ? { hostId } : {};
}

/** The workspace a create's args describe: 'new' unless they say otherwise. */
function workspaceOf(args: Record<string, unknown>): Record<string, unknown> {
  const mode = str(args.workspace) ?? (args.workspacePath !== undefined ? "reuse" : "new");
  if (mode === "reuse") return { mode, workspacePath: args.workspacePath };
  return args.keepLast !== undefined ? { mode, keepLast: args.keepLast } : { mode };
}

/**
 * The workspace fields the args name, and only those, for an update: the
 * server keeps the rest of the current workspace (a `keepLast` of 0 drops
 * it). Undefined when they name none.
 */
function workspacePatchOf(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const patch: Record<string, unknown> = {};
  const mode = str(args.workspace);
  if (mode !== undefined) patch.mode = mode;
  if (args.workspacePath !== undefined) patch.workspacePath = args.workspacePath;
  if (args.keepLast !== undefined) patch.keepLast = args.keepLast === 0 ? null : args.keepLast;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function editableBody(args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of ["name", "prompt", "agentKind", "missedGraceMinutes", "projectId", "enabled"] as const) {
    if (args[key] !== undefined) body[key] = args[key];
  }
  const schedule: Record<string, unknown> = {};
  if (args.cron !== undefined) schedule.cron = args.cron;
  if (args.timezone !== undefined) schedule.timezone = args.timezone;
  if (Object.keys(schedule).length > 0) body.schedule = schedule;
  return body;
}

// ── Formatting ──

function runLine(run: AutomationRunView): string {
  const what =
    run.outcome === "started"
      ? `started, agent ${run.status ?? "starting"}`
      : `${run.outcome}${run.detail ? `: ${run.detail}` : run.reason ? `: ${run.reason}` : ""}`;
  const where = [
    run.workspacePath ? `workspace ${run.workspacePath}` : null,
    run.agentId ? `agent ${run.agentId}` : run.paneId ? `pane ${run.paneId}` : null,
  ].filter(Boolean);
  return `${run.firedAt}  ${run.trigger}  ${what}${where.length ? `  (${where.join(", ")})` : ""}`;
}

function workspaceText(a: AutomationView): string {
  if (a.workspace.mode === "reuse") return `reuse ${a.workspace.workspacePath}`;
  return a.workspace.keepLast ? `new (keep last ${a.workspace.keepLast})` : "new";
}

function automationLine(a: AutomationView): string {
  const state = a.enabled ? `next ${a.nextRunAt ?? "—"}` : "paused";
  const last = a.lastRun ? runLine(a.lastRun) : "no runs yet";
  return [
    `${a.name}  [${a.id}]`,
    `  ${a.schedule.cron} (${a.schedule.timezone}), ${state}`,
    `  ${a.agentKind} in project ${a.projectId}, ${workspaceText(a)} workspace`,
    `  last run: ${last}`,
  ].join("\n");
}

function detailText(a: AutomationDetail): string {
  const lines = [
    `${a.name}  [${a.id}]  ${a.enabled ? "on" : "paused"}`,
    `Schedule: ${a.schedule.cron} (${a.schedule.timezone})`,
    `Next runs: ${a.nextRuns.length ? a.nextRuns.join(", ") : "none"}`,
    `Agent: ${a.agentKind} in project ${a.projectId}, ${workspaceText(a)} workspace`,
    `Catch-up grace: ${a.missedGraceMinutes} min`,
    "Prompt:",
    ...a.prompt.split("\n").map((l) => `  ${l}`),
    "",
    a.runs.length ? `Runs (${a.runs.length}, newest first):` : "No runs yet.",
    ...a.runs.map((r) => `  ${runLine(r)}`),
  ];
  return lines.join("\n");
}

async function setEnabled(args: Record<string, unknown>, http: Http, enabled: boolean) {
  const updated = (await http.post(automationPath(args.id, "/update"), {
    enabled,
    ...hostBody(args),
  })) as AutomationView;
  return text(
    enabled
      ? `Resumed ${updated.name} [${updated.id}]; next run ${updated.nextRunAt ?? "—"}`
      : `Paused ${updated.name} [${updated.id}]`,
  );
}

// ── Handlers ──

const handlers: ToolModule["handlers"] = {
  async list_automations(args, http) {
    const list = (await http.get(`/automations${hostQuery(args)}`)) as AutomationView[];
    if (list.length === 0) return text("No automations.");
    return text(list.map(automationLine).join("\n\n"));
  },

  async get_automation(args, http) {
    const detail = (await http.get(`${automationPath(args.id)}${hostQuery(args)}`)) as AutomationDetail;
    return text(detailText(detail));
  },

  async create_automation(args, http) {
    const body: Record<string, unknown> = {
      ...editableBody(args),
      projectId: await resolveProjectId(http, str(args.projectId)),
      agentKind: args.agentKind ?? "claude",
      workspace: workspaceOf(args),
      schedule: {
        cron: args.cron,
        timezone: str(args.timezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      ...hostBody(args),
    };
    const created = (await http.post("/automations", body)) as AutomationView;
    const defaulted =
      str(args.timezone) === undefined
        ? `\nTimezone ${created.schedule.timezone} is the default, this machine's; name a timezone to use another.`
        : "";
    return text(`Created automation ${created.name} [${created.id}]\n${automationLine(created)}${defaulted}`);
  },

  async update_automation(args, http) {
    const body: Record<string, unknown> = { ...editableBody(args), ...hostBody(args) };
    const workspace = workspacePatchOf(args);
    if (workspace) body.workspace = workspace;
    const updated = (await http.post(automationPath(args.id, "/update"), body)) as AutomationView;
    return text(`Updated automation ${updated.name} [${updated.id}]\n${automationLine(updated)}`);
  },

  async pause_automation(args, http) {
    return setEnabled(args, http, false);
  },

  async resume_automation(args, http) {
    return setEnabled(args, http, true);
  },

  async run_automation(args, http) {
    const run = (await http.post(automationPath(args.id, "/run"), hostBody(args), RUN_TIMEOUT_MS)) as AutomationRunView;
    return text(runLine(run));
  },

  async list_automation_runs(args, http) {
    const runs = (await http.get(`${automationPath(args.id, "/runs")}${hostQuery(args)}`)) as AutomationRunView[];
    const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : runs.length;
    if (runs.length === 0) return text("No runs yet.");
    return text(runs.slice(0, limit).map(runLine).join("\n"));
  },

  async delete_automation(args, http) {
    await http.del(automationPath(args.id), hostBody(args));
    return text(`Deleted automation ${String(args.id)}`);
  },
};

export const automationsModule: ToolModule = { tools, handlers };

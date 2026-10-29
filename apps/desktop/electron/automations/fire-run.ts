import { getConnector, getConnectorForCommand } from "../agent-connectors";
import type { ProjectInfo, ProjectManager } from "../persistence";
import type { StartAgentResult } from "../routes/agents";
import type { SetupScriptEnd, WorkspaceOps } from "../workspace-ops";
import type { Automation } from "../../src/lib/automations";
import { LOCAL_HOST_ID } from "../../src/lib/workspace-key";
import { branchesEqual, toDirSlug } from "../../src/utils/branch-name";
import { AUTOMATIONS_FOLDER } from "./retention";
import type { AutomationFireResult, AutomationSchedulerDeps } from "./scheduler";

/**
 * Firing a run: the scheduler's `fire`.
 *
 * A server fires only the automations whose project is on its own host —
 * `hostId` `local` as this server sees it. A host server knows its projects
 * as `local` (adoption rewrites them so), and the desktop's local
 * server holds a remote host's projects under that host's id, so it never
 * fires them: a remote host's automations live on its own server, which
 * fires them with or without a desktop.
 *
 * Then: a workspace (a new one in the project's "Automations" folder, or the
 * one the automation reuses), the agent command for its kind, and an agent
 * tab started in it (`startAgentInWorkspace`). Each step that fails returns
 * a failed run with its reason, never a throw the scheduler has to guess at.
 *
 * A run is not the user making a workspace: it leaves the New Workspace
 * dialog's default host alone, and waits for the project's setup script to
 * finish before the agent starts (a manual create starts it alongside).
 * Whether this server may fire at all is the scheduler's `blocked`.
 *
 * Once a new-workspace run has started, `pruneRunWorkspaces` trims the
 * automation's older run workspaces to its keep last N (`./retention.ts`),
 * in the background: the run is recorded without waiting for it.
 */

/** How long a run waits for a new workspace's setup script. */
const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60_000;

export interface FireRunDeps {
  projectManager: Pick<ProjectManager, "getProjects" | "createWorkspaceFolder">;
  workspaceOps: Pick<WorkspaceOps, "create">;
  /** `startAgentInWorkspace` over this server's deps. */
  startAgent: (
    workspacePath: string,
    options: {
      prompt: string;
      agentCommand: string;
      /** Registered for the agent's pane before it starts: nobody may mount it. */
      paneContext: { projectId: string; projectName: string; workspacePath: string; agentCommand: string };
    },
  ) => Promise<StartAgentResult>;
  /** How long to wait for a new workspace's setup script; 10 minutes by default. */
  setupTimeoutMs?: number;
  /** Keep last N, after a new-workspace run starts in `currentPath`. Never rejects. */
  pruneRunWorkspaces?: (automation: Automation, currentPath: string) => Promise<void>;
}

export function createFireRun(deps: FireRunDeps): AutomationSchedulerDeps["fire"] {
  return async (automation, { scheduledFor }) => {
    const project = (await deps.projectManager.getProjects()).find(
      (p) => p.id === automation.projectId && p.hostId === LOCAL_HOST_ID,
    );
    if (!project) {
      return {
        outcome: "failed",
        reason: "project-missing",
        detail: "The project isn't set up on this host",
      };
    }

    const workspace = await resolveWorkspace(deps, automation, project, scheduledFor);
    if ("failed" in workspace) return workspace.failed;

    const agentCommand = agentCommandFor(automation, project);
    const started = await deps.startAgent(workspace.path, {
      prompt: automation.prompt,
      agentCommand,
      paneContext: { projectId: project.id, projectName: project.name, workspacePath: workspace.path, agentCommand },
    });
    if (!started.ok) {
      return { outcome: "failed", reason: "error", detail: started.error, workspacePath: workspace.path };
    }
    if (!workspace.name) return { outcome: "started", workspacePath: workspace.path, paneId: started.data.paneId };
    void deps.pruneRunWorkspaces?.(automation, workspace.path);
    return {
      outcome: "started",
      workspacePath: workspace.path,
      paneId: started.data.paneId,
      workspaceName: workspace.name,
    };
  };
}

async function resolveWorkspace(
  deps: FireRunDeps,
  automation: Automation,
  project: ProjectInfo,
  scheduledFor: string,
): Promise<{ path: string; name?: string } | { failed: AutomationFireResult }> {
  const spec = automation.workspace;
  if (spec.mode === "reuse") {
    if (project.workspaces.some((ws) => ws.path === spec.workspacePath)) {
      return { path: spec.workspacePath };
    }
    return {
      failed: {
        outcome: "failed",
        reason: "workspace-failed",
        detail: `The workspace ${spec.workspacePath} is no longer in ${project.name}`,
      },
    };
  }

  const { name, branch } = runWorkspaceNames(automation, project, scheduledFor);
  try {
    const folderId = automationsFolderId(deps, project);
    const setupTimeoutMs = deps.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
    const { workspacePath, setup } = await deps.workspaceOps.create({
      projectId: project.id,
      name,
      branch,
      folderId,
      recordLastUsedHost: false,
      awaitSetup: { timeoutMs: setupTimeoutMs },
    });
    if (workspacePath) {
      const setupFailed = setup ? setupFailure(setup, setupTimeoutMs) : null;
      if (setupFailed) {
        return { failed: { outcome: "failed", reason: "workspace-failed", detail: setupFailed, workspacePath } };
      }
      return { path: workspacePath, name };
    }
    return {
      failed: { outcome: "failed", reason: "workspace-failed", detail: `Could not create the workspace ${name}` },
    };
  } catch (err) {
    return {
      failed: {
        outcome: "failed",
        reason: "workspace-failed",
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/** Why the setup script failed the run, or null when it finished cleanly (or was killed). */
function setupFailure(setup: SetupScriptEnd, timeoutMs: number): string | null {
  switch (setup.status) {
    case "exited":
      return setup.exitCode ? `Setup script exited with code ${setup.exitCode}` : null;
    case "failed":
      return `Setup script could not start: ${setup.error}`;
    case "timed-out":
      return `Setup script was still running after ${formatDuration(timeoutMs)}`;
  }
}

function formatDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  return `${Math.round(ms / 1000)}s`;
}

/** The project's top-level "Automations" folder, made on its first run. */
function automationsFolderId(deps: FireRunDeps, project: ProjectInfo): string | null {
  const existing = project.folders.find((f) => f.name === AUTOMATIONS_FOLDER && f.parentId == null);
  if (existing) return existing.id;
  return deps.projectManager.createWorkspaceFolder(project.id, AUTOMATIONS_FOLDER, null)?.id ?? null;
}

/**
 * `<name> · Oct 29 09:00` and `auto/<slug>-20261029-0900`, read in the
 * automation's timezone. A second run in the same minute (a Run now) gets a
 * `-2` on the branch and a ` (2)` on the name.
 */
function runWorkspaceNames(
  automation: Pick<Automation, "name" | "schedule">,
  project: Pick<ProjectInfo, "workspaces">,
  scheduledFor: string,
): { name: string; branch: string } {
  const t = zonedParts(new Date(scheduledFor), automation.schedule.timezone);
  const baseName = `${automation.name} · ${t.monthShort} ${Number(t.day)} ${t.hour}:${t.minute}`;
  const slug = toDirSlug(automation.name).slice(0, 40).replace(/-+$/, "") || "automation";
  const baseBranch = `auto/${slug}-${t.year}${t.month}${t.day}-${t.hour}${t.minute}`;
  const taken = (name: string, branch: string): boolean =>
    project.workspaces.some((ws) => ws.name === name || branchesEqual(ws.branch, branch));
  let name = baseName;
  let branch = baseBranch;
  for (let n = 2; taken(name, branch); n++) {
    name = `${baseName} (${n})`;
    branch = `${baseBranch}-${n}`;
  }
  return { name, branch };
}

function zonedParts(
  date: Date,
  timeZone: string,
): { year: string; month: string; monthShort: string; day: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  const monthShort = new Intl.DateTimeFormat("en-US", { timeZone, month: "short" }).format(date);
  return {
    year: get("year"),
    month: get("month"),
    monthShort,
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

/** The project's agentCommand when it starts this kind of agent, else the kind's default. */
function agentCommandFor(automation: Automation, project: Pick<ProjectInfo, "agentCommand">): string {
  const command = project.agentCommand?.trim();
  if (command && getConnectorForCommand(command).kind === automation.agentKind) return command;
  return getConnector(automation.agentKind).defaultCommand;
}

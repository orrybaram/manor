import type { AgentInfo, AgentKind } from "../../../electron.d";
import type { ProjectInfo } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { useHostStore } from "../../../store/host-store";
import { useProjectStore } from "../../../store/project-store";
import { useToastStore } from "../../../store/toast-store";
import { goToAgentPane, resumeAgent } from "../../../lib/agent-resume";
import { isHomePath } from "../../../lib/home";
import { isWithin, normalizePath } from "../../../lib/path-within";
import { shellQuote } from "../../../lib/terminal-file-drop";
import type { ModalRow } from "./agents-modal-list";

/** What a row's Resume (↵, or Go to pane when live) and Fork (⌘↵) ask for. */
export type RowAction = "resume" | "fork";

/** A session to start a CLI on: which, on what host, and where it ran. */
export interface SessionLaunch {
  hostId: string;
  kind: AgentKind;
  sessionId: string;
  /** Its transcript on its host; "" when unknown. */
  path: string;
  /** Where it ran; "" when unknown. */
  cwd: string;
}

/** The session a row resumes or forks: its Session's, else its Agent's own. */
export function sessionLaunchOf(row: ModalRow): SessionLaunch | null {
  const { session, agent } = row;
  if (session) {
    return {
      hostId: session.hostId,
      kind: session.kind,
      sessionId: session.sessionId,
      path: session.path,
      cwd: session.cwd,
    };
  }
  if (agent?.agentSessionId) {
    return {
      hostId: agent.hostId,
      kind: agent.agentKind,
      sessionId: agent.agentSessionId,
      path: agent.transcriptPath ?? "",
      cwd: agent.cwd || agent.workspacePath || "",
    };
  }
  return null;
}

/** What acting on a row does. */
export type RowActionPlan =
  | { type: "go-to-pane"; agent: AgentInfo }
  | { type: "resume-agent"; agent: AgentInfo }
  | { type: "launch"; action: RowAction; launch: SessionLaunch }
  | { type: "none" };

/**
 * Resume on an Agent whose pane is open goes to that pane; on any other
 * Agent it takes the Agent's own resume path. Resume on a Session with no
 * Agent, and Fork on anything, start the CLI in a new tab.
 */
export function planRowAction(row: ModalRow, action: RowAction, live: boolean): RowActionPlan {
  if (action === "resume" && row.agent) {
    return { type: live ? "go-to-pane" : "resume-agent", agent: row.agent };
  }
  const launch = sessionLaunchOf(row);
  return launch ? { type: "launch", action, launch } : { type: "none" };
}

/** Where a launched session's tab opens, and the folder to change to first. */
export interface LaunchPlace {
  hostId: string;
  workspacePath: string;
  /** The session's cwd when the workspace isn't it; null to run in place. */
  cdTo: string | null;
}

type PlaceProject = Pick<ProjectInfo, "hostId"> & {
  workspaces: ReadonlyArray<{ path: string }>;
};

/**
 * The workspace a session's tab opens in, on the session's host: the one
 * whose path is the session's cwd or its nearest ancestor (longest wins);
 * else the active workspace when it's on that host; else the host's first
 * workspace. Unless the workspace is the cwd itself, the tab changes to the
 * cwd first: agent CLIs find a session by the folder it ran in. Null when the
 * host has no workspace.
 */
export function placeLaunch(
  projects: readonly PlaceProject[],
  active: { hostId: string; path: string } | null,
  launch: Pick<SessionLaunch, "hostId" | "cwd">,
): LaunchPlace | null {
  const { hostId } = launch;
  const cwd = normalizePath(launch.cwd);
  const onHost = projects.filter((p) => p.hostId === hostId);

  let best: string | null = null;
  if (cwd) {
    for (const p of onHost) {
      for (const w of p.workspaces) {
        const base = normalizePath(w.path);
        if (base && isWithin(cwd, base) && (best === null || base.length > normalizePath(best).length)) {
          best = w.path;
        }
      }
    }
  }
  const cdFrom = (workspacePath: string) =>
    cwd && normalizePath(workspacePath) !== cwd ? launch.cwd.trim() : null;
  if (best) return { hostId, workspacePath: best, cdTo: cdFrom(best) };

  if (active && active.hostId === hostId && !isHomePath(active.path)) {
    return { hostId, workspacePath: active.path, cdTo: cdFrom(active.path) };
  }
  const first = onHost.find((p) => p.workspaces.length > 0)?.workspaces[0];
  return first ? { hostId, workspacePath: first.path, cdTo: cdFrom(first.path) } : null;
}

/** `command`, run after changing to `cdTo` when there is one. */
export function inFolder(command: string, cdTo: string | null): string {
  return cdTo ? `cd ${shellQuote(cdTo)} && ${command}` : command;
}

/** Host states a command can be sent to: up, coming up, or asleep (a write wakes it). */
const REACHABLE = new Set(["connected", "connecting", "reconnecting", "sleeping"]);

function toast(id: string, message: string): void {
  useToastStore.getState().addToast({ id, message, status: "error" });
}

/**
 * Start a session's CLI in a new tab: resume keeps the session id, so the
 * Agent the pane reports (by that id) is this Session's; fork starts a new
 * one. Uses the same path as resuming an Agent: switch to the workspace,
 * then a terminal tab whose startup command the server types.
 */
async function launchSession(launch: SessionLaunch, action: RowAction): Promise<void> {
  const { projects } = useProjectStore.getState();
  const app = useAppStore.getState();

  if (launch.hostId !== "local") {
    const status = useHostStore.getState().hosts.find((h) => h.hostId === launch.hostId)?.status;
    if (!status || !REACHABLE.has(status)) {
      toast(`session-${action}-host-${launch.sessionId}`, "That session's host isn't connected.");
      return;
    }
  }

  const active = app.activeWorkspacePath
    ? { hostId: app.activeWorkspaceHostId ?? "local", path: app.activeWorkspacePath }
    : null;
  const place = placeLaunch(projects, active, launch);
  if (!place) {
    toast(`session-${action}-place-${launch.sessionId}`, "No workspace on that session's host to open it in.");
    return;
  }

  let command: string | null;
  try {
    command = await window.electronAPI.agents.buildSessionCommand(
      {
        hostId: launch.hostId,
        kind: launch.kind,
        sessionId: launch.sessionId,
        path: launch.path,
        workspacePath: place.workspacePath,
      },
      action,
    );
  } catch {
    command = null;
  }
  if (!command) {
    toast(
      `session-${action}-command-${launch.sessionId}`,
      action === "fork" ? `Can't fork this ${launch.kind} session.` : `Can't resume this ${launch.kind} session.`,
    );
    return;
  }

  useAppStore.getState().setActiveWorkspace(place.workspacePath, place.hostId);
  useAppStore.getState().addTerminalTab(inFolder(command, place.cdTo), { kind: "agent-startup" });
}

/** Carry out a row's action from the Agents modal (see `planRowAction`). */
export function runRowAction(row: ModalRow, action: RowAction, live: boolean): void {
  const plan = planRowAction(row, action, live);
  switch (plan.type) {
    case "go-to-pane":
      goToAgentPane(plan.agent);
      return;
    case "resume-agent":
      resumeAgent(plan.agent);
      return;
    case "launch":
      void launchSession(plan.launch, plan.action);
      return;
    case "none":
      return;
  }
}

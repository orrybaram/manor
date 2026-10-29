import type { AgentInfo, AgentKind } from "../../../electron.d";
import type { ProjectInfo } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { useHostStore } from "../../../store/host-store";
import { useProjectStore } from "../../../store/project-store";
import { useToastStore } from "../../../store/toast-store";
import { goToAgentPane, resumeAgent } from "../../../lib/agent-resume";
import { isHomePath } from "../../../lib/home";
import type { WorkspaceKey } from "../../../lib/workspace-key";
import { isWithin, normalizePath } from "../../../lib/path-within";
import { shellQuote } from "../../../lib/terminal-file-drop";
import { allPaneIds, hasPaneId } from "../../../lib/layout/pane-tree";
import { useLaunchedSessions } from "../../../store/launched-sessions-store";
import { rowPaneId, type ModalRow } from "./agents-modal-list";

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
  | { type: "go-to-launched"; paneId: string }
  | { type: "resume-agent"; agent: AgentInfo }
  | { type: "launch"; action: RowAction; launch: SessionLaunch }
  | { type: "none" };

/**
 * Resume on a row whose session is in an open pane (`openPaneId`, see
 * `rowPaneId`) goes to that pane; on any other Agent it takes the Agent's
 * own resume path. Resume on a Session with no Agent, and Fork on
 * anything, start the CLI in a new tab.
 */
export function planRowAction(
  row: ModalRow,
  action: RowAction,
  openPaneId: string | null,
): RowActionPlan {
  if (action === "resume" && openPaneId) {
    return row.agent?.paneId === openPaneId
      ? { type: "go-to-pane", agent: row.agent }
      : { type: "go-to-launched", paneId: openPaneId };
  }
  if (action === "resume" && row.agent) return { type: "resume-agent", agent: row.agent };
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

/**
 * C0 and C1 control characters and DEL: typed into a shell, Ctrl-U or
 * Ctrl-C in a line defeats any quoting around it.
 */
export function hasControlChars(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** `command`, run after changing to `cdTo` when there is one. */
export function inFolder(command: string, cdTo: string | null): string {
  if (cdTo && hasControlChars(cdTo)) throw new Error("refusing a folder with control characters");
  return cdTo ? `cd ${shellQuote(cdTo)} && ${command}` : command;
}

const UNSAFE_MESSAGE = "This session's folder or id has characters Manor won't type.";

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

  if ([launch.sessionId, launch.path, launch.cwd].some(hasControlChars)) {
    toast(`session-${action}-unsafe-${launch.sessionId}`, UNSAFE_MESSAGE);
    return;
  }

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
  const opened = useAppStore.getState().addTerminalTab(inFolder(command, place.cdTo), {
    kind: "agent-startup",
    // The session's own kind: the workspace's project may run another.
    agentKind: launch.kind,
  });
  // A resumed session is this pane's until its Agent says so (or forever,
  // for a kind with no hooks): Resume goes to it rather than opening another.
  if (opened && action === "resume") {
    useLaunchedSessions.getState().remember(`${launch.kind}:${launch.sessionId}`, opened.paneId);
  }
}

/** Every pane in any workspace layout right now (as `useOpenPaneIds`). */
function openPaneIdsNow(): Set<string> {
  const ids = new Set<string>();
  for (const layout of Object.values(useAppStore.getState().workspaceLayouts)) {
    for (const panel of Object.values(layout.panels)) {
      for (const tab of panel.tabs) for (const id of allPaneIds(tab.rootNode)) ids.add(id);
    }
  }
  return ids;
}

/** Focus `paneId`, in whichever workspace holds it. */
function goToPane(paneId: string): void {
  const app = useAppStore.getState();
  for (const [key, layout] of Object.entries(app.workspaceLayouts)) {
    for (const panel of Object.values(layout.panels)) {
      const tab = panel.tabs.find((t) => hasPaneId(t.rootNode, paneId));
      if (tab) {
        app.navigateToContext({ workspaceKey: key as WorkspaceKey, tabId: tab.id, paneId });
        return;
      }
    }
  }
}

/** Carry out a row's action from the Agents modal (see `planRowAction`). */
export function runRowAction(row: ModalRow, action: RowAction): void {
  const openPaneId = rowPaneId(row, openPaneIdsNow(), useLaunchedSessions.getState().panes);
  const plan = planRowAction(row, action, openPaneId);
  switch (plan.type) {
    case "go-to-pane":
      goToAgentPane(plan.agent);
      return;
    case "go-to-launched":
      goToPane(plan.paneId);
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

import { getAllAgentKinds, getConnector, getConnectorForCommand } from "../../agent-connectors";
import type { AgentKind } from "../../terminal-host/types";
import { resolveAgentCommand } from "../../../src/lib/resolve-agent-command";
import { parseWorkspaceKey, workspaceKey } from "../../../src/lib/workspace-key";
import type { AgentInfo } from "../../agent-persistence";
import { paneContextBackfill } from "../../agent-status/effects";
import { assertString } from "../../ipc-validate";
import { killCounters } from "../../stats-signals";
import { cleanAgentTitle } from "../../title-utils";
import type { AgentService, EndedPane } from "../../layout/layout-store";
import { byAgent, byPane, byWorkspaceKey, LOCAL_ROUTE, method, type HandlerCtx } from "../method";
import type { ServerDeps, SharedDeps } from "../../ipc/types";
import {
  agentsGet,
  agentsGetActive,
  agentsGetAll,
  agentsGetFileAuthors,
  agentsGetPaneStatuses,
  agentsGetRecent,
  agentsGetUnseen,
  agentsReconcileStale,
  findAgent,
} from "./agents-read";

const ALLOWED_RENDERER_TASK_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "namePinned",
]);

/** What the writes by agent id touch: shared with the host server's table. */
export type AgentWriteDeps = Pick<ServerDeps, "agentManager" | "notifier" | "unseen">;

/** What a renderer may change about an agent: its name, and whether it is pinned. */
export interface RendererAgentUpdate {
  name?: string | null;
  namePinned?: boolean;
}

function assertRendererAgentUpdate(
  updates: unknown,
): asserts updates is RendererAgentUpdate {
  if (!updates || typeof updates !== "object") {
    throw new Error("agents:update: updates must be an object");
  }
  for (const key of Object.keys(updates as object)) {
    if (!ALLOWED_RENDERER_TASK_FIELDS.has(key)) {
      throw new Error(
        `agents:update: field "${key}" is not writable from renderer`,
      );
    }
  }
  const u = updates as Record<string, unknown>;
  if ("name" in u && u.name !== null && typeof u.name !== "string") {
    throw new Error("agents:update: name must be a string or null");
  }
  if ("namePinned" in u && typeof u.namePinned !== "boolean") {
    throw new Error("agents:update: namePinned must be a boolean");
  }
}

/** The pane context `agents:setPaneContext` stores against a paneId. */
export interface PaneContext {
  projectId: string;
  projectName: string;
  workspacePath: string;
  agentCommand: string | null;
}

export async function agentsBuildResumeCommand(
  ctx: HandlerCtx<ServerDeps>,
  agentId: string,
): Promise<string | null> {
  assertString(agentId, "agentId");
  // A remote host's agent too: resuming one is a command typed into a pane.
  const agent = findAgent(ctx.deps, agentId);
  if (!agent) return null;
  const base =
    agent.agentCommand ??
    (await kindCommandIn(ctx, agent.agentKind, agent.hostId, agent.workspacePath));
  return getConnector(agent.agentKind).getResumeCommand(base, agent.agentSessionId);
}

/**
 * The command that starts `kind` in a workspace, for a session that recorded
 * none (an Agent started by typing the CLI into a shell, or a Session from
 * outside Manor): the workspace project's agent command when that runs the
 * same kind of agent, else the kind's default.
 */
async function kindCommandIn(
  ctx: HandlerCtx<ServerDeps>,
  kind: AgentKind,
  hostId: string,
  workspacePath: string | null,
): Promise<string> {
  const connector = getConnector(kind);
  if (!workspacePath) return connector.defaultCommand;
  try {
    const projectCommand = resolveAgentCommand({
      key: workspaceKey(hostId, workspacePath),
      projects: await ctx.deps.projectManager.getProjects(),
    });
    if (getConnectorForCommand(projectCommand).kind === kind) return projectCommand;
  } catch {
    // No projects to ask: the kind's default still resumes the session.
  }
  return connector.defaultCommand;
}

/** A Session to resume or fork, and the workspace it will run in. */
export interface SessionCommandRef {
  hostId: string;
  kind: AgentKind;
  sessionId: string;
  /** Its transcript on its host: what pi forks. */
  path: string;
  /** The workspace the command will run in, whose project names the agent command. */
  workspacePath: string | null;
}

const AGENT_KINDS: ReadonlySet<string> = new Set(getAllAgentKinds());

/**
 * C0 and C1 control characters and DEL: typed into a shell, Ctrl-U or
 * Ctrl-C in a line defeats any quoting around it.
 */
function hasControlChars(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/**
 * The shell command that resumes or forks a **Session** in its kind's CLI
 * (the Agents modal's Resume and Fork); null when the kind can't.
 * Resuming keeps the CLI's session id, so the Agent the new pane reports is
 * the Session's.
 */
export async function agentsBuildSessionCommand(
  ctx: HandlerCtx<ServerDeps>,
  ref: SessionCommandRef,
  action: "resume" | "fork",
): Promise<string | null> {
  if (typeof ref !== "object" || ref === null) throw new Error("agents:buildSessionCommand: ref must be an object");
  assertString(ref.hostId, "hostId");
  assertString(ref.sessionId, "sessionId");
  if (typeof ref.path !== "string") throw new Error("agents:buildSessionCommand: path must be a string");
  if (ref.workspacePath !== null && typeof ref.workspacePath !== "string") {
    throw new Error("agents:buildSessionCommand: workspacePath must be a string or null");
  }
  if (!AGENT_KINDS.has(ref.kind)) throw new Error("agents:buildSessionCommand: unknown kind");
  if (action !== "resume" && action !== "fork") throw new Error("agents:buildSessionCommand: unknown action");
  if ([ref.hostId, ref.sessionId, ref.path, ref.workspacePath ?? ""].some(hasControlChars)) {
    throw new Error("agents:buildSessionCommand: refusing control characters");
  }
  const connector = getConnector(ref.kind);
  // A project command that always continues would resume the wrong session.
  const base = connector.withoutSessionArgs(
    await kindCommandIn(ctx, ref.kind, ref.hostId, ref.workspacePath),
  );
  return action === "resume"
    ? connector.getResumeCommand(base, ref.sessionId)
    : connector.getForkCommand(base, ref.sessionId, ref.path);
}

/**
 * Records which project/workspace a pane belongs to, so the sidebar's
 * per-pane agent metadata (and a later agent record for that pane) has a
 * project to point at. A write — this is why it is `mutating` on the
 * bridge, audited by paneId the same way `pty.create` is.
 */
export function agentsSetPaneContext(
  ctx: HandlerCtx<SharedDeps>,
  paneId: string,
  context: PaneContext,
): void {
  assertString(paneId, "paneId");
  assertString(context.projectId, "projectId");
  assertString(context.projectName, "projectName");
  assertString(context.workspacePath, "workspacePath");
  const { deps } = ctx;
  deps.paneContextMap.set(paneId, context);
  // An Agent created before this call (a live session's hooks after a
  // restart) has no project; fill it in now that the pane's is known.
  const agent = deps.agentManager.getAgentByPaneId(paneId);
  const backfill = agent ? paneContextBackfill(agent, context) : null;
  const updated = agent && backfill ? deps.agentManager.updateAgent(agent.id, backfill) : null;
  if (updated) deps.notifier.sendAgentUpdate(updated);
}

/**
 * Returns the count of agents pruned during the most recent AgentManager
 * boot, exactly once per upgrade. After the renderer consumes it, the
 * `agentPruneNoticeShown` flag is set so subsequent boots return 0.
 */
export function agentsConsumePruneNotice(ctx: HandlerCtx<ServerDeps>): number {
  const { agentManager, preferencesManager } = ctx.deps;
  const count = agentManager.getLastPruneCount();
  if (count <= 0) return 0;
  if (preferencesManager.get("agentPruneNoticeShown")) return 0;
  preferencesManager.set("agentPruneNoticeShown", true);
  return count;
}

/**
 * Renames or (un)pins an agent — the only fields a renderer may touch, per
 * `assertRendererAgentUpdate`. Broadcasts so every consumer of the agent list
 * (sidebar, palette, toasts) sees the new name without a reload.
 */
export function agentsUpdate(
  ctx: HandlerCtx<AgentWriteDeps>,
  agentId: string,
  updates: RendererAgentUpdate,
): AgentInfo | null {
  assertString(agentId, "agentId");
  assertRendererAgentUpdate(updates);
  const updated = ctx.deps.agentManager.updateAgent(agentId, updates);
  if (updated) {
    ctx.deps.notifier.sendAgentUpdate(updated);
  }
  return updated;
}

export function agentsDelete(
  ctx: HandlerCtx<AgentWriteDeps>,
  agentId: string,
): boolean {
  assertString(agentId, "agentId");
  const { unseen, notifier } = ctx.deps;
  unseen.clear(agentId);
  const result = ctx.deps.agentManager.deleteAgent(agentId);
  notifier.updateDockBadge();
  return result;
}

/**
 * Clears both unseen Sets for `agentId`, marks its notification-log entries
 * read (the bell must not keep an indicator up for a session
 * already on screen), and re-broadcasts so the renderer cache reflects the
 * cleared flags. The agent record itself didn't mutate, but `sendAgentUpdate`
 * ships the unseen flags alongside it — this is what keeps main authoritative
 * for pulse state, for a browser marking an agent seen exactly as much as a
 * desktop window doing it: the same broadcast, whichever caller wrote the
 * Sets.
 */
export function agentsMarkSeen(
  ctx: HandlerCtx<AgentWriteDeps>,
  agentId: string,
): void {
  assertString(agentId, "agentId");
  const { unseen, notifier } = ctx.deps;
  unseen.clear(agentId);
  notifier.markAgentNotificationsRead(agentId);
  const agent = ctx.deps.agentManager.getAgentById(agentId);
  if (agent) {
    notifier.sendAgentUpdate(agent);
  } else {
    // Agent is gone (deleted before markSeen reached us) — at least refresh
    // the dock badge since the Sets just shrank.
    notifier.updateDockBadge();
  }
}

export function agentsMarkResumed(
  ctx: HandlerCtx<AgentWriteDeps>,
  agentId: string,
): AgentInfo | null {
  assertString(agentId, "agentId");
  return ctx.deps.agentManager.updateAgent(agentId, {
    resumedAt: new Date().toISOString(),
  });
}

/**
 * What ending a pane's agent needs: the record, the stats, the dock badge,
 * and the Status reconciler that owns the lifecycle.
 */
type AbandonDeps = Pick<
  ServerDeps,
  "agentManager" | "statsStore" | "notifier" | "agentStatus" | "paneContextMap"
>;

/**
 * Marks the active agent on `paneId` abandoned — a session end triggered by
 * a pane close rather than by the agent itself. An agent without a name is
 * named after the pane's last title, so it stays recognisable in the list.
 */
function abandonAgentForPane(
  deps: AbandonDeps,
  { paneId, title }: EndedPane,
): void {
  const { agentManager, statsStore, notifier, agentStatus } = deps;
  const agent = agentManager.getAgentByPaneId(paneId);
  if (!agent || agent.status !== "active") return;
  for (const counter of killCounters(agent)) statsStore.record(counter);
  // The name is not status: it stays here. It is written before the signal
  // so the reconciler's broadcast carries it.
  const nameUpdate = !agent.name && title ? cleanAgentTitle(title) : null;
  const named = nameUpdate ? agentManager.updateAgent(agent.id, { name: nameUpdate }) : null;
  // The lifecycle is the Status reconciler's to write: it moves
  // the Agent to 'abandoned', broadcasts it, and resets the pane's status.
  const result = agentStatus.signal(paneId, { type: "user", action: "abandon" });
  const persisted = result.effects.some(
    (e) => e.kind === "PersistAgentStatus" && e.sessionId === agent.agentSessionId,
  );
  // If the reconciler abandoned some other Agent, the rename still has to
  // reach the renderer.
  if (named && !persisted) {
    notifier.sendAgentUpdate(named);
  }
}

/**
 * A pane moved to another workspace, still running: its agent's record and
 * the pane's context now name that workspace, so an agent the pane's hooks
 * create later is filed there too. The sidebar's dot follows the layout on
 * its own; the record is for everything that reads `workspacePath`.
 */
function moveAgentForPane(deps: AbandonDeps, paneId: string, path: string): void {
  const context = deps.paneContextMap.get(paneId);
  if (context && context.workspacePath !== path) {
    deps.paneContextMap.set(paneId, { ...context, workspacePath: path });
  }
  const agent = deps.agentManager.getAgentByPaneId(paneId);
  if (!agent || agent.workspacePath === path) return;
  const updated = deps.agentManager.updateAgent(agent.id, { workspacePath: path });
  if (updated) deps.notifier.sendAgentUpdate(updated);
}

/** The {@link AgentService} `app-lifecycle.ts` hands `LayoutStore`. */
export function createAgentService(deps: AbandonDeps): Required<AgentService> {
  return {
    moveToWorkspace(paneIds, workspacePath) {
      // Agent records name a workspace by its path on the agent's host.
      const { path } = parseWorkspaceKey(workspacePath);
      for (const paneId of paneIds) {
        try {
          moveAgentForPane(deps, paneId, path);
        } catch (err) {
          console.error(`[agents] failed to move ${paneId}'s agent:`, err);
        }
      }
    },
    abandonForPanes(panes) {
      for (const pane of panes) {
        try {
          abandonAgentForPane(deps, pane);
        } catch (err) {
          console.error(`[agents] failed to abandon ${pane.paneId}:`, err);
        }
      }
    },
  };
}

/**
 * The desktop's `agents` namespace: the shared reads (`./agents-read.ts`,
 * which the host server lists too) and the desktop-only writes above.
 *
 * Routed: the reads merge every adopted host's agents, a pane's
 * context goes to the host whose layout holds the pane, and a write by agent
 * id goes to the host whose server holds the agent.
 */
export const agents = {
  getAll: method(agentsGetAll, { route: LOCAL_ROUTE }),
  get: method(agentsGet, { route: LOCAL_ROUTE }),
  getActive: method(agentsGetActive, { route: LOCAL_ROUTE }),
  getRecent: method(agentsGetRecent, { route: LOCAL_ROUTE }),
  getUnseen: method(agentsGetUnseen, { route: LOCAL_ROUTE }),
  // Every pane's published Agent status, for a renderer that starts after
  // some were already sent — a browser always is one.
  getPaneStatuses: method(agentsGetPaneStatuses, { route: LOCAL_ROUTE }),
  consumePruneNotice: method(agentsConsumePruneNotice, { route: LOCAL_ROUTE }),
  buildResumeCommand: method(agentsBuildResumeCommand, { route: LOCAL_ROUTE }),
  buildSessionCommand: method(agentsBuildSessionCommand, { route: LOCAL_ROUTE }),
  // Called after every `pty.create` that has a `cwd` — without it, a pane
  // opened from a browser never gets the project context the sidebar reads.
  setPaneContext: method(agentsSetPaneContext, { mutating: true, route: byPane(0) }),
  // Every write another viewer's sidebar, palette or dock badge reads:
  // `update` renames/pins, `delete` ends a session, `markSeen` and
  // `markResumed` move the unseen flags every window shares. A pane's agent
  // is abandoned by `LayoutStore` when the pane ends, not over the bridge.
  update: method(agentsUpdate, { mutating: true, route: byAgent(0) }),
  delete: method(agentsDelete, { mutating: true, route: byAgent(0) }),
  markSeen: method(agentsMarkSeen, { mutating: true, route: byAgent(0) }),
  markResumed: method(agentsMarkResumed, { mutating: true, route: byAgent(0) }),
  // Ends sessions, but `App.tsx` calls it on every mount of every window and
  // tab: a line per page load is noise that buries the lines that matter,
  // and what it ends was already dead.
  reconcileStale: method(agentsReconcileStale, { route: LOCAL_ROUTE }),
  // Which agent wrote each file of a workspace, for the file pane: the
  // server whose hooks heard it answers.
  getFileAuthors: method(agentsGetFileAuthors, { route: byWorkspaceKey(0) }),
};

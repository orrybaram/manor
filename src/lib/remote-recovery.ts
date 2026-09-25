/**
 * Away and back (ADR-178 §6): what a window does when one of its remote
 * hosts comes back after a drop.
 *
 * Main announces `hosts:reconnected` once the host's hook replay is in, with
 * every session the host's daemon still has. Every pane this window runs on
 * that host is then one of two things:
 *
 * - **survived** — its session is still there, but whatever it printed while
 *   the host was away never arrived. It reattaches: its terminal remounts
 *   and restores from the session's snapshot.
 * - **lost** — the daemon restarted (the box rebooted, the daemon was
 *   killed) and took the session with it. It goes through the same path a
 *   pane takes on app relaunch (ADR-144): a fresh shell in the pane's cwd,
 *   and if the pane had an agent, the agent connector's resume command, run
 *   once the shell is ready. The window says so once: "Remote host
 *   restarted — N sessions resumed".
 *
 * The decisions are pure functions; `recoverHostPanes` sequences them over
 * injected effects so the whole thing is testable without a renderer.
 */

import type { AgentInfo } from "../electron.d";
import type { WorkspaceLayout } from "../store/app-store";
import { allPaneIds } from "../store/pane-tree";

export interface HostResumePlan {
  /** Panes whose sessions survived: resnapshot. */
  reattach: string[];
  /** Panes whose sessions are gone: recreate, resuming any agent. */
  lost: string[];
}

/** Every pane in this window's layouts, across all its workspaces. */
export function windowPaneIds(
  workspaceLayouts: Readonly<Record<string, WorkspaceLayout>>,
): Set<string> {
  const ids = new Set<string>();
  for (const layout of Object.values(workspaceLayouts)) {
    for (const panel of Object.values(layout.panels)) {
      for (const tab of panel.tabs) {
        for (const paneId of allPaneIds(tab.rootNode)) ids.add(paneId);
      }
    }
  }
  return ids;
}

/**
 * Split this window's panes on `hostId` by whether the host still has their
 * session. A pane's session id is its pane id. Only panes `include` accepts
 * count — a pane recorded here that has since moved to another window, or
 * been closed and is waiting out its kill grace, is not this window's to
 * recover.
 */
export function planHostResume(
  hostId: string,
  remoteHostByPane: Readonly<Record<string, string>>,
  aliveSessionIds: readonly string[],
  include: (paneId: string) => boolean = () => true,
): HostResumePlan {
  const alive = new Set(aliveSessionIds);
  const plan: HostResumePlan = { reattach: [], lost: [] };
  for (const [paneId, paneHostId] of Object.entries(remoteHostByPane)) {
    if (paneHostId !== hostId || !include(paneId)) continue;
    if (alive.has(paneId)) plan.reattach.push(paneId);
    else plan.lost.push(paneId);
  }
  return plan;
}

/**
 * The agent to resume in lost pane `paneId`, if it had one: the active agent
 * on that pane with a command to relaunch — the same agent the relaunch path
 * resumes. Unlike relaunch it does not skip one resumed before: that marker
 * guards against launching twice on remount, while a restarted host means
 * the agent really is gone again.
 */
export function agentToResume(
  paneId: string,
  activeAgents: readonly AgentInfo[],
): AgentInfo | null {
  return (
    activeAgents.find(
      (a) => a.status === "active" && a.paneId === paneId && !!a.agentCommand,
    ) ?? null
  );
}

export function restartNotice(resumed: number): string {
  return `Remote host restarted — ${resumed} ${resumed === 1 ? "session" : "sessions"} resumed`;
}

export interface RecoveryEffects {
  /** This window's remote panes and the host each runs on. */
  remoteHostByPane: () => Readonly<Record<string, string>>;
  /** Whether a recorded pane is this window's to recover (see `planHostResume`). */
  includePane: (paneId: string) => boolean;
  /** Fresh from main on every call: the agents still active. */
  getActiveAgents: () => Promise<AgentInfo[]>;
  markResumed: (agentId: string) => Promise<unknown>;
  buildResumeCommand: (agentId: string) => Promise<string | null>;
  /** Run `command` in `paneId` once its fresh shell is ready. */
  setPendingPaneCommand: (paneId: string, command: string) => void;
  /** Remount these panes' terminals so they create/attach again. */
  reattach: (paneIds: string[]) => void;
  notify: (message: string) => void;
}

/**
 * Bring this window's panes on `hostId` back after it reconnected with
 * `aliveSessionIds`. Survivors reattach at once; lost panes get their resume
 * command queued before they remount, so the fresh shell runs it.
 */
export async function recoverHostPanes(
  hostId: string,
  aliveSessionIds: readonly string[],
  effects: RecoveryEffects,
): Promise<HostResumePlan> {
  const plan = planHostResume(
    hostId,
    effects.remoteHostByPane(),
    aliveSessionIds,
    effects.includePane,
  );
  if (plan.reattach.length > 0) effects.reattach(plan.reattach);
  if (plan.lost.length === 0) return plan;

  let agents: AgentInfo[] = [];
  try {
    agents = await effects.getActiveAgents();
  } catch (err) {
    console.warn("[remote-recovery] could not list agents; resuming bare shells:", err);
  }
  const commands = await Promise.all(
    plan.lost.map(async (paneId) => {
      const agent = agentToResume(paneId, agents);
      if (!agent) return null;
      // Marked first, as on relaunch, so the pane's own cold-start check
      // cannot launch it a second time.
      void effects.markResumed(agent.id).catch(() => {});
      let command: string | null = null;
      try {
        command = await effects.buildResumeCommand(agent.id);
      } catch {
        // Fall back to relaunching the bare command.
      }
      command ??= agent.agentCommand;
      return command ? { paneId, agentId: agent.id, command } : null;
    }),
  );
  const toQueue = commands.filter((c) => c !== null);
  if (toQueue.length > 0) {
    // Ask again right before queueing: the replay that settled before the
    // host was announced is bounded, and a hook arriving since may have
    // ended one of these agents — resuming it would start a finished agent
    // over. If the answer cannot be had, go with the first one.
    let stillActive: Set<string> | null = null;
    try {
      const fresh = await effects.getActiveAgents();
      stillActive = new Set(fresh.filter((a) => a.status === "active").map((a) => a.id));
    } catch {
      // Keep the first answer.
    }
    for (const { paneId, agentId, command } of toQueue) {
      if (stillActive && !stillActive.has(agentId)) continue;
      effects.setPendingPaneCommand(paneId, command);
    }
  }
  effects.reattach(plan.lost);
  effects.notify(restartNotice(plan.lost.length));
  return plan;
}

/**
 * Whether a command a mount of `paneId` took from the queue but never wrote
 * — it unmounted first, say because its host dropped again mid-recovery and
 * the pane was remounted — goes back on the queue for the next mount. Only
 * for a remote pane still in this window and not being closed, and never
 * over a command queued since.
 */
export function shouldRequeuePaneCommand(
  paneId: string,
  state: {
    remoteHostByPane: Readonly<Record<string, string>>;
    windowPaneIds: ReadonlySet<string>;
    closedPaneIds: ReadonlySet<string>;
    pendingPaneCommands: Readonly<Record<string, string>>;
  },
): boolean {
  return (
    paneId in state.remoteHostByPane &&
    state.windowPaneIds.has(paneId) &&
    !state.closedPaneIds.has(paneId) &&
    !(paneId in state.pendingPaneCommands)
  );
}

/**
 * What a workspace move carries beyond the worktree: the
 * `WorkspaceRecreator` `workspace-host-move.ts` runs once the target
 * workspace exists, before the source is removed.
 *
 * **restore**: the source's layout, rebuilt in the target with fresh ids
 * (`layoutReplay`, `src/lib/layout/layout-replay.ts`). Terminals start
 * fresh, each with a queued `cd` to its old cwd under the new root.
 *
 * **agents**: each pane that held an active Agent comes back as a fresh
 * Agent of the same kind, in the same place: its tab is held out of the
 * restore (`heldPaneIds`) and added once its launch line, an
 * `agent-startup` pending command, is queued with a handoff prompt
 * (`buildHandoffPrompt`) built from the old Session's transcript, read on
 * the source host. A transcript that can't be read leaves a shorter
 * prompt, never a failed move. No CLI's session store is written. An
 * Agent's pinned name does not come across: the new Agent's record exists
 * only once its first hook arrives, and nothing names it before then.
 *
 * **Again.** The recreator remembers what each move's replay made in its
 * target (`replayedMoves`). A Retry of that move, or a later move of the
 * same workspace onto the same host, builds on whatever of it is still
 * there, so no tab is added and no Agent started twice; after a restart,
 * `layoutReplay` matches the target's tabs by title and shape.
 *
 * Each host's layout is read and changed where it lives
 * (`createWorkspaceRecreator`): in this desktop's `LayoutStore` for this
 * machine and for a remote host not yet adopted (keyed `<hostId>:<path>`),
 * and through the host's server (`HostProxy`) for an adopted one, as a
 * renderer's `layout.*` calls are routed there.
 */

import type { AgentInfo } from "../agent-persistence";
import { getConnector, getConnectorForCommand } from "../agent-connectors";
import { LOCAL_HOST_ID } from "../backend/types";
import type { HostProxy } from "../backend/host-proxy";
import { errorMessage } from "../lib/errors";
import type { LayoutStore, LayoutOrigin } from "../layout/layout-store";
import type { PendingCommandKind, PendingCommandOptions } from "../layout/pending-commands";
import type { HostRouting } from "../server/host-routing";
import { readSessionPreview, type SessionPreview, type SessionRef } from "../sessions/preview";
import { createSessionScanner, processEnv, type SessionScanner } from "../sessions/scanner";
import type { SessionSummary } from "../sessions/types";
import { shellQuote } from "../terminal-host/ssh-config";
import type { AgentKind } from "../terminal-host/types";
import { hostDisplayName } from "./host-records";
import { buildHandoffPrompt, handoffFromPreview } from "./handoff-prompt";
import type { ProjectManager } from "./project-manager";
import type { RecreateContext, RecreateStep, WorkspaceRecreator } from "./workspace-host-move";
import type { LayoutCommand } from "../../src/lib/layout/commands";
import {
  bindPanelId,
  currentOrder,
  layoutReplay,
  TARGET_FIRST_PANEL,
  type ReplayRecord,
} from "../../src/lib/layout/layout-replay";
import { allPanelIds } from "../../src/lib/layout/panel-tree";
import type { LayoutApplyResult, LayoutEntry } from "../../src/lib/layout/protocol";
import { findPanelWithTab, layoutPaneIds } from "../../src/lib/layout/workspace-layout";
import { resolveAgentCommand } from "../../src/lib/resolve-agent-command";
import type { WorkspaceKey } from "../../src/lib/workspace-key";

/** One host's layout, wherever its store is. */
export interface HostLayout {
  /** The workspace's entry; null before it has one. */
  read(key: WorkspaceKey): Promise<LayoutEntry | null>;
  apply(key: WorkspaceKey, command: LayoutCommand): Promise<LayoutApplyResult>;
  /** Queue a pane's first line, before the apply that adds the pane. */
  queue(
    paneId: string,
    text: string,
    kind: PendingCommandKind,
    opts?: PendingCommandOptions,
  ): Promise<void>;
}

/** What a recreator needs of the server, injected so tests fake each host. */
export interface WorkspaceRecreatorDeps {
  layout(hostId: string): HostLayout;
  /** Every active Agent this server knows of, on any host. */
  agents(): AgentInfo[];
  /** `agent`'s Session's last turns, read on `hostId`, where it ran. */
  transcript(hostId: string, agent: AgentInfo): Promise<SessionPreview>;
  /** The base command `targetKey`'s project starts an Agent with. */
  agentCommand(targetKey: WorkspaceKey): Promise<string>;
  /** A host's name, as the sidebar shows it. */
  hostName(hostId: string): string;
  /**
   * Note a launched pane's project and workspace before it starts, for a
   * target this server holds (`paneContextMap`), as an automation's launch
   * does: nobody may be looking at the pane.
   */
  notePane?(move: RecreateContext, paneId: string, agentCommand: string): Promise<void>;
}

/** How long a transcript read may take before the handoff goes without it. */
const TRANSCRIPT_WAIT_MS = 15_000;

/** The origin a move's layout commands carry. */
const MOVE_ORIGIN: LayoutOrigin = { kind: "route", id: "workspace-move" };

function hasTabs(entry: LayoutEntry | null): entry is LayoutEntry {
  return !!entry && Object.values(entry.layout.panels).some((p) => p.tabs.length > 0);
}

/**
 * Send `commands` to `key` in order. `firstPanel` is the panel
 * `TARGET_FIRST_PANEL` stands for, null while the target has no layout:
 * the first command then makes it, and it is read back. Answers it.
 */
async function applyAll(
  layout: HostLayout,
  key: WorkspaceKey,
  commands: readonly LayoutCommand[],
  bound: string | null,
): Promise<string | null> {
  let firstPanel = bound;
  for (const [i, raw] of commands.entries()) {
    let command: LayoutCommand = firstPanel
      ? bindPanelId(raw, TARGET_FIRST_PANEL, firstPanel)
      : raw;
    if (command.type === "reorder-tabs") {
      // Ordered against the panel as it is now: a reorder naming a tab that
      // closed meanwhile (a Setup tab's script ending) is refused whole.
      const entry: LayoutEntry | null = await layout.read(key);
      const order = entry ? currentOrder(entry.layout, command.panelId, command.tabIds) : null;
      if (!order) continue;
      command = { ...command, tabIds: order };
    }
    const result = await layout.apply(key, command);
    if ("error" in result) throw new Error(`The target refused a layout command: ${result.error}`);
    if (i === 0 && firstPanel === null && command.type === "new-tab") {
      // The server made the workspace's first panel for this tab: the rest
      // of the commands name it.
      const entry: LayoutEntry | null = await layout.read(key);
      const found: { panel: { id: string } } | null = entry
        ? findPanelWithTab(entry.layout, command.tab.id)
        : null;
      if (!found) throw new Error("The target workspace did not take its first tab");
      firstPanel = found.panel.id;
    }
  }
  return firstPanel;
}

/** The base command for an Agent of `kind`: the first of `candidates` of that kind, else its default. */
export function agentCommandFor(
  kind: AgentKind,
  candidates: readonly (string | null | undefined)[],
): string {
  const connector = getConnector(kind);
  for (const command of candidates) {
    if (command && getConnectorForCommand(command).kind === kind) {
      // A fresh Session: never the old one's `--resume`.
      return connector.withoutSessionArgs(command);
    }
  }
  return connector.defaultCommand;
}

/**
 * The source's active Agents, one per pane (the latest), in layout order.
 * The pane must still be an agent's: an Agent whose CLI exited without a
 * SessionEnd stays `active`, but every way a pane's agent ends (SessionEnd,
 * the process gone from the foreground, a user's end) publishes its status
 * with `kind: null`, and that is the last status its pane keeps.
 */
function agentsIn(entry: LayoutEntry, agents: readonly AgentInfo[]): AgentInfo[] {
  const byPane = new Map<string, AgentInfo>();
  for (const agent of agents) {
    if (agent.status !== "active" || !agent.paneId) continue;
    if (!entry.paneSessions[agent.paneId]?.lastAgentStatus?.kind) continue;
    const had = byPane.get(agent.paneId);
    if (!had || had.updatedAt < agent.updatedAt) byPane.set(agent.paneId, agent);
  }
  return [...layoutPaneIds(entry.layout)].flatMap((paneId) => byPane.get(paneId) ?? []);
}

/** What the agents step says: the kind, or how many. */
function agentsDetail(agents: readonly AgentInfo[]): string {
  if (agents.length === 1) return agents[0].agentKind;
  const kinds = new Set(agents.map((a) => a.agentKind));
  return kinds.size === 1 ? `${agents.length} ${agents[0].agentKind} agents` : `${agents.length} agents`;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The recreator over `deps` (see the module header). */
export function workspaceRecreator(
  deps: WorkspaceRecreatorDeps,
  replayed: Map<string, ReplayRecord> = new Map(),
): WorkspaceRecreator {
  /** Whether each source's plan has an agents step, for its run. */
  const plannedAgents = new Map<WorkspaceKey, boolean>();

  /** The handoff for `agent`: its Session's turns when they can be read, else without. */
  const handoff = async (move: RecreateContext, agent: AgentInfo): Promise<string> => {
    let firstPrompt: string | null = null;
    let turns: ReturnType<typeof handoffFromPreview>["turns"] = [];
    try {
      const preview = await within(deps.transcript(move.sourceHostId, agent), TRANSCRIPT_WAIT_MS);
      ({ firstPrompt, turns } = handoffFromPreview(preview));
    } catch (err) {
      console.warn(`[workspace-move] ${agent.id}'s transcript could not be read:`, errorMessage(err));
    }
    return buildHandoffPrompt({
      sourceHostName: deps.hostName(move.sourceHostId),
      targetHostName: deps.hostName(move.targetHostId),
      branch: move.branch,
      session: { title: agent.name, firstPrompt },
      turns,
    });
  };

  return {
    async plan(source) {
      const entry = await deps.layout(source.hostId).read(source.key);
      if (!hasTabs(entry)) return [];
      const steps: RecreateStep[] = [{ id: "restore" }];
      const agents = agentsIn(entry, deps.agents());
      if (agents.length > 0) steps.push({ id: "agents", detail: agentsDetail(agents) });
      plannedAgents.set(source.key, agents.length > 0);
      return steps;
    },

    async run(move: RecreateContext, begin) {
      const withAgents = plannedAgents.get(move.sourceKey) ?? false;
      plannedAgents.delete(move.sourceKey);

      begin(0);
      const sourceEntry = await deps.layout(move.sourceHostId).read(move.sourceKey);
      if (!hasTabs(sourceEntry)) {
        if (withAgents) begin(1);
        return;
      }
      // An Agent that started since the plan comes back as a shell: the
      // dialog has no step for it.
      const agents = withAgents ? agentsIn(sourceEntry, deps.agents()) : [];
      const target = deps.layout(move.targetHostId);
      const targetEntry = await target.read(move.targetKey);
      const moveKey = `${move.sourceKey}\0${move.targetKey}`;
      const previous = replayed.get(moveKey);
      const replay = layoutReplay({
        source: sourceEntry.layout,
        paneSessions: sourceEntry.paneSessions,
        sourceRoot: move.sourcePath,
        targetRoot: move.targetPath,
        target: targetEntry,
        heldPaneIds: new Set(agents.map((a) => a.paneId!)),
        ...(previous ? { previous } : {}),
      });
      // Remembered before anything is sent: whatever of it lands, a Retry
      // finds in the target and keeps.
      const remember = (firstPanel: string | null) =>
        replayed.set(moveKey, {
          tabIds: replay.record.tabIds,
          panelIds: Object.fromEntries(
            Object.entries(replay.record.panelIds).map(([from, to]) => [
              from,
              to === TARGET_FIRST_PANEL && firstPanel ? firstPanel : to,
            ]),
          ),
          placeholderTabIds: [...(previous?.placeholderTabIds ?? []), ...replay.placeholderTabIds],
        });
      remember(null);
      // A shell line waits for whoever mounts the pane, so it goes first.
      for (const [paneId, cwd] of Object.entries(replay.cwds)) {
        await target.queue(paneId, `cd ${shellQuote(cwd)}`, "shell");
      }
      const known = targetEntry ? allPanelIds(targetEntry.layout.panelTree)[0] : null;
      const firstPanel = await applyAll(target, move.targetKey, replay.commands, known);
      remember(firstPanel);
      if (!withAgents) return;

      begin(1);
      const base = await deps.agentCommand(move.targetKey);
      for (const agent of agents) {
        // An Agent whose tab an earlier try already put back was started then.
        const paneId = replay.paneIds[agent.paneId!];
        if (!paneId) continue;
        const command = agentCommandFor(agent.agentKind, [base, agent.agentCommand]);
        // Queued before the apply that adds the pane: that apply launches it.
        await target.queue(paneId, command, "agent-startup", {
          prompt: await handoff(move, agent),
          agentKind: agent.agentKind,
        });
        await deps.notePane?.(move, paneId, command);
      }
      await applyAll(target, move.targetKey, replay.heldCommands, firstPanel);
    },
  };
}

/**
 * A host's layout as the desktop's server reaches it: its server's, through
 * the proxy, for an adopted host; else this desktop's `LayoutStore`.
 */
function hostLayout(
  server: {
    layoutStore: Pick<LayoutStore, "whenLoaded" | "get" | "apply" | "pendingCommands">;
    hostRouting?: Pick<HostRouting, "proxy">;
  },
  hostId: string,
): HostLayout {
  const proxy: HostProxy | null =
    hostId === LOCAL_HOST_ID ? null : (server.hostRouting?.proxy(hostId) ?? null);
  if (proxy) {
    return {
      async read(key) {
        // Asked now, not the proxy's cache: the workspace was just made.
        const all = (await proxy.invoke("layout", "getAll", [])) as Record<string, LayoutEntry>;
        return all[key] ?? null;
      },
      async apply(key, command) {
        return (await proxy.invoke("layout", "apply", [key, command, MOVE_ORIGIN])) as LayoutApplyResult;
      },
      async queue(paneId, text, kind, opts) {
        await proxy.invoke("layout", "setPendingCommand", [paneId, text, kind, opts ?? null]);
      },
    };
  }
  const store = server.layoutStore;
  return {
    async read(key) {
      await store.whenLoaded();
      return store.get(key);
    },
    apply: (key, command) => store.apply(key, command, MOVE_ORIGIN),
    async queue(paneId, text, kind, opts) {
      store.pendingCommands.set(paneId, text, kind, opts);
    },
  };
}

/** What `createWorkspaceRecreator` reads of the server. */
interface RecreatorServer {
  layoutStore: Pick<LayoutStore, "whenLoaded" | "get" | "apply" | "pendingCommands">;
  hostRouting?: Pick<HostRouting, "proxy" | "agents">;
  agentManager: { getActiveAgents(): AgentInfo[] };
  projectManager: Pick<ProjectManager, "getProjects" | "hostLabel" | "isRemoteProject">;
  paneContextMap: Map<
    string,
    { projectId: string; projectName: string; workspacePath: string; agentCommand: string | null }
  >;
}

/** How a host's Sessions are read: its list, and one Session's preview. */
export interface SessionReads {
  list(hostId: string): Promise<SessionSummary[]>;
  preview(hostId: string, ref: SessionRef): Promise<SessionPreview>;
}

/**
 * `agent`'s Session's preview, read on `hostId`. Its transcript is where
 * its hooks said; an Agent whose hooks never said (pi, opencode, often
 * codex) is found in the host's Session list by kind and session id.
 */
export async function readAgentTranscript(
  reads: SessionReads,
  hostId: string,
  agent: AgentInfo,
): Promise<SessionPreview> {
  let path = agent.transcriptPath;
  if (!path) {
    const sessions = await reads.list(hostId);
    path =
      sessions.find((s) => s.kind === agent.agentKind && s.sessionId === agent.agentSessionId)?.path ?? null;
    if (!path) throw new Error("the Agent's Session is not in its host's list");
  }
  return reads.preview(hostId, { hostId, kind: agent.agentKind, sessionId: agent.agentSessionId, path });
}

/** This machine's Session scanner, made at the first move that needs it. */
let localScanner: SessionScanner | null = null;

/**
 * Sessions as the desktop's server reads them: this machine's store here,
 * an adopted host's through its server. A host not adopted has no reader
 * the desktop can reach, so its Agents get the short handoff.
 */
function sessionReads(server: RecreatorServer): SessionReads {
  const proxyOf = (hostId: string) => {
    const proxy = server.hostRouting?.proxy(hostId);
    if (!proxy) throw new Error(`${hostId}'s Sessions can only be read through its host server`);
    return proxy;
  };
  return {
    async list(hostId) {
      if (hostId === LOCAL_HOST_ID) return (localScanner ??= createSessionScanner()).list();
      return (await proxyOf(hostId).invoke("sessions", "list", [])) as SessionSummary[];
    },
    async preview(hostId, ref) {
      if (hostId === LOCAL_HOST_ID) return readSessionPreview(ref, processEnv());
      return (await proxyOf(hostId).invoke("sessions", "transcript", [ref])) as SessionPreview;
    },
  };
}

/**
 * What each move's replay made in its target, by source and target key,
 * for as long as the app runs: a Retry, or a second move of the same
 * workspace onto the same host, builds on it rather than adding every tab,
 * and starting every Agent, again. A move made after a restart has none,
 * and `layoutReplay` matches the target's tabs by title and shape instead.
 * Shared by every recreator: one is made per move.
 */
const replayedMoves = new Map<string, ReplayRecord>();

/** The recreator a move runs in the desktop's Manor server (`createWorkspaceHostMoveDeps`). */
export function createWorkspaceRecreator(server: RecreatorServer): WorkspaceRecreator {
  const pm = server.projectManager;
  return workspaceRecreator({
    layout: (hostId) => hostLayout(server, hostId),
    agents: () => [
      ...server.agentManager.getActiveAgents(),
      ...(server.hostRouting?.agents() ?? []).filter((a) => a.status === "active"),
    ],
    transcript: (hostId, agent) => readAgentTranscript(sessionReads(server), hostId, agent),
    agentCommand: async (key) => resolveAgentCommand({ key, projects: await pm.getProjects() }),
    // Mid-sentence in the handoff ("moved from this machine to …").
    hostName: (hostId) => (hostId === LOCAL_HOST_ID ? "this machine" : hostDisplayName(pm, hostId)),
    async notePane(move, paneId, agentCommand) {
      // An adopted host's server launches the pane, and keeps its own.
      if (pm.isRemoteProject(move.targetProjectId)) return;
      const project = (await pm.getProjects()).find((p) => p.id === move.targetProjectId);
      if (!project) return;
      server.paneContextMap.set(paneId, {
        projectId: project.id,
        projectName: project.name,
        workspacePath: move.targetPath,
        agentCommand,
      });
    },
  }, replayedMoves);
}

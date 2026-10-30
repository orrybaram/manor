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
 * prompt, never a failed move. No CLI's session store is written.
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
import { readSessionPreview, type SessionPreview } from "../sessions/preview";
import { processEnv } from "../sessions/scanner";
import { shellQuote } from "../terminal-host/ssh-config";
import type { AgentKind } from "../terminal-host/types";
import { buildHandoffPrompt, handoffFromPreview } from "./handoff-prompt";
import type { ProjectManager } from "./project-manager";
import type { RecreateContext, RecreateStep, WorkspaceRecreator } from "./workspace-host-move";
import type { LayoutCommand } from "../../src/lib/layout/commands";
import { bindPanelId, layoutReplay, TARGET_FIRST_PANEL } from "../../src/lib/layout/layout-replay";
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
    const command: LayoutCommand = firstPanel
      ? bindPanelId(raw, TARGET_FIRST_PANEL, firstPanel)
      : raw;
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

/** The source's active Agents, one per pane (the latest), in layout order. */
function agentsIn(entry: LayoutEntry, agents: readonly AgentInfo[]): AgentInfo[] {
  const byPane = new Map<string, AgentInfo>();
  for (const agent of agents) {
    if (agent.status !== "active" || !agent.paneId) continue;
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
export function workspaceRecreator(deps: WorkspaceRecreatorDeps): WorkspaceRecreator {
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
      const replay = layoutReplay({
        source: sourceEntry.layout,
        paneSessions: sourceEntry.paneSessions,
        sourceRoot: move.sourcePath,
        targetRoot: move.targetPath,
        target: targetEntry,
        heldPaneIds: new Set(agents.map((a) => a.paneId!)),
      });
      // A shell line waits for whoever mounts the pane, so it goes first.
      for (const [paneId, cwd] of Object.entries(replay.cwds)) {
        await target.queue(paneId, `cd ${shellQuote(cwd)}`, "shell");
      }
      const known = targetEntry ? allPanelIds(targetEntry.layout.panelTree)[0] : null;
      const firstPanel = await applyAll(target, move.targetKey, replay.commands, known);
      if (!withAgents) return;

      begin(1);
      const base = await deps.agentCommand(move.targetKey);
      for (const agent of agents) {
        const paneId = replay.paneIds[agent.paneId!];
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

/**
 * `agent`'s Session's preview, read on `hostId`: this machine's store here,
 * an adopted host's through its server. A host not adopted has no reader
 * the desktop can reach, so its Agents get the short handoff.
 */
async function readTranscript(
  server: RecreatorServer,
  hostId: string,
  agent: AgentInfo,
): Promise<SessionPreview> {
  if (!agent.transcriptPath) throw new Error("the Agent has no transcript path");
  const ref = { hostId, kind: agent.agentKind, sessionId: agent.agentSessionId, path: agent.transcriptPath };
  if (hostId === LOCAL_HOST_ID) return readSessionPreview(ref, processEnv());
  const proxy = server.hostRouting?.proxy(hostId);
  if (!proxy) throw new Error(`${hostId}'s Sessions can only be read through its host server`);
  return (await proxy.invoke("sessions", "transcript", [ref])) as SessionPreview;
}

/** The recreator a move runs in the desktop's Manor server (`createWorkspaceHostMoveDeps`). */
export function createWorkspaceRecreator(server: RecreatorServer): WorkspaceRecreator {
  const pm = server.projectManager;
  return workspaceRecreator({
    layout: (hostId) => hostLayout(server, hostId),
    agents: () => [
      ...server.agentManager.getActiveAgents(),
      ...(server.hostRouting?.agents() ?? []).filter((a) => a.status === "active"),
    ],
    transcript: (hostId, agent) => readTranscript(server, hostId, agent),
    agentCommand: async (key) => resolveAgentCommand({ key, projects: await pm.getProjects() }),
    hostName: (hostId) => pm.hostLabel(hostId),
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
  });
}

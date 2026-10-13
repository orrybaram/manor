/**
 * The host server's agents (ADR-218 D2): the second reader of the daemon's
 * hook journal.
 *
 * In slice 1 the desktop and the host server both own the agents on this
 * host, and agree by construction: each replays the same journal through the
 * same ingestion path (`AgentHookServer.ingestHookPayload`) into the same
 * pure reconciler (`createAgentStatusDriver`). This module is that path on
 * the host server, built from the very parts `app-lifecycle.ts` uses, minus
 * what has no meaning here:
 *
 * - every agent's host is `local` — the server is local to itself;
 * - no dock badge, no desktop notification: a transition worth telling
 *   someone about goes to `onAgentStatus` (ticket 3 hangs push on it);
 * - no stats.
 *
 * `__tests__/two-readers.test.ts` pins the agreement: one recorded journal
 * fed to this and to the desktop's wiring must leave every pane in the same
 * state.
 */

import { AgentHookServer } from "../agent-hooks";
import type { AgentHookEvent } from "../agent-hook-events";
import { AgentManager, type AgentInfo } from "../agent-persistence";
import {
  createAgentStatusDriver,
  type AgentStatusDriver,
} from "../agent-status/driver";
import type { PaneContext } from "../agent-status/effects";
import { NotificationCoalescer, type HookSink } from "../backend/hook-feed";
import { LOCAL_HOST_ID } from "../backend/types";
import type { BroadcastBus } from "../renderer-broadcast";
import type { AgentStatus } from "../terminal-host/types";

export type AgentStatusSink = (
  agent: AgentInfo,
  prevStatus: string | null | undefined,
  newStatus: AgentStatus,
) => void;

export interface HostAgentsOptions {
  /** Where `agents.json` lives: the server's `dataDir`. */
  dataDir: string;
  /**
   * Where `agents.updated` / `agents.status` go: the host server's own bus,
   * which its bridge and chat mirror listen on (`./server.ts`).
   */
  publish: BroadcastBus["publish"];
  retentionDays?: number;
  /**
   * The project a pane belongs to, for a new agent's record. The desktop
   * learns it from its renderer (`agents.setPaneContext`); the host server
   * from the owner's manifest and layout (`./owner.ts`, `paneContextFrom`).
   */
  getPaneContext?: (paneId: string) => PaneContext | undefined;
  /** A status transition the desktop would notify about; replays coalesced. */
  onAgentStatus?: AgentStatusSink;
  /** After the reconciler has seen a hook (the chat mirror pokes its pane). */
  onHook?: (event: AgentHookEvent) => void;
  /** Driver clocks and log, injectable so two readers can be compared. */
  monoClock?: () => number;
  wallClock?: () => number;
  log?: (message: string) => void;
}

export interface HostAgents {
  agentManager: AgentManager;
  driver: AgentStatusDriver;
  unseenRespondedAgents: Set<string>;
  unseenInputAgents: Set<string>;
  /** Where the hook feed delivers each journaled hook, replayed or live. */
  hookSink: HookSink;
  /** Publish an agent to every bridge connection, with its unseen flags. */
  broadcastAgent(agent: AgentInfo): void;
}

export function createHostAgents(opts: HostAgentsOptions): HostAgents {
  const agentManager = new AgentManager(
    opts.dataDir,
    opts.retentionDays,
    () => LOCAL_HOST_ID,
  );
  const unseenRespondedAgents = new Set<string>();
  const unseenInputAgents = new Set<string>();

  // `sendAgentUpdate`'s broadcast, minus the dock badge (notifications.ts
  // is the desktop's and imports Electron).
  const broadcastAgent = (agent: AgentInfo): void => {
    opts.publish("agents", "updated", agent, {
      responded: unseenRespondedAgents.has(agent.id),
      requires_input: unseenInputAgents.has(agent.id),
    });
  };

  // Replayed hooks hold their notifications until the catch-up is done,
  // exactly as on the desktop: a night of hooks is one per agent.
  const coalescer = new NotificationCoalescer((agent, prevStatus, newStatus) =>
    opts.onAgentStatus?.(agent, prevStatus, newStatus),
  );

  const driver = createAgentStatusDriver({
    agentManager,
    getPaneContext: (paneId) => opts.getPaneContext?.(paneId),
    getPaneHostId: () => LOCAL_HOST_ID,
    unseenRespondedAgents,
    unseenInputAgents,
    broadcastAgent,
    maybeSendNotification: coalescer.send,
    publishPaneStatus: (update) =>
      opts.publish("agents", "status", update),
    ...(opts.monoClock ? { monoClock: opts.monoClock } : {}),
    ...(opts.wallClock ? { wallClock: opts.wallClock } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });

  // The one ingestion path (ADR-178 §2). Its HTTP listener is never started:
  // on a remote host the daemon's own listener journals the hooks, and they
  // reach this server through the journal like they reach the desktop.
  const ingestion = new AgentHookServer();
  ingestion.setRelay((event) => {
    driver.hook(event);
    opts.onHook?.(event);
  });

  const hookSink: HookSink = {
    ingest: (payload, { hostId, replay }) => {
      const ingest = () => ingestion.ingestHookPayload(payload, { hostId });
      if (replay) coalescer.hold(hostId, ingest);
      else ingest();
    },
    replayFinished: (hostId) => coalescer.flush(hostId),
  };

  return {
    agentManager,
    driver,
    unseenRespondedAgents,
    unseenInputAgents,
    hookSink,
    broadcastAgent,
  };
}

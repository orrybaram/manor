/**
 * The agent pipeline: how a hook becomes
 * an Agent's status, built once for every server that owns agents, by
 * `createManorServer` (`../server/create-manor-server.ts`).
 *
 *   hook feed / HTTP ──▶ hookSink ──▶ AgentHookServer.ingestHookPayload
 *     ──▶ relay ──▶ Status reconciler's driver ──▶ agents.json, broadcasts
 *
 * Replayed hooks hold their notifications until the catch-up is done
 * (`NotificationCoalescer`): a night of hooks is one notification per agent.
 * What differs between the two platforms — the host a pane runs on, where
 * an Agent's broadcast and a pane's status go, who hears a transition — is
 * passed in. Electron-free: the host server bundles it.
 *
 * `../host-server/__tests__/two-readers.test.ts` builds the desktop's and the
 * host server's pipelines through `serverAgentPipelineOptions` and requires
 * them to agree.
 */

import { AgentHookServer } from "../agent-hooks";
import type { AgentHookEvent } from "../agent-hook-events";
import { NotificationCoalescer, type HookSink } from "../backend/hook-feed";
import type { PaneFacts } from "../terminal-host/types";
import {
  createAgentStatusDriver,
  type AgentStatusDriver,
  type AgentStatusDriverDeps,
} from "./driver";
import type { EffectApplierDeps, PaneContext } from "./effects";
import type { UnseenAgents } from "./unseen-agents";

export interface AgentPipelineOptions
  extends Pick<
    EffectApplierDeps,
    | "agentManager"
    | "getPaneContext"
    | "getPaneHostId"
    | "broadcastAgent"
    | "publishPaneStatus"
  > {
  /** The server's unseen flags, written by the reconciler. */
  unseen: UnseenAgents;
  /** A status transition worth a notification; a replay's are coalesced. */
  onStatus: EffectApplierDeps["maybeSendNotification"];
  /** After the reconciler has seen a hook (the chat mirror pokes its pane). */
  onHook?: (event: AgentHookEvent) => void;
  /** The driver's hook observer (the desktop's stats tap). */
  onHookEvent?: AgentStatusDriverDeps["onHookEvent"];
  /** Driver clocks and log, injectable so two pipelines can be compared. */
  clocks?: Pick<AgentStatusDriverDeps, "monoClock" | "wallClock" | "log">;
}

/** A status transition worth telling someone about (`AgentPipelineOptions.onStatus`). */
export type AgentStatusSink = AgentPipelineOptions["onStatus"];

/**
 * What `createManorServer` hands the pipeline: the pane contexts renderers
 * set as a map, everything else as `AgentPipelineOptions`.
 */
export interface ServerAgentPipelineDeps extends Omit<AgentPipelineOptions, "getPaneContext"> {
  /** What a renderer said about a pane (`agents.setPaneContext`): an override. */
  paneContexts: ReadonlyMap<string, PaneContext>;
  /**
   * A pane's context from the server's own state: the
   * workspace whose layout holds the pane, and the project that owns that
   * workspace. A pane the server launched has one before any renderer has
   * mounted it.
   */
  layoutPaneContext?: (paneId: string) => PaneContext | undefined;
}

/**
 * The server's configuration of the pipeline, in one place so the
 * two-readers test builds both readers the way `createManorServer` does.
 */
export function serverAgentPipelineOptions(deps: ServerAgentPipelineDeps): AgentPipelineOptions {
  const { paneContexts, layoutPaneContext, ...rest } = deps;
  return {
    ...rest,
    getPaneContext: (paneId) => paneContexts.get(paneId) ?? layoutPaneContext?.(paneId),
  };
}

export interface AgentPipeline {
  driver: AgentStatusDriver;
  /** Where a hook feed delivers each journaled hook, replayed or live. */
  hookSink: HookSink;
  /**
   * The one ingestion path. Hooks ingested before `start()` are queued and
   * replayed into the driver then.
   */
  ingestion: AgentHookServer;
  /** Relay hooks into the driver and start its tick. */
  start(): void;
  stop(): void;
}

/**
 * A hook sink over `ingestion`: live hooks go straight in; a replayed hook's
 * notifications are held per host until `replayFinished`.
 */
export function coalescingHookSink(
  ingestion: AgentHookServer,
  coalescer: NotificationCoalescer,
): HookSink {
  return {
    ingest: (payload, { hostId, replay }) => {
      const ingest = () => ingestion.ingestHookPayload(payload, { hostId });
      if (replay) coalescer.hold(hostId, ingest);
      else ingest();
    },
    replayFinished: (hostId) => coalescer.flush(hostId),
  };
}

export function createAgentPipeline(opts: AgentPipelineOptions): AgentPipeline {
  const coalescer = new NotificationCoalescer(opts.onStatus);
  const driver = createAgentStatusDriver({
    agentManager: opts.agentManager,
    getPaneContext: opts.getPaneContext,
    getPaneHostId: opts.getPaneHostId,
    unseenRespondedAgents: opts.unseen.responded,
    unseenInputAgents: opts.unseen.requiresInput,
    broadcastAgent: opts.broadcastAgent,
    maybeSendNotification: coalescer.send,
    publishPaneStatus: opts.publishPaneStatus,
    ...(opts.onHookEvent ? { onHookEvent: opts.onHookEvent } : {}),
    ...opts.clocks,
  });
  const ingestion = new AgentHookServer();

  return {
    driver,
    hookSink: coalescingHookSink(ingestion, coalescer),
    ingestion,
    start() {
      ingestion.setRelay((event) => {
        driver.hook(event);
        opts.onHook?.(event);
      });
      driver.start();
    },
    stop() {
      driver.stop();
    },
  };
}

/** The pane calls a resync needs from a host's backend. */
interface PaneFactsSource {
  listSessions(): Promise<Array<{ sessionId: string }>>;
  getPaneFacts(sessionId: string): Promise<PaneFacts | null>;
}

/**
 * Resync a host's panes after it (re)connects: the `paneFacts` stream has
 * nothing to replay, so ask for each live session's current facts. Without
 * `sessionIds`, every session the host has now. Rejects when the host cannot
 * be asked; callers log it.
 */
export async function resyncPaneFacts(
  pty: PaneFactsSource,
  driver: Pick<AgentStatusDriver, "resync">,
  sessionIds?: readonly string[],
): Promise<void> {
  const ids = sessionIds ?? (await pty.listSessions()).map((s) => s.sessionId);
  await driver.resync(ids, (id) => pty.getPaneFacts(id));
}

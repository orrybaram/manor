/**
 * The agent pipeline (ADR-178 §2, ADR-184, ADR-225 S1): how a hook becomes
 * an Agent's status, built once for both compositions that own agents — the
 * desktop's `initApp()` and the host server's `createHostAgents`.
 *
 *   hook feed / HTTP ──▶ hookSink ──▶ AgentHookServer.ingestHookPayload
 *     ──▶ relay ──▶ Status reconciler's driver ──▶ agents.json, broadcasts
 *
 * Replayed hooks hold their notifications until the catch-up is done
 * (`NotificationCoalescer`): a night of hooks is one notification per agent.
 * What differs between the two compositions — the host a pane runs on, where
 * an Agent's broadcast and a pane's status go, who hears a transition — is
 * passed in. Electron-free: the host server bundles it.
 *
 * `../host-server/__tests__/two-readers.test.ts` builds the desktop's and the
 * host server's pipelines through this factory and requires them to agree.
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

export interface AgentPipelineOptions
  extends Pick<
    EffectApplierDeps,
    | "agentManager"
    | "getPaneContext"
    | "getPaneHostId"
    | "unseenRespondedAgents"
    | "unseenInputAgents"
    | "broadcastAgent"
    | "publishPaneStatus"
  > {
  /** A status transition worth a notification; a replay's are coalesced. */
  onStatus: EffectApplierDeps["maybeSendNotification"];
  /** After the reconciler has seen a hook (the chat mirror pokes its pane). */
  onHook?: (event: AgentHookEvent) => void;
  /** The driver's hook observer (the desktop's stats tap, ADR-168 §2). */
  onHookEvent?: AgentStatusDriverDeps["onHookEvent"];
  /** Driver clocks and log, injectable so two pipelines can be compared. */
  clocks?: Pick<AgentStatusDriverDeps, "monoClock" | "wallClock" | "log">;
}

/**
 * What the desktop's `initApp()` hands the pipeline: the renderer's pane
 * contexts as a map, everything else as `AgentPipelineOptions`.
 */
export interface DesktopAgentPipelineDeps extends Omit<AgentPipelineOptions, "getPaneContext"> {
  paneContexts: ReadonlyMap<string, PaneContext>;
}

/**
 * The desktop's configuration of the pipeline, in one place so the
 * two-readers test builds its desktop reader the way `initApp()` does.
 */
export function desktopAgentPipelineOptions(deps: DesktopAgentPipelineDeps): AgentPipelineOptions {
  const { paneContexts, ...rest } = deps;
  return { ...rest, getPaneContext: (paneId) => paneContexts.get(paneId) };
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
    unseenRespondedAgents: opts.unseenRespondedAgents,
    unseenInputAgents: opts.unseenInputAgents,
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

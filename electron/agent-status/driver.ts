/**
 * The Status reconciler's driver (ADR-184 §1).
 *
 * A thin shell around the pure `reconcile()`:
 * - holds the per-pane `PaneAgentState`s;
 * - feeds each Status signal in (`signal`), with the persisted Agent it
 *   concerns as context;
 * - applies the resulting effects exactly once per signal, whatever the number
 *   of renderer windows (the caller subscribes once, in main);
 * - runs one tick interval, on the old sweep cadence, that carries every
 *   time-based rule (held-Stop drain, stuck-working, orphan recovery);
 * - resyncs Pane facts after a host (re)connects (`resync`);
 * - remembers which panes a daemon replacement is about to kill
 *   (`expectPaneLoss`, ADR-185 §A), and tells the reconciler, so their Agents
 *   are not completed by the SessionEnd that follows.
 *
 * Replaces `createHookRelay`'s interior (ADR-139); the old relay was deleted
 * by ADR-184 ticket 4.
 */

import type { AgentHookEvent } from "../agent-hook-events";
import type { AgentInfo } from "../agent-persistence";
import type { PaneFacts } from "../terminal-host/types";
import { applyStatusEffects, type EffectApplierDeps, type PaneStatusUpdate } from "./effects";
import { initialPaneState, reconcile, stateFromSavedAgent } from "./reconciler";
import type {
  Effect,
  PaneAgentState,
  ReconcileContext,
  ReconcileResult,
  StatusSignal,
} from "./types";

/** How often the tick runs (the old relay's `SWEEP_INTERVAL_MS`). */
export const TICK_INTERVAL_MS = 10_000;

/**
 * How long a pane's expected-loss window lasts by default (ADR-185 §A): ample
 * for the killed agent's SessionEnd hook to arrive (it takes well under a
 * second), short enough that a later, genuine exit completes as usual.
 */
export const EXPECTED_PANE_LOSS_TTL_MS = 60_000;

/** What a hook observer (the stats tap) learns about how a hook was treated. */
export interface HookObservation {
  /**
   * Whether the hook came from the pane's root session — the agent the user
   * started there — read after the reconciler ran, so a SessionStart that
   * replaced the root counts as root. True for hooks without a session id.
   */
  isRootSession: boolean;
  /** The root session a SessionStart just replaced, or null. */
  replacedRootSessionId: string | null;
}

export interface AgentStatusDriverDeps extends EffectApplierDeps {
  /**
   * Fire-and-forget observer of every hook signal, called after its effects
   * were applied (ADR-168 §2). Throws are logged and swallowed.
   */
  onHookEvent?: (
    event: AgentHookEvent,
    effects: readonly Effect[],
    observation: HookObservation,
  ) => void;
  /** The agent-status debug log. Defaults to `console.debug`. */
  log?: (message: string) => void;
  /** Monotonic ms. Defaults to `process.hrtime.bigint() / 1e6`. */
  monoClock?: () => number;
  /** Wall-clock ms. Defaults to `Date.now()`. */
  wallClock?: () => number;
}

/** The part of the driver signal sources need (IPC handlers, routes). */
export interface AgentStatusSignals {
  signal(paneId: string, signal: StatusSignal): ReconcileResult;
}

export interface AgentStatusDriver extends AgentStatusSignals {
  /** Feed a hook: `signal(event.paneId, { type: "hook", event })`. */
  hook(event: AgentHookEvent): ReconcileResult;
  /** Run the time-based rules once, over every pane and orphaned Agent. */
  tick(): void;
  /** Start the tick interval (idempotent). */
  start(): void;
  /** Stop the tick interval. */
  stop(): void;
  /**
   * Fetch each session's current Pane facts and feed them in, after a host
   * (re)connect. A session the host no longer has (null) is skipped.
   */
  resync(
    sessionIds: readonly string[],
    getPaneFacts: (sessionId: string) => Promise<PaneFacts | null>,
  ): Promise<void>;
  /** Drop a pane's state (its pty exited). */
  forgetPane(paneId: string): void;
  /**
   * These panes' ptys are about to die because their daemon is being replaced
   * (ADR-185 §A). For `ttlMs` (default `EXPECTED_PANE_LOSS_TTL_MS`), or until
   * the pane's next `SessionStart`, a `SessionEnd` resets the pane without
   * completing its Agent (rule H8a), so the renderer's cold restore resumes it.
   * Survives `forgetPane`: the pty's exit comes before the SessionEnd.
   */
  expectPaneLoss(paneIds: readonly string[], ttlMs?: number): void;
  /** Whether the pane is inside an expected-loss window (see `expectPaneLoss`). */
  isPaneLossExpected(paneId: string): boolean;
  /** The pane's current state, if the driver has seen a signal for it. */
  getPaneState(paneId: string): PaneAgentState | undefined;
  /**
   * Every pane's currently published Agent status (ADR-184 ticket 5) — what
   * `agents:getPaneStatuses` hands a window on startup, so it paints current
   * dots instead of waiting for the next signal to publish one.
   */
  getAllPaneStatuses(): PaneStatusUpdate[];
}

function defaultMonoClock(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** The key used for an orphaned Agent that no longer has a pane. */
const NO_PANE = "__no-pane__";

export function createAgentStatusDriver(deps: AgentStatusDriverDeps): AgentStatusDriver {
  const {
    agentManager,
    onHookEvent,
    log = (message: string) => console.debug(message),
    monoClock = defaultMonoClock,
    wallClock = () => Date.now(),
  } = deps;

  const states = new Map<string, PaneAgentState>();
  /** Expected-loss windows (ADR-185 §A): pane id → monotonic deadline. */
  const expectedLoss = new Map<string, number>();
  let interval: ReturnType<typeof setInterval> | null = null;

  // Boot timestamps for the orphan rule's age clamp (ADR-132, as in the old
  // relay's `agentMonotonicAgeMs`).
  const BOOT_MONO_MS = monoClock();
  const BOOT_WALL_MS = wallClock();

  /**
   * An Agent's age, from its wall-clock `activatedAt`, clamped by the
   * driver's monotonic run-time: after a suspend/resume the wall clock jumps
   * but the monotonic one does not, so wall-only math would force every
   * mid-turn Agent to responded on wake.
   */
  function agentMonotonicAgeMs(agent: AgentInfo): number {
    if (!agent.activatedAt) return 0;
    const wallNow = wallClock();
    const wallAge = wallNow - Date.parse(agent.activatedAt);
    if (Number.isNaN(wallAge) || wallAge < 0) return 0;
    const monoSinceBoot = monoClock() - BOOT_MONO_MS;
    const wallSinceBoot = wallNow - BOOT_WALL_MS;
    if (wallSinceBoot > monoSinceBoot) return Math.min(wallAge, monoSinceBoot);
    return wallAge;
  }

  /**
   * The persisted Agent a signal concerns (see `ReconcileContext`): for a hook
   * the Agent of its session; otherwise the root session's Agent, falling back
   * to the Agent bound to the pane.
   */
  function existingAgentFor(state: PaneAgentState, signal: StatusSignal): AgentInfo | null {
    if (signal.type === "hook") {
      const sessionId = signal.event.sessionId;
      return sessionId ? agentManager.getAgentBySessionId(sessionId) : null;
    }
    if (state.rootSessionId !== null) {
      const rootAgent = agentManager.getAgentBySessionId(state.rootSessionId);
      if (rootAgent) return rootAgent;
    }
    return agentManager.getAgentByPaneId(state.paneId);
  }

  function describe(signal: StatusSignal): string {
    switch (signal.type) {
      case "hook":
        return `hook ${signal.event.type} session=${signal.event.sessionId}`;
      case "paneFacts":
        return "paneFacts";
      case "tick":
        return "tick";
      case "user":
        return `user ${signal.action}`;
    }
  }

  /**
   * Reconcile one signal against `state`, store the result (unless `store`
   * is false) and apply its effects once. `dropPublish` discards the
   * `PublishPaneStatus` effect, for a state that is not a real pane's.
   */
  function run(
    paneId: string,
    state: PaneAgentState,
    signal: StatusSignal,
    ctx: ReconcileContext,
    opts: { store: boolean; dropPublish?: boolean } = { store: true },
  ): ReconcileResult {
    const result = reconcile(state, signal, ctx);
    if (opts.store) states.set(paneId, result.state);

    const effects = opts.dropPublish
      ? result.effects.filter((e) => e.kind !== "PublishPaneStatus")
      : result.effects;

    if (signal.type === "hook" || effects.length > 0) {
      log(
        `[agent-status] pane=${paneId} ${describe(signal)} → ${result.status} (${result.reason})` +
          (effects.length > 0 ? ` effects=${effects.map((e) => e.kind).join(",")}` : ""),
      );
    }

    applyStatusEffects(effects, {
      ...deps,
      publishPaneStatus: (update) => {
        log(`[agent-status] publish pane=${update.paneId} ${update.status} (${update.reason})`);
        deps.publishPaneStatus(update);
      },
    });
    return { ...result, effects };
  }

  /**
   * A pane seen for the first time since main started, whose saved Agent is
   * still active (a main restart while the daemon kept the agent running):
   * restore its state from that Agent and publish it, before the signal is
   * applied on top (ADR-184). Seeded for Pane facts (resync and the live
   * stream), and for a hook only from that same session — a hook from any
   * other session claims the pane afresh, as before.
   */
  function seedFromSavedAgent(paneId: string, sig: StatusSignal, nowMs: number): PaneAgentState {
    const initial = initialPaneState(paneId);
    if (sig.type !== "paneFacts" && sig.type !== "hook") return initial;
    const agent = agentManager.getAgentByPaneId(paneId);
    if (!agent) return initial;
    if (sig.type === "hook" && sig.event.sessionId !== agent.agentSessionId) return initial;
    const seeded = stateFromSavedAgent(paneId, agent, nowMs);
    if (seeded.rootSessionId === null) return initial;
    states.set(paneId, seeded);
    log(
      `[agent-status] pane=${paneId} restored from saved agent ${agent.id} → ${seeded.status}`,
    );
    if (seeded.status !== initial.status || seeded.kind !== initial.kind) {
      applyStatusEffects(
        [
          {
            kind: "PublishPaneStatus",
            paneId,
            status: seeded.status,
            reason: seeded.statusReason,
            agentKind: seeded.kind,
          },
        ],
        {
          ...deps,
          publishPaneStatus: (update) => {
            log(`[agent-status] publish pane=${update.paneId} ${update.status} (${update.reason})`);
            deps.publishPaneStatus(update);
          },
        },
      );
    }
    return seeded;
  }

  /**
   * Whether `paneId` is inside its expected-loss window at `nowMs`. A window
   * that has run out is dropped here.
   */
  function paneLossExpected(paneId: string, nowMs: number): boolean {
    const deadline = expectedLoss.get(paneId);
    if (deadline === undefined) return false;
    if (nowMs < deadline) return true;
    expectedLoss.delete(paneId);
    return false;
  }

  function signal(paneId: string, sig: StatusSignal): ReconcileResult {
    const nowMs = sig.type === "tick" ? sig.nowMs : monoClock();
    // The pane's new session has started: its window is over, and the new
    // session's own SessionEnd completes it as usual.
    if (sig.type === "hook" && sig.event.type === "SessionStart" && expectedLoss.delete(paneId)) {
      log(`[agent-status] pane=${paneId} expected-loss window ended by SessionStart`);
    }
    const state = states.get(paneId) ?? seedFromSavedAgent(paneId, sig, nowMs);
    const existingAgent = existingAgentFor(state, sig);
    const ctx: ReconcileContext = { nowMs, existingAgent };
    if (paneLossExpected(paneId, nowMs)) ctx.expectedPaneLoss = true;
    if (sig.type === "tick" && existingAgent) {
      ctx.existingAgentAgeMs = agentMonotonicAgeMs(existingAgent);
    }
    const result = run(paneId, state, sig, ctx);

    if (sig.type === "hook" && onHookEvent) {
      // Observers run last and cannot change what the reconciler did. A broken
      // observer is a stats bug, never an Agent-status bug.
      const { event } = sig;
      const root = result.state.rootSessionId;
      const isRootSession = event.sessionId === null || root === null || root === event.sessionId;
      const replacedRootSessionId =
        event.type === "SessionStart" &&
        state.rootSessionId !== null &&
        state.rootSessionId !== root
          ? state.rootSessionId
          : null;
      try {
        onHookEvent(event, result.effects, { isRootSession, replacedRootSessionId });
      } catch (error) {
        console.error("[agent-status] onHookEvent observer threw:", error);
      }
    }
    return result;
  }

  function tick(): void {
    const nowMs = monoClock();
    const covered = new Set<string>();

    // Drop expected-loss windows that have run out.
    for (const paneId of [...expectedLoss.keys()]) paneLossExpected(paneId, nowMs);

    for (const paneId of [...states.keys()]) {
      const state = states.get(paneId);
      if (!state) continue;
      const existingAgent = existingAgentFor(state, { type: "tick", nowMs });
      if (existingAgent) covered.add(existingAgent.id);
      const ctx: ReconcileContext = {
        nowMs,
        existingAgent,
        ...(existingAgent ? { existingAgentAgeMs: agentMonotonicAgeMs(existingAgent) } : {}),
      };
      run(paneId, state, { type: "tick", nowMs }, ctx);
    }

    // Orphans (ADR-132): active Agents no pane state stands for — their pane
    // has had no signal since main started, or they have no pane at all.
    for (const agent of agentManager.getActiveAgents()) {
      if (covered.has(agent.id)) continue;
      const ctx: ReconcileContext = {
        nowMs,
        existingAgent: agent,
        existingAgentAgeMs: agentMonotonicAgeMs(agent),
      };
      const paneId = agent.paneId;
      if (paneId !== null && !states.has(paneId)) {
        // Keep the state only if something happened, so idle panes of
        // finished Agents do not pile up.
        const result = run(paneId, initialPaneState(paneId), { type: "tick", nowMs }, ctx, {
          store: false,
        });
        if (result.effects.length > 0) states.set(paneId, result.state);
      } else {
        // No pane, or its pane shows another Agent: recover it without
        // touching any pane's state or dot.
        run(NO_PANE, initialPaneState(NO_PANE), { type: "tick", nowMs }, ctx, {
          store: false,
          dropPublish: true,
        });
      }
    }
  }

  async function resync(
    sessionIds: readonly string[],
    getPaneFacts: (sessionId: string) => Promise<PaneFacts | null>,
  ): Promise<void> {
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        let facts: PaneFacts | null;
        try {
          facts = await getPaneFacts(sessionId);
        } catch (error) {
          log(`[agent-status] resync: getPaneFacts(${sessionId}) failed: ${String(error)}`);
          return;
        }
        if (facts) signal(sessionId, { type: "paneFacts", facts });
      }),
    );
  }

  return {
    signal,
    hook: (event) => signal(event.paneId, { type: "hook", event }),
    tick,
    start() {
      if (interval) return;
      interval = setInterval(() => {
        try {
          tick();
        } catch (error) {
          console.error("[agent-status] tick failed:", error);
        }
      }, TICK_INTERVAL_MS);
    },
    stop() {
      if (interval) clearInterval(interval);
      interval = null;
    },
    resync,
    forgetPane(paneId) {
      states.delete(paneId);
    },
    expectPaneLoss(paneIds, ttlMs = EXPECTED_PANE_LOSS_TTL_MS) {
      const deadline = monoClock() + ttlMs;
      for (const paneId of paneIds) expectedLoss.set(paneId, deadline);
      if (paneIds.length > 0) {
        log(
          `[agent-status] daemon replacing: expecting loss of ${paneIds.length} pane(s) ` +
            `for ${ttlMs}ms: ${paneIds.join(",")}`,
        );
      }
    },
    isPaneLossExpected: (paneId) => paneLossExpected(paneId, monoClock()),
    getPaneState: (paneId) => states.get(paneId),
    getAllPaneStatuses() {
      const result: PaneStatusUpdate[] = [];
      for (const [paneId, state] of states) {
        if (paneId === NO_PANE) continue;
        result.push({
          paneId,
          status: state.status,
          reason: state.statusReason,
          kind: state.kind,
        });
      }
      return result;
    },
  };
}

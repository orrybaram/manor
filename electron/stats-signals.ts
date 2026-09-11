/**
 * Pure signal predicates and mappings for the stats layer (ADR-168).
 *
 * This module deliberately imports nothing at runtime — not Electron, not Node
 * — so the logic that decides *what counts* can be unit-tested without a
 * running app. Everything below is either a predicate or a pure function of its
 * arguments; the only mutation is the caller-owned `SignalTrackerState`.
 */

import type { AgentHookEvent } from "./agent-hook-events";
import type { Effect } from "./hook-relay-transition";
import type { StatCounter, StatGauge } from "./stats-store";

/**
 * Agent statuses that make a termination a *kill*: any live agent that has
 * reported a status. Finished (`responded`, `idle`) agents count too — closing
 * a session the user could still have prompted is a kill. Only an agent that
 * never reported anything (`lastAgentStatus == null`) is exempt (ADR-168 §3).
 */
export const KILL_STATUSES: ReadonlySet<string> = new Set([
  "working",
  "thinking",
  "requires_input",
  "responded",
  "idle",
]);

/**
 * Whether terminating this agent counts as a kill. Defined once so every close
 * path (`agents:abandonForPane`, `processes:killSession`, `processes:killAll`)
 * shares the same rule.
 */
export function isKill(agent: {
  status: string;
  lastAgentStatus: string | null;
}): boolean {
  return (
    agent.status === "active" &&
    agent.lastAgentStatus != null &&
    KILL_STATUSES.has(agent.lastAgentStatus)
  );
}

/**
 * The subset of kills that interrupt an agent mid-thought: it still had work in
 * flight or was waiting on the user when the trigger was pulled. Tracked as a
 * separate counter (`agentsKilledMidThought`) alongside the broader kill count.
 */
export const MID_THOUGHT_STATUSES: ReadonlySet<string> = new Set([
  "working",
  "thinking",
  "requires_input",
]);

export function isMidThoughtKill(agent: {
  status: string;
  lastAgentStatus: string | null;
}): boolean {
  return (
    isKill(agent) &&
    agent.lastAgentStatus != null &&
    MID_THOUGHT_STATUSES.has(agent.lastAgentStatus)
  );
}

/**
 * Every counter a termination of this agent should bump. Empty when it is not
 * a kill at all. Call sites loop over this so the two kill counters can never
 * drift apart.
 */
export function killCounters(agent: {
  status: string;
  lastAgentStatus: string | null;
}): StatCounter[] {
  if (!isKill(agent)) return [];
  return isMidThoughtKill(agent)
    ? ["agentsKilled", "agentsKilledMidThought"]
    : ["agentsKilled"];
}

// ── Hook-event → counter deltas (ADR-168 §2, first table row) ──

/**
 * Agent statuses that make a live agent count toward *concurrency*: it is
 * mid-turn or waiting on the user, so it is genuinely one of the plates the
 * user is spinning. An agent that has finished its turn (`responded`), ended
 * (`complete`, `idle`) or errored is still `status: "active"` in the store —
 * its pane is open and resumable — but it is not competing for attention, so
 * counting it would make the swarm gauge a count of open panes.
 */
export const BUSY_AGENT_STATUSES: ReadonlySet<string> = new Set([
  "working",
  "thinking",
  "requires_input",
]);

/**
 * How many of `agents` are actually busy right now — the sample behind the
 * `maxConcurrentAgents` gauge and the Swarm badge.
 */
export function countBusyAgents(
  agents: readonly { status: string; lastAgentStatus: string | null }[],
): number {
  let count = 0;
  for (const agent of agents) {
    if (agent.status !== "active") continue;
    if (agent.lastAgentStatus === null) continue;
    if (BUSY_AGENT_STATUSES.has(agent.lastAgentStatus)) count++;
  }
  return count;
}

/**
 * Unblock latencies strictly below this are "fast". Exactly at the threshold is
 * not fast — the boundary belongs to the slow side so the badge stays honest.
 */
const FAST_UNBLOCK_MS = 60_000;

export type StatDelta =
  | { counter: StatCounter; n: number }
  | { gauge: StatGauge; value: number };

/**
 * Mutable bookkeeping the mapping needs across events: when each session last
 * entered `requires_input`, in monotonic ms. Held by the caller (StatsStore) so
 * this module stays a pure function of its inputs.
 */
export interface SignalTrackerState {
  blockedAt: Map<string, number>;
}

export function createSignalTracker(): SignalTrackerState {
  return { blockedAt: new Map() };
}

/**
 * Translates one hook event (plus the effects the relay derived from it) into
 * the counter/gauge deltas it should produce.
 *
 * The only mutation is `tracker.blockedAt`; nothing else is touched, and no IO
 * happens here, so the whole "what counts" table is unit-testable without a
 * relay or a store.
 */
export function deltasForHookEvent(
  event: AgentHookEvent,
  effects: readonly Effect[],
  tracker: SignalTrackerState,
  ctx: {
    monoNow: number;
    activeAgentCount: number;
    /**
     * Whether the event belongs to the pane's root session. Defaults to true
     * so callers that cannot tell keep the old (count-everything) behaviour.
     */
    isRootSession?: boolean;
  },
): StatDelta[] {
  // A pane can host more than one agent process: anything the agent itself
  // spawns inherits `MANOR_PANE_ID` and fires the same hooks. The relay
  // already ignores those for agent lifecycle; stats must ignore them too, or
  // prompts and tool calls climb with no user at the keyboard.
  if (ctx.isRootSession === false) return [];

  const deltas: StatDelta[] = [];
  const sessionId = event.sessionId;

  switch (event.type) {
    case "UserPromptSubmit": {
      deltas.push({ counter: "prompts", n: 1 });
      // A prompt after a block is the unblock. Latency is monotonic, so a
      // suspend/resume cannot make it negative.
      const blockedAt = sessionId === null ? undefined : tracker.blockedAt.get(sessionId);
      if (sessionId !== null && blockedAt !== undefined) {
        const elapsed = ctx.monoNow - blockedAt;
        deltas.push({ counter: "unblocks", n: 1 });
        deltas.push({ counter: "unblockMsTotal", n: elapsed });
        if (elapsed < FAST_UNBLOCK_MS) deltas.push({ counter: "fastUnblocks", n: 1 });
        tracker.blockedAt.delete(sessionId);
      }
      break;
    }
    case "PreToolUse":
      deltas.push({ counter: "toolCalls", n: 1 });
      break;
    case "SubagentStart":
      deltas.push({ counter: "subagents", n: 1 });
      break;
    case "Stop":
      deltas.push({ counter: "agentsResponded", n: 1 });
      break;
    case "PermissionRequest":
    case "Notification": {
      deltas.push({ counter: "blocks", n: 1 });
      // Repeated permission prompts inside one wait are the same block: keep
      // the first timestamp so the latency measures the whole wait.
      if (sessionId !== null && !tracker.blockedAt.has(sessionId)) {
        tracker.blockedAt.set(sessionId, ctx.monoNow);
      }
      break;
    }
    default:
      break;
  }

  for (const effect of effects) {
    if (effect.kind === "CreateAgent") {
      deltas.push({ counter: "agentSessions", n: 1 });
      deltas.push({ gauge: "maxConcurrentAgents", value: ctx.activeAgentCount });
    } else if (effect.kind === "DeleteSessionState") {
      tracker.blockedAt.delete(effect.sessionId);
    }
  }

  // A session that ended can never be unblocked; drop its pending wait so the
  // map cannot grow without bound.
  if (event.type === "SessionEnd" && sessionId !== null) {
    tracker.blockedAt.delete(sessionId);
  }

  return deltas;
}

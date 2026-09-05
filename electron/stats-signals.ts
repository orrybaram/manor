/**
 * Pure signal predicates for the stats layer (ADR-168).
 *
 * This module deliberately imports nothing — not Electron, not Node — so the
 * logic that decides *what counts* can be unit-tested without a running app.
 *
 * Ticket 2 adds the hook-event → counter delta mapping here (turning
 * `(event, effects, prevStatusForSession)` into `{counter, n}` /
 * `{gauge, value}` deltas, plus the per-session block latency map). For now the
 * module owns only the "agents killed" predicate.
 */

/**
 * Agent statuses that make a termination a *kill*: the agent still had work in
 * flight or was waiting on the user when the trigger was pulled. `responded`
 * and `idle` agents were done, so closing them is not a kill (ADR-168 §3).
 */
export const KILL_STATUSES: ReadonlySet<string> = new Set([
  "working",
  "thinking",
  "requires_input",
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

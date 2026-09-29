import type { AgentStatus } from "../../../electron.d";

/** Status colours (ADR-198 §1.5); `responded` and `idle` never draw as bars. */
export const STATUS_COLOR: Record<AgentStatus, string> = {
  working: "var(--green)",
  thinking: "var(--accent)",
  requires_input: "var(--red)",
  error: "var(--red)",
  responded: "var(--cyan)",
  idle: "var(--text-dim)",
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Working",
  thinking: "Thinking",
  requires_input: "Waiting on you",
  error: "Errored",
  responded: "Finished",
  idle: "Idle",
};

/** Waiting periods draw as the red stripe pattern at full track height. */
export function isWaitStatus(status: AgentStatus): boolean {
  return status === "requires_input" || status === "error";
}

/** Position of `at` in the window as a CSS percentage, clamped to the track. */
export function pct(at: number, start: number, span: number): number {
  return Math.min(100, Math.max(0, ((at - start) / span) * 100));
}

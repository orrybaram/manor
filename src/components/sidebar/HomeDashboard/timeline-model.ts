import type { AgentStatus } from "../../../electron.d";
import { ACTIVITY_WINDOW_MS } from "../../../store/agent-activity-store";

/** Lane segment colour per status (ADR-198 §1.5); `idle` never draws. */
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

/**
 * The timeline's time domain: the last 3 hours, or — while the recorder is
 * younger than that — everything since it started, so lanes fill the track.
 */
export function timelineWindow(
  now: number,
  startedAt: number,
): { start: number; span: number; partial: boolean } {
  const partial = now - startedAt < ACTIVITY_WINDOW_MS;
  // A floor keeps a just-started recorder from dividing by ~0.
  const span = partial ? Math.max(now - startedAt, 60_000) : ACTIVITY_WINDOW_MS;
  return { start: now - span, span, partial };
}

/** Position of `at` in the window as a CSS percentage, clamped to the track. */
export function pct(at: number, start: number, span: number): number {
  return Math.min(100, Math.max(0, ((at - start) / span) * 100));
}

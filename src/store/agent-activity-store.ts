import { create } from "zustand";
import type {
  AgentActivityEntry,
  AgentActivitySession,
  AgentActivitySnapshot,
  AgentActivityTransition,
  AgentStatus,
} from "../electron.d";

/** History window shown by the Home timeline and stat sparklines. */
export const ACTIVITY_WINDOW_MS = 3 * 60 * 60 * 1000;

/**
 * Renderer cache of main's Agent activity history (ADR-199 §2).
 *
 * Main records and persists; the renderer never mutates its copy. Every change
 * arrives back through `onChanged`, the same split `stats-store` uses.
 */
interface AgentActivityState {
  /** `null` until the first snapshot arrives (broadcast or initial fetch). */
  snapshot: AgentActivitySnapshot | null;
}

export const useAgentActivityStore = create<AgentActivityState>(() => ({
  snapshot: null,
}));

let stopActive: (() => void) | null = null;

/**
 * Load the activity snapshot and keep it fresh. Idempotent — a second call
 * returns the existing stop function.
 */
export function startAgentActivitySync(): () => void {
  if (stopActive) return stopActive;
  const api = window.electronAPI?.agentActivity;
  if (!api) return () => {};

  let stopped = false;
  const unsubscribe = api.onChanged((snapshot) => {
    if (!stopped) useAgentActivityStore.setState({ snapshot });
  });
  api
    .get()
    .then((snapshot) => {
      // A broadcast that landed first is newer than this fetch.
      if (!stopped && useAgentActivityStore.getState().snapshot === null) {
        useAgentActivityStore.setState({ snapshot });
      }
    })
    .catch(() => {
      // leave the snapshot null; the next broadcast recovers
    });

  stopActive = () => {
    stopped = true;
    unsubscribe();
    stopActive = null;
  };
  return stopActive;
}

export interface LaneSegment {
  status: AgentStatus;
  from: number;
  to: number;
}

export interface LaneMarker {
  kind: "finished" | "error";
  at: number;
}

export interface ClosedGap {
  from: number;
  to: number;
}

const isWaiting = (s: AgentStatus) => s === "requires_input" || s === "error";
const isWorking = (s: AgentStatus) => s === "working" || s === "thinking";
const isActive = (s: AgentStatus) => isWaiting(s) || isWorking(s);

/**
 * Convert an Agent's transitions into segments clipped to [windowStart, now],
 * merging adjacent equal statuses and dropping `idle` and `responded` (the
 * latter shows as a marker). Segments are also clipped to the sessions, so
 * nothing crosses a span where Manor was closed.
 */
export function laneSegments(
  transitions: AgentActivityTransition[],
  windowStart: number,
  now: number,
  sessions: AgentActivitySession[],
): LaneSegment[] {
  const out: LaneSegment[] = [];
  for (let i = 0; i < transitions.length; i++) {
    const { status, at } = transitions[i];
    if (status === "idle" || status === "responded") continue;
    const end = i + 1 < transitions.length ? transitions[i + 1].at : now;
    const lo = Math.max(at, windowStart);
    const hi = Math.min(end, now);
    for (const session of sessions) {
      const from = Math.max(lo, session.start);
      const to = Math.min(hi, session.end);
      if (to <= from) continue;
      const last = out[out.length - 1];
      if (last && last.status === status && last.to === from) {
        last.to = to;
      } else {
        out.push({ status, from, to });
      }
    }
  }
  return out;
}

/** Finished / errored moments inside the window, for the lane's markers. */
export function laneMarkers(
  transitions: AgentActivityTransition[],
  windowStart: number,
  now: number,
): LaneMarker[] {
  const out: LaneMarker[] = [];
  for (const { status, at } of transitions) {
    if (at < windowStart || at > now) continue;
    if (status === "responded") out.push({ kind: "finished", at });
    else if (status === "error") out.push({ kind: "error", at });
  }
  return out;
}

/**
 * Spans inside the window not covered by any session — Manor was closed, or
 * had not yet recorded anything (the span before the first session).
 */
export function closedGaps(
  sessions: AgentActivitySession[],
  windowStart: number,
  now: number,
): ClosedGap[] {
  const gaps: ClosedGap[] = [];
  let cursor = windowStart;
  for (const session of [...sessions].sort((a, b) => a.start - b.start)) {
    if (session.end <= cursor) continue;
    if (session.start > cursor) {
      gaps.push({ from: cursor, to: Math.min(session.start, now) });
    }
    cursor = Math.max(cursor, session.end);
    if (cursor >= now) break;
  }
  if (cursor < now) gaps.push({ from: cursor, to: now });
  return gaps.filter((g) => g.to > g.from);
}

/**
 * Order Agents for display: needs you now, then active now, then most recent
 * activity. Only Agents with a working/thinking/requires_input/error segment
 * inside the window are returned.
 */
export function lanePriority(
  agents: Record<string, AgentActivityEntry>,
  windowStart: number,
  now: number,
): string[] {
  const rank = (list: AgentActivityTransition[]) => {
    const current = list[list.length - 1]?.status;
    if (current && isWaiting(current)) return 0;
    if (current && isWorking(current)) return 1;
    return 2;
  };
  /** End of the Agent's latest active segment inside the window, or null. */
  const lastActive = (list: AgentActivityTransition[]): number | null => {
    for (let i = list.length - 1; i >= 0; i--) {
      if (!isActive(list[i].status)) continue;
      const end = i + 1 < list.length ? list[i + 1].at : now;
      if (Math.min(end, now) > windowStart && list[i].at < now) return end;
    }
    return null;
  };
  const recency: Record<string, number> = {};
  const ids: string[] = [];
  for (const [id, entry] of Object.entries(agents)) {
    const at = lastActive(entry.transitions);
    if (at == null) continue;
    recency[id] = at;
    ids.push(id);
  }
  return ids.sort(
    (a, b) =>
      rank(agents[a].transitions) - rank(agents[b].transitions) ||
      recency[b] - recency[a],
  );
}

/**
 * How many Agents matched `predicate` at each step time from `start`, plus a
 * final point at `end`. An Agent's status at t is its last transition at or
 * before t; with none it is not counted.
 */
export function statusCountSeries(
  agents: Record<string, AgentActivityEntry>,
  start: number,
  end: number,
  stepMs: number,
  predicate: (status: AgentStatus) => boolean,
): number[] {
  const times: number[] = [];
  for (let t = start; t < end; t += stepMs) times.push(t);
  times.push(end);

  const counts = times.map(() => 0);
  for (const { transitions } of Object.values(agents)) {
    let idx = -1;
    times.forEach((t, i) => {
      while (idx + 1 < transitions.length && transitions[idx + 1].at <= t) {
        idx++;
      }
      if (idx >= 0 && predicate(transitions[idx].status)) counts[i]++;
    });
  }
  return counts;
}

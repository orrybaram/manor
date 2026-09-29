import { create } from "zustand";
import type { AgentStatus } from "../electron.d";
import { useAppStore } from "./app-store";

/** History window kept in memory (and shown by the Home timeline). */
export const ACTIVITY_WINDOW_MS = 3 * 60 * 60 * 1000;
const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ENTRIES_PER_PANE = 200;

export interface StatusTransition {
  status: AgentStatus;
  at: number;
}

export interface ActivitySample {
  at: number;
  waiting: number;
  working: number;
}

export interface LaneSegment {
  status: AgentStatus;
  from: number;
  to: number;
}

interface AgentActivityState {
  transitions: Record<string, StatusTransition[]>;
  samples: ActivitySample[];
  /** When recording began — UI labels "since HH:MM" if younger than the window. */
  startedAt: number;
}

export const useAgentActivityStore = create<AgentActivityState>(() => ({
  transitions: {},
  samples: [],
  startedAt: Date.now(),
}));

const isWaiting = (s: AgentStatus) => s === "requires_input" || s === "error";
const isWorking = (s: AgentStatus) => s === "working" || s === "thinking";

/**
 * Drop entries older than the window, but keep the latest transition before
 * the window start so a lane can show a segment that began earlier.
 */
function pruneTransitions(
  list: StatusTransition[],
  windowStart: number,
): StatusTransition[] {
  let firstInWindow = list.findIndex((t) => t.at >= windowStart);
  if (firstInWindow === -1) firstInWindow = list.length;
  const start = Math.max(0, firstInWindow - 1);
  const pruned = start > 0 ? list.slice(start) : list;
  return pruned.length > MAX_ENTRIES_PER_PANE
    ? pruned.slice(pruned.length - MAX_ENTRIES_PER_PANE)
    : pruned;
}

/**
 * Convert a pane's transitions into segments clipped to [windowStart, now],
 * merging adjacent equal statuses and dropping `idle`.
 */
export function laneSegments(
  transitions: StatusTransition[],
  windowStart: number,
  now: number,
): LaneSegment[] {
  const out: LaneSegment[] = [];
  for (let i = 0; i < transitions.length; i++) {
    const { status, at } = transitions[i];
    const end = i + 1 < transitions.length ? transitions[i + 1].at : now;
    const from = Math.max(at, windowStart);
    const to = Math.min(end, now);
    if (status === "idle" || to <= from) continue;
    const last = out[out.length - 1];
    if (last && last.status === status && last.to === from) {
      last.to = to;
    } else {
      out.push({ status, from, to });
    }
  }
  return out;
}

/**
 * Order panes for display: needs you now, then active now, then most recent
 * activity. Returns pane ids.
 */
export function lanePriority(
  transitions: Record<string, StatusTransition[]>,
): string[] {
  const rank = (list: StatusTransition[]) => {
    const current = list[list.length - 1]?.status;
    if (current && isWaiting(current)) return 0;
    if (current && isWorking(current)) return 1;
    return 2;
  };
  const lastAt = (list: StatusTransition[]) =>
    list.length ? list[list.length - 1].at : 0;
  return Object.keys(transitions)
    .filter((id) => transitions[id].length > 0)
    .sort((a, b) => {
      const ta = transitions[a];
      const tb = transitions[b];
      return rank(ta) - rank(tb) || lastAt(tb) - lastAt(ta);
    });
}

function recordStatuses(
  statuses: Record<string, { status: AgentStatus }>,
  now: number,
): void {
  const { transitions } = useAgentActivityStore.getState();
  const windowStart = now - ACTIVITY_WINDOW_MS;
  let next: Record<string, StatusTransition[]> | null = null;

  const append = (paneId: string, status: AgentStatus) => {
    next ??= { ...transitions };
    next[paneId] = pruneTransitions(
      [...(next[paneId] ?? []), { status, at: now }],
      windowStart,
    );
  };

  for (const [paneId, s] of Object.entries(statuses)) {
    const last = transitions[paneId]?.[transitions[paneId].length - 1];
    if (!last || last.status !== s.status) append(paneId, s.status);
  }
  // A pane that disappeared is no longer running anything.
  for (const [paneId, list] of Object.entries(transitions)) {
    if (!(paneId in statuses) && list[list.length - 1]?.status !== "idle") {
      append(paneId, "idle");
    }
  }

  if (next) useAgentActivityStore.setState({ transitions: next });
}

function takeSample(now: number): void {
  const statuses = useAppStore.getState().paneAgentStatus;
  let waiting = 0;
  let working = 0;
  for (const { status } of Object.values(statuses)) {
    if (isWaiting(status)) waiting++;
    else if (isWorking(status)) working++;
  }
  const windowStart = now - ACTIVITY_WINDOW_MS;
  const { samples, transitions } = useAgentActivityStore.getState();
  const pruned: Record<string, StatusTransition[]> = {};
  for (const [id, list] of Object.entries(transitions)) {
    pruned[id] = pruneTransitions(list, windowStart);
  }
  useAgentActivityStore.setState({
    samples: [
      ...samples.filter((s) => s.at >= windowStart),
      { at: now, waiting, working },
    ],
    transitions: pruned,
  });
}

let stopActive: (() => void) | null = null;

/**
 * Begin recording agent status history from the app store. Idempotent —
 * a second call returns the existing stop function.
 */
export function startAgentActivityRecorder(): () => void {
  if (stopActive) return stopActive;

  useAgentActivityStore.setState({
    transitions: {},
    samples: [],
    startedAt: Date.now(),
  });
  recordStatuses(useAppStore.getState().paneAgentStatus, Date.now());
  takeSample(Date.now());

  const unsubscribe = useAppStore.subscribe((state, prev) => {
    if (state.paneAgentStatus !== prev.paneAgentStatus) {
      recordStatuses(state.paneAgentStatus, Date.now());
    }
  });
  const timer = setInterval(() => takeSample(Date.now()), SAMPLE_INTERVAL_MS);

  stopActive = () => {
    unsubscribe();
    clearInterval(timer);
    stopActive = null;
  };
  return stopActive;
}

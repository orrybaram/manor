import fs from "node:fs";
import path from "node:path";

import { manorDataDir } from "./paths";

import type { AgentInfo } from "./agent-persistence";
import type { AgentStatus } from "./terminal-host/types";

/**
 * Persistent Agent activity history (ADR-199 §1).
 *
 * Modelled on `stats-store.ts`: in-memory state backed by a JSON file in the
 * data dir, writes debounced through a single timer, a synchronous flush on
 * quit. Main owns this because it sees every status change in one place (the
 * Status reconciler's `publishPaneStatus`) and outlives renderer reloads.
 *
 * History is keyed by Agent id, not pane id: panes are ephemeral, Agents are
 * not. Each Agent carries a small `meta` snapshot so its lane can still be
 * named and coloured after the Agent itself is deleted.
 */

export interface AgentActivityTransition {
  status: AgentStatus;
  /** Epoch ms, main's own clock — so remote hosts' clock skew is irrelevant. */
  at: number;
}

export interface AgentActivityMeta {
  name: string | null;
  projectId: string | null;
  workspacePath: string | null;
  hostId: string;
}

export interface AgentActivityEntry {
  meta: AgentActivityMeta;
  /** Oldest first. Consecutive entries never share a status. */
  transitions: AgentActivityTransition[];
}

/**
 * A span Manor was running. Gaps between sessions were not observed, so the UI
 * shades them as "Manor closed" rather than guessing.
 */
export interface AgentActivitySession {
  start: number;
  end: number;
}

export interface AgentActivitySnapshot {
  agents: Record<string, AgentActivityEntry>;
  /** Oldest first; the last one is the running app, ending at `now`. */
  sessions: AgentActivitySession[];
  now: number;
}

interface PersistedAgentActivity {
  version: 1;
  agents: Record<string, AgentActivityEntry>;
  sessions: AgentActivitySession[];
}

/** How far back history is kept. The timeline itself shows 3 hours. */
export const RETENTION_MS = 24 * 60 * 60 * 1000;
/** Per-Agent transition cap, oldest dropped first. */
export const MAX_TRANSITIONS_PER_AGENT = 500;
/** Agent cap; the least recently active are dropped first. */
export const MAX_AGENTS = 200;
/** Writes coalesce over this window while agents are busy. */
export const SAVE_DEBOUNCE_MS = 2000;
/**
 * The running session's end is persisted this often even when nothing is
 * recorded, so a crash after a long idle stretch doesn't read as "Manor
 * closed" for the whole stretch.
 */
export const HEARTBEAT_MS = 5 * 60 * 1000;

const STATUSES = new Set<string>([
  "idle",
  "thinking",
  "working",
  "requires_input",
  "error",
  "responded",
]);

/**
 * Statuses that show nothing on the timeline by themselves. An Agent whose
 * whole history predates the cutoff and which is sitting in one of these is
 * dropped: there is nothing left in the window to draw for it.
 */
const SETTLED_STATUSES = new Set<AgentStatus>(["idle", "responded", "error"]);

export class AgentActivityStore {
  private dataDir: string;
  private agents: Record<string, AgentActivityEntry>;
  /** Previous app runs, oldest first. Excludes the running one. */
  private pastSessions: AgentActivitySession[];
  private current: AgentActivitySession;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? manorDataDir();
    const state = this.loadState();
    this.agents = state.agents;
    this.pastSessions = state.sessions;
    const now = Date.now();
    this.current = { start: now, end: now };
    this.settleUnfinished();
    this.prune(now);
    this.heartbeatTimer = setInterval(() => this.flush(), HEARTBEAT_MS);
    // Never keep the process alive just to write a heartbeat.
    this.heartbeatTimer.unref?.();
  }

  /**
   * An Agent still thinking / working / waiting on input in the saved history
   * was cut off by the previous run ending (quit or crash) — nothing records a
   * final status for a pane that never comes back. End it as idle when that
   * run was last seen, so it isn't drawn as busy through every later session
   * and can age out. An Agent that does survive gets its live status recorded
   * again when its pane reports in.
   */
  private settleUnfinished(): void {
    const lastSeen = this.pastSessions[this.pastSessions.length - 1]?.end;
    for (const entry of Object.values(this.agents)) {
      const last = entry.transitions[entry.transitions.length - 1];
      if (!last || SETTLED_STATUSES.has(last.status)) continue;
      entry.transitions.push({
        status: "idle",
        at: Math.max(last.at, lastSeen ?? last.at),
      });
    }
  }

  /** Stops the heartbeat. Call after the final `flush()` at quit. */
  dispose(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private filePath(): string {
    return path.join(this.dataDir, "agent-activity.json");
  }

  /** Never throws: a missing or corrupt file just means no history yet. */
  private loadState(): {
    agents: Record<string, AgentActivityEntry>;
    sessions: AgentActivitySession[];
  } {
    try {
      const data = fs.readFileSync(this.filePath(), "utf-8");
      const state: Partial<PersistedAgentActivity> = JSON.parse(data);
      return {
        agents: sanitizeAgents(state.agents),
        sessions: sanitizeSessions(state.sessions),
      };
    } catch {
      return { agents: {}, sessions: [] };
    }
  }

  private writeStateSync(): void {
    const now = Date.now();
    // Every save extends the running session: if the app dies without a
    // clean quit, the recorded span ends at the last write.
    this.current.end = Math.max(this.current.end, now);
    this.prune(now);
    const state: PersistedAgentActivity = {
      version: 1,
      agents: this.agents,
      sessions: [...this.pastSessions, this.current],
    };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.filePath(), JSON.stringify(state));
    } catch (error) {
      console.error("[agent-activity-store] write failed:", error);
    }
  }

  private saveState(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeStateSync();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Writes the current state to disk synchronously, cancelling any pending
   * debounced save. Called on quit so the running session's end is recorded.
   */
  flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.writeStateSync();
  }

  /**
   * Drops history older than `RETENTION_MS`, keeping each Agent's last
   * transition before the cutoff so its first in-window segment has a start.
   * Then applies both caps and trims sessions that ended before the window.
   */
  private prune(now: number): void {
    const cutoff = now - RETENTION_MS;
    for (const [id, entry] of Object.entries(this.agents)) {
      const transitions = entry.transitions;
      let firstInWindow = transitions.findIndex((t) => t.at >= cutoff);
      if (firstInWindow === -1) firstInWindow = transitions.length;
      const keepFrom = Math.max(0, firstInWindow - 1);
      let kept = transitions.slice(keepFrom);
      if (kept.length > MAX_TRANSITIONS_PER_AGENT) {
        kept = kept.slice(kept.length - MAX_TRANSITIONS_PER_AGENT);
      }
      const last = kept[kept.length - 1];
      if (!last || (last.at < cutoff && SETTLED_STATUSES.has(last.status))) {
        delete this.agents[id];
        continue;
      }
      entry.transitions = kept;
    }

    const ids = Object.keys(this.agents);
    if (ids.length > MAX_AGENTS) {
      const lastAt = (id: string) => {
        const t = this.agents[id].transitions;
        return t[t.length - 1]?.at ?? 0;
      };
      ids.sort((a, b) => lastAt(b) - lastAt(a));
      for (const id of ids.slice(MAX_AGENTS)) delete this.agents[id];
    }

    this.pastSessions = this.pastSessions.filter((s) => s.end >= cutoff);
  }

  /** Notifies subscribers. Never lets a listener throw into a caller. */
  private emitChange(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // a broken subscriber must not break recording
      }
    }
  }

  /** Subscribe to every recorded change. Returns an unsubscribe function. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Records `agent` entering `status`. A status equal to the Agent's last one
   * appends nothing — the reconciler republishes on every signal — but the
   * meta snapshot is still refreshed, so a rename is picked up.
   */
  record(agent: AgentInfo, status: AgentStatus, at = Date.now()): void {
    const meta: AgentActivityMeta = {
      name: agent.name,
      projectId: agent.projectId,
      workspacePath: agent.workspacePath,
      hostId: agent.hostId,
    };
    const entry = this.agents[agent.id];
    if (!entry) {
      this.agents[agent.id] = { meta, transitions: [{ status, at }] };
      this.commit();
      return;
    }
    const metaChanged = !sameMeta(entry.meta, meta);
    entry.meta = meta;
    const last = entry.transitions[entry.transitions.length - 1];
    const statusChanged = last?.status !== status;
    if (statusChanged) {
      entry.transitions.push({ status, at });
      if (entry.transitions.length > MAX_TRANSITIONS_PER_AGENT) {
        entry.transitions.splice(
          0,
          entry.transitions.length - MAX_TRANSITIONS_PER_AGENT,
        );
      }
    }
    if (statusChanged || metaChanged) this.commit();
  }

  /** One debounced save and one change emission per mutation. */
  private commit(): void {
    this.saveState();
    this.emitChange();
  }

  /**
   * A pruned, detached copy of the history. The running session ends at
   * `now`: it is still being observed.
   */
  getSnapshot(now = Date.now()): AgentActivitySnapshot {
    this.prune(now);
    const agents: Record<string, AgentActivityEntry> = {};
    for (const [id, entry] of Object.entries(this.agents)) {
      agents[id] = {
        meta: { ...entry.meta },
        transitions: entry.transitions.map((t) => ({ ...t })),
      };
    }
    return {
      agents,
      sessions: [
        ...this.pastSessions.map((s) => ({ ...s })),
        { start: this.current.start, end: Math.max(this.current.end, now) },
      ],
      now,
    };
  }
}

function sameMeta(a: AgentActivityMeta, b: AgentActivityMeta): boolean {
  return (
    a.name === b.name &&
    a.projectId === b.projectId &&
    a.workspacePath === b.workspacePath &&
    a.hostId === b.hostId
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Keeps only well-formed entries: known statuses with finite timestamps,
 * sorted and de-duplicated, and a meta with a host id. Anything else is
 * dropped rather than carried forward.
 */
function sanitizeAgents(agents: unknown): Record<string, AgentActivityEntry> {
  if (!agents || typeof agents !== "object") return {};
  const result: Record<string, AgentActivityEntry> = {};
  for (const [id, raw] of Object.entries(agents as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const { meta, transitions } = raw as Record<string, unknown>;
    if (!meta || typeof meta !== "object" || !Array.isArray(transitions)) {
      continue;
    }
    const m = meta as Record<string, unknown>;
    if (typeof m.hostId !== "string") continue;
    const parsed = transitions
      .filter(
        (t): t is AgentActivityTransition =>
          !!t &&
          typeof t === "object" &&
          typeof (t as Record<string, unknown>).status === "string" &&
          STATUSES.has((t as Record<string, unknown>).status as string) &&
          isFiniteNumber((t as Record<string, unknown>).at),
      )
      .map((t) => ({ status: t.status, at: t.at }))
      .sort((a, b) => a.at - b.at);
    const deduped: AgentActivityTransition[] = [];
    for (const t of parsed) {
      if (deduped[deduped.length - 1]?.status === t.status) continue;
      deduped.push(t);
    }
    if (deduped.length === 0) continue;
    result[id] = {
      meta: {
        name: stringOrNull(m.name),
        projectId: stringOrNull(m.projectId),
        workspacePath: stringOrNull(m.workspacePath),
        hostId: m.hostId,
      },
      transitions: deduped,
    };
  }
  return result;
}

function sanitizeSessions(sessions: unknown): AgentActivitySession[] {
  if (!Array.isArray(sessions)) return [];
  return sessions
    .filter(
      (s): s is AgentActivitySession =>
        !!s &&
        typeof s === "object" &&
        isFiniteNumber((s as Record<string, unknown>).start) &&
        isFiniteNumber((s as Record<string, unknown>).end) &&
        (s as AgentActivitySession).end >= (s as AgentActivitySession).start,
    )
    .map((s) => ({ start: s.start, end: s.end }))
    .sort((a, b) => a.start - b.start);
}

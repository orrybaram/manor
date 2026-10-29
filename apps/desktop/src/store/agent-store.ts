import { create } from "zustand";
import { AgentInfo } from "../electron.d";
import { toast } from "../toast";
import { isWindowFocused } from "../lib/window-focus";
import { useAppStore, selectVisiblePaneIds } from "./app-store";
import { navigateToAgent } from "../utils/agent-navigation";
import { cleanAgentTitle } from "../utils/agent-title";
import { bootAndResync } from "../bridge/resync";
import { provideHostLookups } from "../bridge/host-lookups";

/** Page size used for the initial agent load and for `loadMoreAgents`. */
const TASK_PAGE_SIZE = 100;

export interface AgentStoreState {
  agents: AgentInfo[];
  loading: boolean;
  loaded: boolean;
  /** True when `agents:getAll` last returned a full page — more may exist on disk. */
  hasMore: boolean;
  /** True while `loadMoreAgents` is in flight, to coalesce repeated scroll events. */
  loadingMore: boolean;
  /**
   * Cache of main's unseen-responded Set. Populated by
   * the initial `agents:getUnseen` snapshot and reconciled on every
   * `agent-updated` broadcast. Renderer never resets entries on its own —
   * status-change resets are owned by main and arrive via the broadcast.
   */
  unseenRespondedAgentIds: Set<string>;
  /** Cache of main's unseen-requires-input Set. See `unseenRespondedAgentIds`. */
  unseenInputAgentIds: Set<string>;
  loadAgents: (opts?: {
    projectId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) => Promise<void>;
  loadMoreAgents: (offset: number) => Promise<void>;
  /**
   * Every agent ever recorded whose name, project or workspace path holds
   * each word of `query`. Leaves the store untouched: the Agents modal keeps
   * search results to itself.
   */
  searchAgents: (query: string) => Promise<AgentInfo[]>;
  removeAgent: (agentId: string) => Promise<void>;
  /**
   * Give an agent a user-chosen name. A non-empty name is pinned so the
   * live-title sync in main leaves it alone; an empty name unpins and lets
   * the terminal title take over again.
   */
  renameAgent: (agentId: string, name: string) => Promise<void>;
  receiveAgentUpdate: (
    agent: AgentInfo,
    unseen?: { responded: boolean; requires_input: boolean },
  ) => void;
  markAgentSeen: (agentId: string) => void;
  /**
   * Mark every unseen agent whose pane is currently on screen as seen.
   *
   * Read state used to be set only by `navigateToAgent` — clicking a row in the
   * agent list. Reaching the same pane any other way (focusing it, switching to
   * its tab, switching workspace) left main's unseen flags standing, so the
   * dock badge and the tab/project/workspace dots kept announcing a response
   * the user was already looking at (issue #142).
   */
  markVisibleAgentsSeen: () => void;
}

const paneAgentIndexes = new WeakMap<readonly AgentInfo[], ReadonlyMap<string, string>>();

/**
 * Pane id → id of the agent running in it, derived from `agents` and built
 * once per `agents` change however many rows read it. History rows can share
 * a pane id; the first row in `agents` order (newest first) wins.
 */
export function selectPaneAgentIndex(
  state: Pick<AgentStoreState, "agents">,
): ReadonlyMap<string, string> {
  let index = paneAgentIndexes.get(state.agents);
  if (!index) {
    const built = new Map<string, string>();
    for (const agent of state.agents) {
      if (agent.paneId != null && !built.has(agent.paneId)) built.set(agent.paneId, agent.id);
    }
    index = built;
    paneAgentIndexes.set(state.agents, index);
  }
  return index;
}

// ── Attention toasts: "Agent needs input" / "Agent responded" ──
//
// Derived from main's unseen flags rather than fired once: a toast stands
// while main says the agent is waiting on the user (unseen, and still in the
// status that flagged it) and goes the moment that stops being true — looked
// at in any window, answered from the phone, moved on. Its subject is the
// agent, so the toast module keeps it off screen while the agent's pane is
// on screen anywhere (`store/toast-subjects.ts`).
//
// Raised only on a transition seen by `receiveAgentUpdate` in the focused
// window, never on a boot or resync read: an agent already waiting when this
// window loaded, or one that started waiting while it was unfocused (main's
// native banner covered that), gets no toast.

type Attention = "input" | "responded";

const ATTENTION_KINDS: readonly Attention[] = ["input", "responded"];

/** Agents this window raised a toast for, per kind, until main stops flagging them. */
const raised: Record<Attention, Set<string>> = { input: new Set(), responded: new Set() };

// Agents whose updates arrive without unseen flags (an older host bundle).
// They fall back to status alone, as before flags existed.
const unflagged = new Set<string>();

// Agents this window marked seen, with the status they had, until main's
// cleared flags come back. An update main sent before it processed the
// mark still carries the old flag, and must not raise the toast again.
const locallySeen = new Map<string, AgentInfo["lastAgentStatus"]>();

function attentionToastId(kind: Attention, agentId: string): string {
  return kind === "input" ? `agent-input-${agentId}` : `agent-responded-${agentId}`;
}

/**
 * Whether main has `agent` waiting on the user for `kind`. A responded that
 * main inferred from silence carries no flag, so never toasts.
 */
function wantsAttention(
  kind: Attention,
  agent: AgentInfo | undefined,
  state: Pick<AgentStoreState, "unseenInputAgentIds" | "unseenRespondedAgentIds">,
): boolean {
  if (!agent) return false;
  const flagged = unflagged.has(agent.id);
  return kind === "input"
    ? agent.lastAgentStatus === "requires_input" &&
        (flagged || state.unseenInputAgentIds.has(agent.id))
    : agent.lastAgentStatus === "responded" &&
        (flagged || state.unseenRespondedAgentIds.has(agent.id));
}

function raiseAttention(kind: Attention, agent: AgentInfo): void {
  raised[kind].add(agent.id);
  const id = attentionToastId(kind, agent.id);
  const opts = {
    id,
    detail: agent.name || "Agent",
    about: { agent: agent.id },
    action: {
      label: "Go to agent",
      onClick: () => {
        const latest = useAgentStore.getState().agents.find((a) => a.id === agent.id);
        navigateToAgent(latest ?? agent);
        toast.dismiss(id);
      },
    },
  };
  if (kind === "input") toast.attention("Agent needs input", opts);
  else toast.success("Agent responded", { ...opts, duration: 10_000 });
}

/** Take down each raised toast whose agent main no longer has waiting. */
function settleAttention(state: AgentStoreState): void {
  for (const kind of ATTENTION_KINDS) {
    for (const agentId of raised[kind]) {
      const agent = state.agents.find((a) => a.id === agentId);
      if (wantsAttention(kind, agent, state)) continue;
      raised[kind].delete(agentId);
      toast.dismiss(attentionToastId(kind, agentId));
    }
  }
}

export const useAgentStore = create<AgentStoreState>((set, get) => {
  // Subscribe to live agent updates on store creation. The second argument
  // carries main's unseen flags for the broadcast agent. Older preloads omit it; we pass through `undefined` and
  // let `receiveAgentUpdate` skip cache reconciliation in that case.
  window.electronAPI?.agents.onUpdate((agent, unseen) => {
    get().receiveAgentUpdate(agent, unseen);
  });

  // Agents a host's server adopted left the list under their old ids:
  // the host's own copies arrive as updates.
  window.electronAPI?.agents.onRemoved?.((agentIds) => {
    const gone = new Set(agentIds);
    set((state) => ({
      agents: state.agents.filter((a) => !gone.has(a.id)),
      unseenRespondedAgentIds: new Set([...state.unseenRespondedAgentIds].filter((id) => !gone.has(id))),
      unseenInputAgentIds: new Set([...state.unseenInputAgentIds].filter((id) => !gone.has(id))),
    }));
  });

  // Whatever is on screen has been read. Structure (`workspaceLayouts`) and
  // this window's viewport (`viewports`: selected tab, focused pane) are both immutable, so every split / tab-select / workspace-switch
  // lands here as a fresh identity — which is exactly the moment a pane the
  // user could not see becomes one they can.
  useAppStore.subscribe((state, prev) => {
    if (
      state.workspaceLayouts === prev.workspaceLayouts &&
      state.viewports === prev.viewports &&
      state.activeWorkspacePath === prev.activeWorkspacePath
    ) {
      return;
    }
    get().markVisibleAgentsSeen();
  });

  // Paginated initial load: active agents (full set, used by sidebar) +
  // the first page of all agents (used by the history modal) + main's
  // unseen-flag snapshot. The three are merged so
  // the store stays a single source of truth.
  const refetch = async (): Promise<void> => {
    if (!window.electronAPI?.agents) return;
    try {
      const [active, recentPage, unseen] = await Promise.all([
        window.electronAPI.agents.getActive(),
        window.electronAPI.agents.getAll({ limit: TASK_PAGE_SIZE, offset: 0 }),
        // Older preloads may not expose `getUnseen` — fall back to empty.
        window.electronAPI.agents.getUnseen
          ? window.electronAPI.agents
              .getUnseen()
              .catch(() => ({ responded: [] as string[], requires_input: [] as string[] }))
          : Promise.resolve({ responded: [] as string[], requires_input: [] as string[] }),
      ]);
      const dedupe = new Set<string>();
      const merged: AgentInfo[] = [];
      for (const t of [...active, ...recentPage]) {
        if (dedupe.has(t.id)) continue;
        dedupe.add(t.id);
        merged.push(t);
      }
      merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      set({
        agents: merged,
        loading: false,
        loaded: true,
        hasMore: recentPage.length === TASK_PAGE_SIZE,
        unseenRespondedAgentIds: new Set(unseen.responded),
        unseenInputAgentIds: new Set(unseen.requires_input),
      });

      // The layout may already be restored — anything on screen at boot is
      // read. If it isn't yet, the app-store subscription above catches it as
      // soon as it lands.
      get().markVisibleAgentsSeen();
    } catch {
      set({ loading: false });
    }
  };

  bootAndResync(refetch);

  // Boot only: a resync re-fetches state but must not repeat the prune notice.
  const consumePruneNotice = async (): Promise<void> => {
    if (!window.electronAPI?.agents) return;
    // One-time prune notice. Surfaces only when the most recent boot
    // actually deleted agents AND the user has not been notified yet.
    try {
      const prunedCount = await window.electronAPI.agents.consumePruneNotice();
      if (prunedCount > 0) {
        toast.success(`Pruned ${prunedCount} old agent${prunedCount === 1 ? "" : "s"}`, {
          id: "agent-prune-notice",
          detail: "Configure retention in Preferences",
          duration: 8_000,
        });
      }
    } catch {
      // Older preload — feature absent. Safe to ignore.
    }
  };
  void consumePruneNotice();

  return {
    agents: [],
    loading: true,
    loaded: false,
    hasMore: false,
    loadingMore: false,
    unseenRespondedAgentIds: new Set<string>(),
    unseenInputAgentIds: new Set<string>(),

    loadAgents: async (opts) => {
      set({ loading: true });
      try {
        const agents = await window.electronAPI.agents.getAll(opts);
        agents.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        set({
          agents,
          loading: false,
          loaded: true,
          // If the caller passed an explicit limit, treat a full result as
          // "may have more". For unbounded calls there is by definition no
          // next page.
          hasMore:
            opts?.limit !== undefined ? agents.length === opts.limit : false,
        });
      } catch {
        set({ loading: false });
      }
    },

    loadMoreAgents: async (offset: number) => {
      const s = get();
      // Coalesce repeated scroll events and short-circuit when we've
      // already exhausted the underlying store.
      if (s.loadingMore || !s.hasMore) return;
      set({ loadingMore: true });
      try {
        const newAgents = await window.electronAPI.agents.getAll({
          offset,
          limit: TASK_PAGE_SIZE,
        });
        set((state) => {
          const merged = [...state.agents, ...newAgents];
          // Deduplicate by id, keeping the first occurrence (existing agents take priority)
          const seen = new Set<string>();
          const deduped = merged.filter((t) => {
            if (seen.has(t.id)) return false;
            seen.add(t.id);
            return true;
          });
          deduped.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          return {
            agents: deduped,
            loadingMore: false,
            hasMore: newAgents.length === TASK_PAGE_SIZE,
          };
        });
      } catch {
        set({ loadingMore: false });
      }
    },

    searchAgents: (query) => window.electronAPI.agents.getAll({ query }),

    removeAgent: async (agentId: string) => {
      const success = await window.electronAPI.agents.delete(agentId);
      if (success) {
        set((s) => ({
          agents: s.agents.filter((t) => t.id !== agentId),
        }));
      }
    },

    renameAgent: async (agentId: string, name: string) => {
      const trimmed = name.trim();
      // Clearing hands naming back to the terminal. Main only re-syncs the
      // name on the next status change, so restore it from the live agent
      // title now rather than showing a generic label until then.
      const agent = get().agents.find((t) => t.id === agentId);
      const liveTitle = agent?.paneId
        ? useAppStore.getState().paneTitle[agent.paneId] ?? null
        : null;
      const updates = trimmed
        ? { name: trimmed, namePinned: true }
        : { name: cleanAgentTitle(liveTitle), namePinned: false };
      // Optimistic local update; main re-broadcasts the persisted record.
      set((s) => ({
        agents: s.agents.map((t) =>
          t.id === agentId ? { ...t, ...updates } : t,
        ),
      }));
      try {
        await window.electronAPI?.agents.update(agentId, updates);
      } catch {
        // Main rejected the write; the next broadcast will reconcile.
      }
    },

    markAgentSeen: (agentId: string) => {
      // Optimistically clear from the local cache. Main re-broadcasts on
      // `agents:markSeen`, which will reconcile this same state shortly —
      // but clearing optimistically keeps the pulse from lingering visibly
      // for the duration of the IPC round-trip.
      const s = get();
      const hadResponded = s.unseenRespondedAgentIds.has(agentId);
      const hadInput = s.unseenInputAgentIds.has(agentId);
      if (hadResponded || hadInput) {
        const seen = s.agents.find((a) => a.id === agentId);
        if (seen) locallySeen.set(agentId, seen.lastAgentStatus);
        const nextResponded = hadResponded
          ? new Set(s.unseenRespondedAgentIds)
          : s.unseenRespondedAgentIds;
        const nextInput = hadInput
          ? new Set(s.unseenInputAgentIds)
          : s.unseenInputAgentIds;
        if (hadResponded) nextResponded.delete(agentId);
        if (hadInput) nextInput.delete(agentId);
        set({
          unseenRespondedAgentIds: nextResponded,
          unseenInputAgentIds: nextInput,
        });
      }
      window.electronAPI?.agents.markSeen(agentId);
    },

    markVisibleAgentsSeen: () => {
      const s = get();
      if (
        s.unseenRespondedAgentIds.size === 0 &&
        s.unseenInputAgentIds.size === 0
      ) {
        return;
      }
      const visible = selectVisiblePaneIds(useAppStore.getState());
      if (visible.size === 0) return;
      for (const agent of s.agents) {
        if (agent.paneId == null || !visible.has(agent.paneId)) continue;
        if (
          s.unseenRespondedAgentIds.has(agent.id) ||
          s.unseenInputAgentIds.has(agent.id)
        ) {
          get().markAgentSeen(agent.id);
        }
      }
    },

    receiveAgentUpdate: (
      agent: AgentInfo,
      unseen?: { responded: boolean; requires_input: boolean },
    ) => {
      const s = get();
      const previous = s.agents.find((t) => t.id === agent.id);

      // Reconcile the unseen-flag cache to match main's snapshot for this
      // agent. Older preloads may not include the `unseen` argument; in that
      // case we leave the cache alone.
      if (unseen) {
        unflagged.delete(agent.id);
        if (!unseen.responded && !unseen.requires_input) locallySeen.delete(agent.id);
      } else {
        unflagged.add(agent.id);
      }
      if (unseen) {
        const hadResponded = s.unseenRespondedAgentIds.has(agent.id);
        const hadInput = s.unseenInputAgentIds.has(agent.id);
        const wantsResponded = unseen.responded;
        const wantsInput = unseen.requires_input;
        if (hadResponded !== wantsResponded || hadInput !== wantsInput) {
          const nextResponded = new Set(s.unseenRespondedAgentIds);
          const nextInput = new Set(s.unseenInputAgentIds);
          if (wantsResponded) nextResponded.add(agent.id);
          else nextResponded.delete(agent.id);
          if (wantsInput) nextInput.add(agent.id);
          else nextInput.delete(agent.id);
          set({
            unseenRespondedAgentIds: nextResponded,
            unseenInputAgentIds: nextInput,
          });
        }
      }

      set((s) => {
        const idx = s.agents.findIndex((t) => t.id === agent.id);
        let agents: AgentInfo[];
        if (idx >= 0) {
          // Replace existing agent
          agents = [...s.agents];
          agents[idx] = agent;
        } else {
          // Prepend new agent — clear stale pane title from the previous session
          if (agent.paneId) {
            useAppStore.getState().setPaneTitleFromStream(agent.paneId, null);
          }
          agents = [agent, ...s.agents];
        }
        // Re-sort by createdAt descending
        agents.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return { agents };
      });

      // An attention toast is raised on the transition into "waiting on the
      // user", and only in the focused window: unfocused, main shows the
      // native banner instead, and this window does not toast later either.
      // Taking it down again is `settleAttention`'s, on every store change.
      // An agent this window has never held (a host connecting, or a catch-up
      // after load) was already waiting before we saw it: no toast, as at boot.
      // One marked seen here at this status is a stale echo of that mark.
      const after = get();
      const current = after.agents.find((t) => t.id === agent.id);
      const stale =
        locallySeen.has(agent.id) && locallySeen.get(agent.id) === agent.lastAgentStatus;
      if (!previous || stale) {
        get().markVisibleAgentsSeen();
        return;
      }
      locallySeen.delete(agent.id);
      for (const kind of ATTENTION_KINDS) {
        if (wantsAttention(kind, previous, s) || !wantsAttention(kind, current, after)) continue;
        if (isWindowFocused()) raiseAttention(kind, agent);
      }

      // After the agent list holds this row, so the sweep can map it to a pane.
      // Covers a status flipping under a pane the user is already watching —
      // main will re-broadcast with cleared flags and the cache converges.
      get().markVisibleAgentsSeen();
    },
  };
});

useAgentStore.subscribe((state, prev) => {
  if (raised.input.size === 0 && raised.responded.size === 0) return;
  if (
    state.agents === prev.agents &&
    state.unseenInputAgentIds === prev.unseenInputAgentIds &&
    state.unseenRespondedAgentIds === prev.unseenRespondedAgentIds
  ) {
    return;
  }
  settleAttention(state);
});

// Which host's server holds an agent, for the bridge router.
provideHostLookups({
  agent: (agentId) => useAgentStore.getState().agents.find((a) => a.id === agentId)?.hostId,
});

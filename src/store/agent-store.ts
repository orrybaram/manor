import { create } from "zustand";
import { AgentInfo } from "../electron.d";
import { useToastStore } from "./toast-store";
import { useAppStore, selectVisiblePaneIds } from "./app-store";
import { navigateToAgent } from "../utils/agent-navigation";

/** Page size used for the initial agent load and for `loadMoreAgents`. */
const TASK_PAGE_SIZE = 100;

interface AgentStoreState {
  agents: AgentInfo[];
  loading: boolean;
  loaded: boolean;
  /** True when `agents:getAll` last returned a full page — more may exist on disk. */
  hasMore: boolean;
  /** True while `loadMoreAgents` is in flight, to coalesce repeated scroll events. */
  loadingMore: boolean;
  /**
   * Cache of main's unseen-responded Set (ADR-136 §"Change 3"). Populated by
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
  removeAgent: (agentId: string) => Promise<void>;
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

export const useAgentStore = create<AgentStoreState>((set, get) => {
  // Subscribe to live agent updates on store creation. The second argument
  // carries main's unseen flags for the broadcast agent — see ADR-136
  // §"Change 3". Older preloads omit it; we pass through `undefined` and
  // let `receiveAgentUpdate` skip cache reconciliation in that case.
  window.electronAPI?.agents.onUpdate((agent, unseen) => {
    get().receiveAgentUpdate(agent, unseen);
  });

  // Whatever is on screen has been read. Layout mutations are immutable, so
  // every focus / tab-select / workspace-switch lands here as a fresh
  // `workspaceLayouts` identity — which is exactly the moment a pane the user
  // could not see becomes one they can.
  useAppStore.subscribe((state, prev) => {
    if (
      state.workspaceLayouts === prev.workspaceLayouts &&
      state.activeWorkspacePath === prev.activeWorkspacePath
    ) {
      return;
    }
    get().markVisibleAgentsSeen();
  });

  // Paginated initial load: active agents (full set, used by sidebar) +
  // the first page of all agents (used by the history modal) + main's
  // unseen-flag snapshot (ADR-136 §"Change 3"). The three are merged so
  // the store stays a single source of truth.
  const init = async (): Promise<void> => {
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

      // One-time prune notice. Surfaces only when the most recent boot
      // actually deleted agents AND the user has not been notified yet.
      try {
        const prunedCount = await window.electronAPI.agents.consumePruneNotice();
        if (prunedCount > 0) {
          useToastStore.getState().addToast({
            id: "agent-prune-notice",
            message: `Pruned ${prunedCount} old agent${prunedCount === 1 ? "" : "s"}`,
            detail: "Configure retention in Preferences",
            status: "success",
            duration: 8_000,
          });
        }
      } catch {
        // Older preload — feature absent. Safe to ignore.
      }
    } catch {
      set({ loading: false });
    }
  };
  init();

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

    removeAgent: async (agentId: string) => {
      const success = await window.electronAPI.agents.delete(agentId);
      if (success) {
        set((s) => ({
          agents: s.agents.filter((t) => t.id !== agentId),
        }));
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
      const idx = s.agents.findIndex((t) => t.id === agent.id);
      const prevStatus = idx >= 0 ? s.agents[idx].lastAgentStatus : null;
      const nextStatus = agent.lastAgentStatus;

      // Reconcile the unseen-flag cache to match main's snapshot for this
      // agent. Older preloads may not include the `unseen` argument; in that
      // case we leave the cache alone.
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

      if (prevStatus !== nextStatus) {
        // Don't show toasts if the agent's pane is already on screen.
        const isAlreadyVisible =
          agent.paneId != null &&
          selectVisiblePaneIds(useAppStore.getState()).has(agent.paneId);

        if (nextStatus === "requires_input") {
          if (!isAlreadyVisible) {
            const toastId = `agent-input-${agent.id}`;
            useToastStore.getState().addToast({
              id: toastId,
              message: "Agent needs input",
              detail: agent.name || "Agent",
              status: "loading",
              persistent: true,
              action: {
                label: "Go to agent",
                onClick: () => {
                  navigateToAgent(agent);
                  useToastStore.getState().removeToast(toastId);
                },
              },
            });
          }
        }

        if (nextStatus === "responded") {
          if (!isAlreadyVisible) {
            const toastId = `agent-responded-${agent.id}`;
            useToastStore.getState().addToast({
              id: toastId,
              message: "Agent responded",
              detail: agent.name || "Agent",
              status: "success",
              duration: 10_000,
              action: {
                label: "Go to agent",
                onClick: () => {
                  navigateToAgent(agent);
                  useToastStore.getState().removeToast(toastId);
                },
              },
            });
          }
        }

        if (nextStatus === "complete") {
          if (!isAlreadyVisible) {
            const toastId = `agent-complete-${agent.id}`;
            useToastStore.getState().addToast({
              id: toastId,
              message: "Agent completed",
              detail: agent.name || "Agent",
              status: "success",
            });
          }
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
            useAppStore.getState().clearPaneTitle(agent.paneId);
          }
          agents = [agent, ...s.agents];
        }
        // Re-sort by createdAt descending
        agents.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return { agents };
      });

      // After the agent list holds this row, so the sweep can map it to a pane.
      // Covers a status flipping under a pane the user is already watching —
      // main will re-broadcast with cleared flags and the cache converges.
      get().markVisibleAgentsSeen();
    },
  };
});

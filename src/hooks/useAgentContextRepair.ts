/**
 * Sends main the pane context of Agents recorded without a project, derived
 * from the persisted layouts. See `lib/agent-context-repair.ts`.
 */

import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { useAgentStore } from "../store/agent-store";
import { orphanedAgentContexts } from "../lib/agent-context-repair";
import { useMountEffect } from "./useMountEffect";

type Subscribable<S> = {
  subscribe: (listener: (state: S, prev: S) => void) => () => void;
};

/** Subscribes `run` to changes of one slice of `store`, by identity. */
function onSliceChange<S>(
  store: Subscribable<S>,
  slice: (state: S) => unknown,
  run: () => void,
): () => void {
  return store.subscribe((state, prev) => {
    if (slice(state) !== slice(prev)) run();
  });
}

export function useAgentContextRepair(): void {
  useMountEffect(() => {
    // Panes already sent a context. Main broadcasts the repaired Agent, which
    // removes it from the next derivation; this only stops a repeat while
    // that round trip is in flight.
    const sent = new Set<string>();

    const repair = () => {
      const contexts = orphanedAgentContexts(
        useAgentStore.getState().agents,
        useAppStore.getState().workspaceLayouts,
        useProjectStore.getState().projects,
      );
      for (const [paneId, context] of contexts) {
        if (sent.has(paneId)) continue;
        sent.add(paneId);
        void window.electronAPI.agents.setPaneContext(paneId, context);
      }
    };

    // Only the slices the derivation reads: the app store changes on every
    // pane title frame, which must not re-walk every layout.
    const unsubscribes = [
      onSliceChange(useAgentStore, (s) => s.agents, repair),
      onSliceChange(useProjectStore, (s) => s.projects, repair),
      onSliceChange(useAppStore, (s) => s.workspaceLayouts, repair),
    ];
    repair();
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  });
}

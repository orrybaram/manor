import { useMemo, useSyncExternalStore } from "react";
import { useAppStore } from "../store/app-store";
import { useAgentStore } from "../store/agent-store";
import {
  rollupInputs,
  selectAgentRollup,
  type AgentRollup,
  type AgentRollupSources,
} from "../store/agent-rollup";

/** Picks the panes a dot speaks for out of the rollup's store fields. */
export type PaneSetSelector = (sources: AgentRollupSources) => Iterable<string>;

function subscribeBoth(onChange: () => void): () => void {
  const unsubApp = useAppStore.subscribe(onChange);
  const unsubAgents = useAgentStore.subscribe(onChange);
  return () => {
    unsubApp();
    unsubAgents();
  };
}

/**
 * A `getSnapshot` for `useSyncExternalStore`: the rollup of the panes
 * `selectPanes` picks, recomputed only when an input it can depend on changes,
 * and the same object back while status and pulse stay the same.
 */
function rollupSnapshot(selectPanes: PaneSetSelector): () => AgentRollup {
  let inputs: readonly unknown[] = [];
  let result: AgentRollup | null = null;
  return () => {
    const sources = { app: useAppStore.getState(), agents: useAgentStore.getState() };
    const next = rollupInputs(sources);
    if (result && next.every((v, i) => v === inputs[i])) return result;
    inputs = next;
    const rollup = selectAgentRollup(sources, selectPanes(sources));
    if (!result || result.status !== rollup.status || result.pulse !== rollup.pulse) {
      result = rollup;
    }
    return result;
  };
}

/**
 * The rollup (`selectAgentRollup`) for the panes `selectPanes` picks, kept
 * current with the app and agent stores. The caller re-renders only when its
 * own status or pulse changes; store changes the rollup cannot depend on
 * (titles, focus elsewhere…) skip the recompute entirely.
 * Memoize `selectPanes`: a new function each render recomputes.
 */
export function useAgentRollup(selectPanes: PaneSetSelector): AgentRollup {
  const getSnapshot = useMemo(() => rollupSnapshot(selectPanes), [selectPanes]);
  return useSyncExternalStore(subscribeBoth, getSnapshot);
}

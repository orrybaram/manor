import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentInfo } from "../../../electron.d";
import { useAgentStore } from "../../../store/agent-store";

/** How long typing must pause before main is asked. */
const SEARCH_DEBOUNCE_MS = 150;

/**
 * Debounces searches and hands on only the newest one's answer: a reply that
 * lands after a newer query was typed is dropped, so fast typing never shows
 * an older search's results.
 */
export function createLatestSearch(
  run: (query: string) => Promise<AgentInfo[]>,
  onResult: (agents: AgentInfo[]) => void,
  debounceMs = SEARCH_DEBOUNCE_MS,
): { search: (query: string) => void; dispose: () => void } {
  let latest = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    search(query) {
      const id = ++latest;
      cancel();
      if (!query) {
        onResult([]);
        return;
      }
      timer = setTimeout(() => {
        run(query)
          .then((agents) => {
            if (id === latest) onResult(agents);
          })
          .catch(() => {});
      }, debounceMs);
    },
    dispose() {
      latest++;
      cancel();
    },
  };
}

/**
 * Main's matches for `query` across every agent ever recorded. Not paged:
 * `agents.getAll` joins one page per server, so offsets don't line up across
 * servers, and a server too old to know `query` answers unfiltered. Asking
 * for every match sidesteps both; the caller filters again and caps the rows
 * it draws. Until the first reply for a new query arrives, the previous one
 * stays: the caller's filter hides what no longer matches.
 */
export function useAgentSearch(query: string): {
  agents: AgentInfo[];
  /** Drop an agent from the results, as removing it from the store does. */
  forget: (agentId: string) => void;
} {
  const searchAgents = useAgentStore((s) => s.searchAgents);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const searchRef = useRef<ReturnType<typeof createLatestSearch> | null>(null);

  useEffect(() => {
    const latest = createLatestSearch(searchAgents, setAgents);
    searchRef.current = latest;
    return () => latest.dispose();
  }, [searchAgents]);

  const trimmed = query.trim();
  useEffect(() => {
    searchRef.current?.search(trimmed);
  }, [trimmed, searchAgents]);

  const forget = useCallback((agentId: string) => {
    setAgents((list) => list.filter((a) => a.id !== agentId));
  }, []);

  return { agents, forget };
}

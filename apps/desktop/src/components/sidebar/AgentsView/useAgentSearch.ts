import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentInfo } from "../../../electron.d";
import { useAgentStore } from "../../../store/agent-store";

/** How long typing must pause before main is asked. */
const SEARCH_DEBOUNCE_MS = 150;

interface SearchPage {
  query: string;
  agents: AgentInfo[];
  hasMore: boolean;
}

const NO_RESULTS: SearchPage = { query: "", agents: [], hasMore: false };

/**
 * Main's matches for `query` across every agent ever recorded, paged like the
 * store's own list. A reply that lands after a newer query was sent is
 * dropped, so fast typing never shows an older search's page. Until the first
 * reply for a new query arrives, the previous page stays: the caller filters
 * it again, so nothing that no longer matches shows.
 */
export function useAgentSearch(query: string): {
  agents: AgentInfo[];
  hasMore: boolean;
  loadMore: () => void;
} {
  const searchAgents = useAgentStore((s) => s.searchAgents);
  const [page, setPage] = useState<SearchPage>(NO_RESULTS);
  const requestId = useRef(0);
  const loadingMore = useRef(false);
  const trimmed = query.trim();

  useEffect(() => {
    const id = ++requestId.current;
    loadingMore.current = false;
    if (!trimmed) {
      setPage(NO_RESULTS);
      return;
    }
    const timer = setTimeout(() => {
      searchAgents(trimmed, 0)
        .then((result) => {
          if (id === requestId.current) setPage({ query: trimmed, ...result });
        })
        .catch(() => {});
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed, searchAgents]);

  const loadMore = useCallback(() => {
    if (!page.hasMore || loadingMore.current || page.query !== trimmed) return;
    const id = requestId.current;
    loadingMore.current = true;
    searchAgents(page.query, page.agents.length)
      .then((result) => {
        if (id !== requestId.current) return;
        setPage((p) => ({
          ...p,
          agents: [...p.agents, ...result.agents],
          hasMore: result.hasMore,
        }));
      })
      .catch(() => {})
      .finally(() => {
        if (id === requestId.current) loadingMore.current = false;
      });
  }, [page, trimmed, searchAgents]);

  return { agents: page.agents, hasMore: page.hasMore, loadMore };
}

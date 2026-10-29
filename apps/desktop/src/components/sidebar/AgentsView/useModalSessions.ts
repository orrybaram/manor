import { useCallback, useEffect, useState } from "react";
import type { AgentInfo, SessionSummary } from "../../../electron.d";

type Loaded = { sessions: SessionSummary[]; knownAgents: AgentInfo[] };

const EMPTY: Loaded = { sessions: [], knownAgents: [] };

/**
 * The Sessions on every host, and every Agent main knows (to tell Manor's
 * Sessions from outside ones; see `mergeModalRows`), asked for each time the
 * modal opens and kept while it stays open. Both answers are published
 * together, so a Manor Session never shows as outside Manor for a moment.
 * Never blocks the modal: until they arrive the list has only the store's
 * Agents. A failed call shows nothing about it: no Sessions if the Sessions
 * failed, no extra Agents if the Agents did. `refresh` asks again, keeping
 * what is shown until the answers arrive.
 */
export function useModalSessions(open: boolean): Loaded & {
  /** Drop a removed Agent, so its Session shows as outside Manor again. */
  forget: (agentId: string) => void;
  /** Mirror a rename onto the copy kept here; an empty name unpins it. */
  rename: (agentId: string, name: string) => void;
  /** Ask every host again. */
  refresh: () => void;
  /** An ask is in flight. */
  loading: boolean;
} {
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [asks, setAsks] = useState(0);

  // What an earlier opening loaded may be stale (removed Agents, gone Sessions).
  useEffect(() => {
    if (open) setLoaded(EMPTY);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    let current = true;
    const api = window.electronAPI;
    void Promise.allSettled([api.sessions.list(), api.agents.getAll({})]).then(
      ([sessions, agents]) => {
        if (!current) return;
        setLoading(false);
        setLoaded({
          sessions: sessions.status === "fulfilled" ? sessions.value : [],
          knownAgents: agents.status === "fulfilled" ? agents.value : [],
        });
      },
    );
    return () => {
      current = false;
      setLoading(false);
    };
  }, [open, asks]);

  const refresh = useCallback(() => setAsks((n) => n + 1), []);

  const forget = useCallback((agentId: string) => {
    setLoaded((l) => ({ ...l, knownAgents: l.knownAgents.filter((a) => a.id !== agentId) }));
  }, []);

  const rename = useCallback((agentId: string, name: string) => {
    const trimmed = name.trim();
    setLoaded((l) => ({
      ...l,
      knownAgents: l.knownAgents.map((a) =>
        a.id !== agentId
          ? a
          : trimmed
            ? { ...a, name: trimmed, namePinned: true }
            : { ...a, namePinned: false },
      ),
    }));
  }, []);

  return { ...loaded, forget, rename, refresh, loading };
}

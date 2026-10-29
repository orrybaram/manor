import { useCallback, useEffect, useState } from "react";
import type { AgentInfo, SessionSummary } from "../../../electron.d";

/**
 * The Sessions on every host, and every Agent main knows (to tell Manor's
 * Sessions from outside ones; see `mergeModalRows`), asked for each time the
 * modal opens and kept while it stays open. Never blocks the modal: both
 * start empty and fill when they arrive; a failed call leaves them as they
 * were, with nothing shown about it.
 */
export function useModalSessions(open: boolean): {
  sessions: SessionSummary[];
  knownAgents: AgentInfo[];
  /** Drop a removed Agent, so its Session shows as outside Manor again. */
  forget: (agentId: string) => void;
  /** Mirror a rename onto the copy kept here. */
  rename: (agentId: string, name: string) => void;
} {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [knownAgents, setKnownAgents] = useState<AgentInfo[]>([]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    const api = window.electronAPI;
    api.sessions
      .list()
      .then((list) => {
        if (current) setSessions(list);
      })
      .catch(() => {});
    api.agents
      .getAll({})
      .then((list) => {
        if (current) setKnownAgents(list);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [open]);

  const forget = useCallback((agentId: string) => {
    setKnownAgents((list) => list.filter((a) => a.id !== agentId));
  }, []);

  const rename = useCallback((agentId: string, name: string) => {
    const trimmed = name.trim();
    setKnownAgents((list) =>
      list.map((a) =>
        a.id === agentId && trimmed ? { ...a, name: trimmed, namePinned: true } : a,
      ),
    );
  }, []);

  return { sessions, knownAgents, forget, rename };
}

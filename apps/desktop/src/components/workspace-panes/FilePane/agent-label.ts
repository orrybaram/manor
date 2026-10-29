import type { FileAuthor } from "../../../electron.d";
import { useAgentStore, selectPaneAgentIndex } from "../../../store/agent-store";
import { useAppStore } from "../../../store/app-store";
import { cleanLiveTitle, resolveAgentTitle } from "../../../hooks/useAgentDisplay";

/**
 * What the sidebar calls the agent that wrote a file: its Agent's title
 * (`resolveAgentTitle`), else the pane's live title, else its Agent kind.
 * Null with no author.
 */
export function useAgentLabel(author: FileAuthor | null): string | null {
  const paneId = author?.paneId ?? null;
  const agent = useAgentStore((s) => {
    if (!paneId) return null;
    const id = selectPaneAgentIndex(s).get(paneId);
    return id ? (s.agents.find((a) => a.id === id) ?? null) : null;
  });
  const liveTitle = useAppStore((s) =>
    paneId ? cleanLiveTitle(s.paneTitle[paneId] ?? null) : null,
  );
  if (!author) return null;
  if (agent) return resolveAgentTitle(agent, liveTitle);
  return liveTitle ?? author.agentKind;
}

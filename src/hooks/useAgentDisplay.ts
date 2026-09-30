import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../store/app-store";
import { cleanAgentTitle } from "../utils/agent-title";
import type { AgentInfo, AgentStatus } from "../electron.d";

/**
 * Strip SSH-style CWD titles (e.g. "user@host:/path") and clean agent
 * spinner/marker characters. Returns null when the raw title is empty
 * or represents a CWD rather than an agent description.
 */
export function cleanLiveTitle(raw: string | null): string | null {
  if (!raw) return null;
  // SSH-style CWD titles like "user@host:/some/path" are not agent descriptions
  if (/.+@.+:.+/.test(raw)) return null;
  return cleanAgentTitle(raw);
}

const NO_TITLES: Readonly<Record<string, string>> = {};

/**
 * Every pane's cleaned live title (`cleanLiveTitle`), keyed by pane id; panes
 * whose title cleans to nothing are left out.
 */
function cleanPaneTitles(
  paneTitle: Readonly<Record<string, string>>,
): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [paneId, raw] of Object.entries(paneTitle)) {
    const title = cleanLiveTitle(raw);
    if (title) cleaned[paneId] = title;
  }
  return cleaned;
}

/**
 * `cleanPaneTitles` of the store, compared shallowly: a new spinner frame
 * that cleans to the same title does not re-render the caller. While
 * `enabled` is false it returns a constant and never re-renders.
 */
export function useCleanPaneTitles(
  enabled = true,
): Readonly<Record<string, string>> {
  return useAppStore(
    useShallow((s) => (enabled ? cleanPaneTitles(s.paneTitle) : NO_TITLES)),
  );
}

/**
 * Resolve the title shown for an agent. A user-pinned name always wins;
 * otherwise the live terminal title, then the auto-synced persisted name.
 */
export function resolveAgentTitle(
  agent: AgentInfo,
  liveTitle: string | null,
): string {
  if (agent.namePinned && agent.name) return agent.name;
  return cleanLiveTitle(liveTitle) ?? agent.name ?? "Agent";
}

/**
 * Unified hook that derives display title and Agent status for an agent.
 *
 * The status is exactly what main's Status reconciler published for the
 * agent's pane (ADR-184 §4) — this hook does not re-derive it. It is
 * `undefined` when the agent has no pane, or the reconciler has not
 * published a status for it yet (e.g. a `completed` agent whose pane closed);
 * the agents list shows the lifecycle as a badge instead of a dot then.
 */
export function useAgentDisplay(
  agent: AgentInfo,
): { title: string; status: AgentStatus | undefined; reason: string | undefined } {
  const status = useAppStore((s) =>
    agent.paneId ? s.paneAgentStatus[agent.paneId]?.status : undefined,
  );
  const reason = useAppStore((s) =>
    agent.paneId ? s.paneAgentStatus[agent.paneId]?.reason : undefined,
  );
  // Cleaned in the selector, so spinner frames don't re-render the row.
  const liveTitle = useAppStore((s) =>
    agent.paneId ? cleanLiveTitle(s.paneTitle[agent.paneId] ?? null) : null,
  );

  const title = resolveAgentTitle(agent, liveTitle);

  return { title, status, reason };
}

import { useMemo } from "react";
import Bot from "lucide-react/dist/esm/icons/bot";
import Plus from "lucide-react/dist/esm/icons/plus";
import { useAgentStore } from "../../store/agent-store";
import { useKeybindingsStore } from "../../store/keybindings-store";
import { useAppStore } from "../../store/app-store";
import { isHomePath } from "../../lib/home-path";
import { formatCombo } from "../../lib/keybindings";
import {
  resolveAgentTitle,
  useCleanPaneTitles,
} from "../../hooks/useAgentDisplay";
import { AgentDot } from "../ui/AgentDot/AgentDot";
import type { AgentInfo, PaneAgentStatus } from "../../electron.d";
import type { CommandItem } from "./types";
import styles from "./CommandPalette.module.css";

/** How many running agents the palette lists. */
const AGENT_LIMIT = 5;

const NO_AGENTS: AgentInfo[] = [];
const NO_STATUSES: Readonly<Record<string, PaneAgentStatus>> = {};

interface UseAgentCommandsParams {
  onResumeAgent: (agent: AgentInfo) => void;
  onViewAllAgents: () => void;
  onClose: () => void;
  onNewAgent: () => void;
  /**
   * Only list agents of these projects (a project, or a group's linked
   * checkouts); `null` lists all, each with a project tag.
   */
  scopeProjectIds: ReadonlySet<string> | null;
  /**
   * Whether the palette is open. While closed the hook reads no agent,
   * status or title state, so agent activity does no work in the palette.
   */
  enabled: boolean;
}

interface AgentCommands {
  /** The Agents group's rows under the current scope. */
  items: CommandItem[];
  /** Agent rows outside the scope, for the widening hint. Empty when global. */
  outOfScope: CommandItem[];
}

export function useAgentCommands({
  onResumeAgent,
  onViewAllAgents,
  onClose,
  onNewAgent,
  scopeProjectIds,
  enabled,
}: UseAgentCommandsParams): AgentCommands {
  const agents = useAgentStore((s) => (enabled ? s.agents : NO_AGENTS));
  const bindings = useKeybindingsStore((s) => s.bindings);
  const paneAgentStatus = useAppStore((s) =>
    enabled ? s.paneAgentStatus : NO_STATUSES,
  );
  const paneTitle = useCleanPaneTitles(enabled);
  const onHome = useAppStore((s) => isHomePath(s.activeWorkspacePath));

  return useMemo(() => {
    const platform = navigator.platform.toLowerCase().includes("mac")
      ? ("mac" as const)
      : ("other" as const);
    const fmt = (id: string) =>
      bindings[id] ? formatCombo(bindings[id], platform) : undefined;

    // The Dashboard has no tabs to host a new agent (ADR-197).
    const items: CommandItem[] = onHome ? [] : [
      {
        id: "new-agent",
        label: "New Agent",
        icon: <Plus size={14} />,
        shortcut: fmt("new-agent"),
        action: () => {
          onClose();
          onNewAgent();
        },
      },
    ];

    const toItem = (agent: AgentInfo): CommandItem => {
      const live = agent.paneId ? paneAgentStatus[agent.paneId] : undefined;
      const liveTitle = agent.paneId ? paneTitle[agent.paneId] ?? null : null;
      const label = resolveAgentTitle(agent, liveTitle);
      return {
        id: `agent-${agent.id}`,
        label,
        icon: (
          <AgentDot status={live?.status} size="sidebar" reason={live?.reason} />
        ),
        keywords: agent.projectName ? [agent.projectName] : undefined,
        // Scoped, every agent shares the project; global, tag each one.
        suffix:
          scopeProjectIds === null && agent.projectName ? (
            <span className={styles.projectTag}>{agent.projectName}</span>
          ) : undefined,
        action: () => {
          onClose();
          onResumeAgent(agent);
        },
      };
    };

    const active = agents.filter((t) => t.status === "active");
    const inScope =
      scopeProjectIds === null
        ? active
        : active.filter(
            (a) => a.projectId !== null && scopeProjectIds.has(a.projectId),
          );
    const outOfScope =
      scopeProjectIds === null
        ? []
        : active.filter(
            (a) => a.projectId === null || !scopeProjectIds.has(a.projectId),
          );

    items.push(...inScope.slice(0, AGENT_LIMIT).map(toItem));

    items.push({
      id: "view-all-agents",
      label: "View All Agents...",
      icon: <Bot size={14} />,
      action: () => {
        onClose();
        onViewAllAgents();
      },
    });

    return { items, outOfScope: outOfScope.map(toItem) };
  }, [agents, onResumeAgent, onViewAllAgents, onClose, onNewAgent, bindings, paneAgentStatus, paneTitle, onHome, scopeProjectIds]);
}

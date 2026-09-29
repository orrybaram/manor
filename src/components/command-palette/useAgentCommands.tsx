import { useMemo } from "react";
import Bot from "lucide-react/dist/esm/icons/bot";
import Plus from "lucide-react/dist/esm/icons/plus";
import { useAgentStore } from "../../store/agent-store";
import { useKeybindingsStore } from "../../store/keybindings-store";
import { useAppStore } from "../../store/app-store";
import { isHomePath } from "../../lib/home-path";
import { formatCombo } from "../../lib/keybindings";
import { resolveAgentTitle } from "../../hooks/useAgentDisplay";
import { AgentDot } from "../ui/AgentDot/AgentDot";
import type { AgentInfo } from "../../electron.d";
import type { CommandItem } from "./types";

interface UseAgentCommandsParams {
  onResumeAgent: (agent: AgentInfo) => void;
  onViewAllAgents: () => void;
  onClose: () => void;
  onNewAgent: () => void;
}

export function useAgentCommands({
  onResumeAgent,
  onViewAllAgents,
  onClose,
  onNewAgent,
}: UseAgentCommandsParams): CommandItem[] {
  const agents = useAgentStore((s) => s.agents);
  const bindings = useKeybindingsStore((s) => s.bindings);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
  const paneTitle = useAppStore((s) => s.paneTitle);
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

    items.push(
      ...agents.filter((t) => t.status === "active").slice(0, 5).map((agent) => {
        const live = agent.paneId ? paneAgentStatus[agent.paneId] : undefined;
        const liveTitle = agent.paneId ? paneTitle[agent.paneId] ?? null : null;
        const label = resolveAgentTitle(agent, liveTitle);
        return {
          id: `agent-${agent.id}`,
          label,
          icon: (
            <AgentDot status={live?.status} size="sidebar" reason={live?.reason} />
          ),
          action: () => {
            onClose();
            onResumeAgent(agent);
          },
        };
      }),
    );

    items.push({
      id: "view-all-agents",
      label: "View All Agents...",
      icon: <Bot size={14} />,
      action: () => {
        onClose();
        onViewAllAgents();
      },
    });

    return items;
  }, [agents, onResumeAgent, onViewAllAgents, onClose, onNewAgent, bindings, paneAgentStatus, paneTitle, onHome]);
}

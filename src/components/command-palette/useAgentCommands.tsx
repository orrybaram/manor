import { useMemo } from "react";
import ListTodo from "lucide-react/dist/esm/icons/list-todo";
import Plus from "lucide-react/dist/esm/icons/plus";
import { useAgentStore } from "../../store/agent-store";
import { useKeybindingsStore } from "../../store/keybindings-store";
import { useAppStore } from "../../store/app-store";
import { formatCombo } from "../../lib/keybindings";
import { deriveStatus, cleanLiveTitle } from "../../hooks/useAgentDisplay";
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

  return useMemo(() => {
    const platform = navigator.platform.toLowerCase().includes("mac")
      ? ("mac" as const)
      : ("other" as const);
    const fmt = (id: string) =>
      bindings[id] ? formatCombo(bindings[id], platform) : undefined;

    const items: CommandItem[] = [
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
        const liveAgent = agent.paneId ? paneAgentStatus[agent.paneId] ?? null : null;
        const agentStatus = deriveStatus(agent, liveAgent);
        const liveTitle = agent.paneId ? paneTitle[agent.paneId] ?? null : null;
        const label = cleanLiveTitle(liveTitle) ?? agent.name ?? "Agent";
        return {
          id: `agent-${agent.id}`,
          label,
          icon: (
            <AgentDot status={agentStatus} size="sidebar" />
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
      icon: <ListTodo size={14} />,
      action: () => {
        onClose();
        onViewAllAgents();
      },
    });

    return items;
  }, [agents, onResumeAgent, onViewAllAgents, onClose, onNewAgent, bindings, paneAgentStatus, paneTitle]);
}

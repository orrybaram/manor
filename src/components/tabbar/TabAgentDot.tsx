import { AgentDot } from "../ui/AgentDot/AgentDot";
import { useTabAgentStatus } from "../../hooks/useTabAgentStatus";

type TabAgentDotProps = {
  tabId: string;
};

export function TabAgentDot(props: TabAgentDotProps) {
  const { tabId } = props;

  const { status, pulse } = useTabAgentStatus(tabId);
  return <AgentDot status={status ?? undefined} size="tab" pulse={pulse} />;
}

import { AgentDot } from "../ui/AgentDot/AgentDot";
import { useSessionAgentStatus } from "../../hooks/useSessionAgentStatus";

type TabAgentDotProps = {
  sessionId: string;
};

export function TabAgentDot(props: TabAgentDotProps) {
  const { sessionId } = props;

  const status = useSessionAgentStatus(sessionId);
  return <AgentDot status={status ?? undefined} size="tab" />;
}

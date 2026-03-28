import { AgentDot } from "./AgentDot";
import { useSessionAgentStatus } from "./useSessionAgentStatus";

type TabAgentDotProps = {
  sessionId: string;
};

export function TabAgentDot(props: TabAgentDotProps) {
  const { sessionId } = props;

  const status = useSessionAgentStatus(sessionId);
  return <AgentDot status={status ?? undefined} size="tab" />;
}

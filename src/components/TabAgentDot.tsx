import { AgentDot } from "./AgentDot";
import { useSessionAgentStatus } from "./useSessionAgentStatus";

export function TabAgentDot({ sessionId }: { sessionId: string }) {
  const status = useSessionAgentStatus(sessionId);
  return <AgentDot status={status ?? undefined} size="tab" />;
}

import { selectActiveWorkspaceKey, useAppStore } from "../../store/app-store";
import { PhoneNewAgentComposer } from "./NewAgent/PhoneNewAgentComposer";

/**
 * A workspace with no tabs, on a phone: a chat that hasn't started yet.
 *
 * The desk's empty state is a list of keyboard shortcuts, which a phone has
 * no use for. Here the first message is the new agent's prompt: nothing is
 * launched until it is sent, so closing the last agent lands back on this
 * screen rather than spawning another one. It is the new-agent composer
 * (ADR-222) with nothing to close back to, keyed by workspace so each
 * workspace's screen starts on that workspace.
 */
export function PhoneEmptyWorkspace() {
  const key = useAppStore(selectActiveWorkspaceKey);

  return <PhoneNewAgentComposer key={key ?? ""} closable={false} />;
}

import type { FileAuthor } from "../../../electron.d";
import { useAgentLabel } from "./agent-label";
import styles from "./AgentChip.module.css";

/** The small label naming the agent that wrote a file. */
export function AgentChip({ author }: { author: FileAuthor }) {
  const label = useAgentLabel(author);
  return (
    <span className={styles.chip} data-testid="file-pane-agent-chip" title={label ?? undefined}>
      {label}
    </span>
  );
}

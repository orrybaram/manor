import type { AgentStatus } from "../electron.d";
import { SpinnerLoader } from "./SpinnerLoader";
import { useDebouncedAgentStatus } from "./useDebouncedAgentStatus";
import styles from "./AgentDot.module.css";

interface AgentDotProps {
  status?: AgentStatus;
  size: "pane" | "tab" | "sidebar" | "debug";
}

export function AgentDot({ status: rawStatus, size }: AgentDotProps) {
  const status = useDebouncedAgentStatus(rawStatus);
  if (!status || status === "idle") return null;

  if (status === "working" || status === "thinking") {
    return <SpinnerLoader size={size} variant={status} />;
  }

  if (status === "complete") {
    return (
      <span
        className={`${styles.dot} ${styles[size]} ${styles.dotComplete}`}
        title="Agent complete"
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
          <path
            d="M3 8l3.5 3.5L13 5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  if (status === "requires_input") {
    return (
      <span
        className={`${styles.dot} ${styles[size]} ${styles.dotRequiresInput}`}
        title="Waiting for input"
      >
        <span className={styles.handEmoji}>👋</span>
      </span>
    );
  }

  return (
    <span
      className={`${styles.dot} ${styles[size]} ${status === "error" ? styles.dotError : ""}`}
      title={status === "error" ? "Agent error" : ""}
    />
  );
}

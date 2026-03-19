import type { AgentStatus } from "../electron.d";
import styles from "./AgentDot.module.css";

interface AgentDotProps {
  status?: AgentStatus;
  size: "pane" | "tab";
}

export function AgentDot({ status, size }: AgentDotProps) {
  if (!status || status === "idle") return null;

  if (status === "complete" && size === "pane") {
    return (
      <span className={`${styles.dot} ${styles[size]} ${styles.dotComplete}`} title="Agent complete">
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
          <path d="M3 8l3.5 3.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }

  const dotClass =
    status === "running" ? styles.dotRunning
    : status === "waiting" ? styles.dotWaiting
    : status === "error" ? styles.dotError
    : status === "complete" ? styles.dotComplete
    : "";

  const label =
    status === "running" ? "Agent running"
    : status === "waiting" ? "Waiting for input"
    : status === "error" ? "Agent error"
    : status === "complete" ? "Agent complete"
    : "";

  return <span className={`${styles.dot} ${styles[size]} ${dotClass}`} title={label} />;
}

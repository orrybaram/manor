import type { AgentStatus } from "../../../electron.d";
import { SpinnerLoader } from "../SpinnerLoader/SpinnerLoader";
import { useDebouncedAgentStatus } from "../../../hooks/useDebouncedAgentStatus";
import styles from "./AgentDot.module.css";

type AgentDotProps = {
  status?: AgentStatus;
  size: "pane" | "tab" | "sidebar" | "debug";
  pulse?: boolean;
};

export function AgentDot(props: AgentDotProps) {
  const { status: rawStatus, size, pulse = true } = props;

  const status = useDebouncedAgentStatus(rawStatus);
  if (!status || status === "idle") return null;

  if (status === "working" || status === "thinking") {
    return <SpinnerLoader size={size} variant={status} />;
  }

  if (status === "responded") {
    const respondedClass = pulse
      ? styles.dotResponded
      : styles.dotRespondedStatic;
    return (
      <span
        className={`${styles.dot} ${styles[size]} ${respondedClass}`}
        title="Agent responded"
        // The pulse is the "unread" signal, and CSS-module class names are
        // hashed in a build — so it is stated here too, for tests that need to
        // read it back.
        data-testid="agent-dot"
        data-status="responded"
        data-pulse={pulse ? "true" : "false"}
      />
    );
  }

  if (status === "complete") {
    return (
      <span
        className={`${styles.dot} ${styles[size]} ${styles.dotComplete}`}
        title="Agent complete"
        data-testid="agent-dot"
        data-status="complete"
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
        data-testid="agent-dot"
        data-status="requires_input"
      >
        <span className={styles.handEmoji}>👋</span>
      </span>
    );
  }

  return (
    <span
      className={`${styles.dot} ${styles[size]} ${status === "error" ? styles.dotError : ""}`}
      title={status === "error" ? "Agent error" : ""}
      data-testid="agent-dot"
      data-status={status}
    />
  );
}

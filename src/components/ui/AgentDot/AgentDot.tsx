import type { AgentStatus } from "../../../electron.d";
import { SpinnerLoader } from "../SpinnerLoader/SpinnerLoader";
import { Tooltip } from "../Tooltip/Tooltip";
import styles from "./AgentDot.module.css";

type AgentDotProps = {
  status?: AgentStatus;
  size: "pane" | "tab" | "sidebar" | "debug";
  pulse?: boolean;
  /**
   * Why the pane has this status, as the Status reconciler published it
   * (ADR-184 §4) — shown as the dot's tooltip. Omitted by callers that show
   * an aggregate across several panes, which has no single reason.
   */
  reason?: string;
};

export function AgentDot(props: AgentDotProps) {
  const { status, size, pulse = true, reason } = props;

  if (!status || status === "idle") return null;

  const wrap = (node: React.ReactElement) =>
    reason ? <Tooltip label={reason}>{node}</Tooltip> : node;

  if (status === "working" || status === "thinking") {
    return wrap(
      <span>
        <SpinnerLoader size={size} variant={status} />
      </span>,
    );
  }

  if (status === "responded") {
    // Read: the turn has been seen, so the agent is effectively idle — a
    // still gray ring rather than the green "unread" dot.
    if (!pulse) {
      return wrap(
        <span data-testid="agent-dot" data-status="responded" data-pulse="false">
          <SpinnerLoader size={size} variant="idle" />
        </span>,
      );
    }
    return wrap(
      <span
        className={`${styles.dot} ${styles[size]} ${styles.dotResponded}`}
        // The pulse is the "unread" signal, and CSS-module class names are
        // hashed in a build — so it is stated here too, for tests that need to
        // read it back.
        data-testid="agent-dot"
        data-status="responded"
        data-pulse="true"
      />,
    );
  }

  if (status === "requires_input") {
    return wrap(
      <span
        className={`${styles.dot} ${styles[size]} ${styles.dotRequiresInput}`}
        data-testid="agent-dot"
        data-status="requires_input"
      >
        <span className={styles.handEmoji}>👋</span>
      </span>,
    );
  }

  return wrap(
    <span
      className={`${styles.dot} ${styles[size]} ${status === "error" ? styles.dotError : ""}`}
      data-testid="agent-dot"
      data-status={status}
    />,
  );
}

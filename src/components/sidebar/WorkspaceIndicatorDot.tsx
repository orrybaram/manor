import { SpinnerLoader } from "../ui/SpinnerLoader/SpinnerLoader";
import { useDebouncedAgentStatus } from "../../hooks/useDebouncedAgentStatus";
import type { WorkspaceIndicator } from "../../lib/workspace-indicator";
import styles from "./WorkspaceIndicatorDot.module.css";

type Props = { indicator: NonNullable<WorkspaceIndicator> };

export function WorkspaceIndicatorDot({ indicator }: Props) {
  const { kind, pulse } = indicator;

  const debounced = useDebouncedAgentStatus(
    kind === "thinking" || kind === "working" ? kind : undefined,
  );
  const shown = debounced ?? kind;

  if (shown === "thinking" || shown === "working") {
    return (
      <span data-testid="workspace-indicator" data-kind={shown} data-pulse="false">
        <SpinnerLoader size="sidebar" variant={shown} />
      </span>
    );
  }

  if (kind === "needs_you") {
    return (
      <span
        className={`${styles.dot} ${styles.needsYou} ${pulse ? styles.pulse : ""}`}
        title="Needs your input"
        data-testid="workspace-indicator"
        data-kind="needs_you"
        data-pulse={pulse ? "true" : "false"}
      />
    );
  }

  return (
    <span
      className={`${styles.dot} ${styles.doneUnread} ${styles.pulse}`}
      title="Agent responded"
      data-testid="workspace-indicator"
      data-kind="done_unread"
      data-pulse="true"
    />
  );
}

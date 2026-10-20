import { SpinnerLoader } from "../ui/SpinnerLoader/SpinnerLoader";
import type { WorkspaceIndicator } from "../../lib/workspace-indicator";
import styles from "./WorkspaceIndicatorDot.module.css";

type Props = { indicator: NonNullable<WorkspaceIndicator> };

export function WorkspaceIndicatorDot({ indicator }: Props) {
  const { kind, pulse } = indicator;

  if (kind === "thinking" || kind === "working") {
    return (
      <span data-testid="workspace-indicator" data-kind={kind} data-pulse="false">
        <SpinnerLoader size="sidebar" variant={kind} />
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

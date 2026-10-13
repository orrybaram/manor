import { TASK_DOT, TASK_LABEL, type TaskDisplayStatus } from "./chat-entries";
import styles from "./ChatPane.module.css";

/** A task's status as the chat's dot (ADR-224 D4), shared by its card and its sheet. */
export function TaskStatusDot(props: { status: TaskDisplayStatus }) {
  const { status } = props;

  return (
    <span
      className={styles.statusDot}
      data-status={TASK_DOT[status]}
      role="img"
      aria-label={TASK_LABEL[status]}
    />
  );
}

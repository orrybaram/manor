import styles from "./TaskDetail.module.css";

const LINE_WIDTHS = ["90%", "75%", "60%"];

/** Bones for the meta fields while a task's detail loads. */
export function TaskMetaSkeleton() {
  return Array.from({ length: 4 }, (_, i) => (
    <div key={i} className={styles.metaField}>
      <div className={`${styles.bone} ${styles.boneLabel}`} />
      <div className={`${styles.bone} ${styles.boneValue}`} />
    </div>
  ));
}

/** Bones for the body while a task's detail loads; title and actions are already known. */
export function TaskBodySkeleton() {
  return (
    <div data-testid="task-detail-skeleton">
      {LINE_WIDTHS.map((width) => (
        <div
          key={width}
          className={`${styles.bone} ${styles.boneLine}`}
          style={{ width }}
        />
      ))}
    </div>
  );
}

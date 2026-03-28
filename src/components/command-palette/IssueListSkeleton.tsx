import styles from "./CommandPalette.module.css";

export function IssueListSkeleton() {
  return (
    <div>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className={styles.skeletonRow}>
          <div
            className={`${styles.skeletonBone} ${styles.skeletonIdentifier}`}
          />
          <div
            className={`${styles.skeletonBone} ${styles.skeletonTitle}`}
            style={{ width: `${40 + ((i * 17) % 40)}%` }}
          />
          <div className={`${styles.skeletonBone} ${styles.skeletonState}`} />
        </div>
      ))}
    </div>
  );
}

import { ArrowLeft } from "lucide-react";
import styles from "./CommandPalette.module.css";

export function IssueDetailSkeleton({ onBack }: { onBack: () => void }) {
  return (
    <>
      <div className={styles.detailLayout}>
        <div className={styles.detailBack}>
          <button className={styles.breadcrumbBack} onClick={onBack}>
            <ArrowLeft size={14} />
          </button>
        </div>
        <div className={styles.detailMain}>
          <div
            className={`${styles.skeletonBone} ${styles.skeletonDetailTitle}`}
          />
          <div
            className={`${styles.skeletonBone} ${styles.skeletonDetailLine}`}
            style={{ width: "90%" }}
          />
          <div
            className={`${styles.skeletonBone} ${styles.skeletonDetailLine}`}
            style={{ width: "75%" }}
          />
          <div
            className={`${styles.skeletonBone} ${styles.skeletonDetailLine}`}
            style={{ width: "60%" }}
          />
        </div>
        <div className={styles.detailSidebar}>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className={styles.sidebarField}>
              <div
                className={`${styles.skeletonBone} ${styles.skeletonSidebarLabel}`}
              />
              <div
                className={`${styles.skeletonBone} ${styles.skeletonSidebarValue}`}
              />
            </div>
          ))}
        </div>
      </div>
      <div className={styles.detailFooter}>
        <span className={styles.footerHint}>
          <kbd className={styles.kbd}>Enter</kbd>
          <span>Create Workspace</span>
        </span>
        <span className={styles.footerHint}>
          <kbd className={styles.kbd}>&#8984;O</kbd>
          <span>Open in Browser</span>
        </span>
      </div>
    </>
  );
}

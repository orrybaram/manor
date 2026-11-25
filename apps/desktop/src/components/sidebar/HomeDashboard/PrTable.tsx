import type { PrTableRow as PrTableRowData } from "../../../lib/home-dashboard-studio";
import { AnimatedCount } from "../../ui/AnimatedCount/AnimatedCount";
import { PrTableRow } from "./PrTableRow";
import { useDashboardAnimate } from "./useDashboardAnimate";
import { useSelectWorkspace } from "./useSelectWorkspace";
import styles from "./PrTable.module.css";

type PrTableProps = {
  /** Every open PR, in `prTable` order. */
  rows: readonly PrTableRowData[];
};

/**
 * The Pull requests section: one table row per open PR, with a signal cell
 * per question (CI, review, threads, merge) so a column reads down at a
 * glance. The table scrolls sideways inside its own box on a narrow pane.
 */
export function PrTable(props: PrTableProps) {
  const { rows } = props;
  const openWorkspace = useSelectWorkspace();
  const animateBody = useDashboardAnimate();
  const animateRows = useDashboardAnimate<HTMLTableSectionElement>();

  return (
    <section className={styles.section} aria-label="Pull requests">
      <h2 className={styles.heading}>
        Pull requests
        {rows.length > 0 && (
          <span className={styles.sub}>
            <AnimatedCount value={rows.length} /> open
          </span>
        )}
      </h2>
      <div ref={animateBody}>
        {rows.length === 0 ? (
          <p className={styles.empty}>No open pull requests.</p>
        ) : (
          <div className={styles.scroller}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col" className={styles.prHead}>
                    PR
                  </th>
                  <th scope="col">Size</th>
                  <th scope="col">CI</th>
                  <th scope="col">Review</th>
                  <th scope="col">Threads</th>
                  <th scope="col">Merge</th>
                  <th scope="col" className={styles.ageHead}>
                    Age
                  </th>
                </tr>
              </thead>
              <tbody ref={animateRows}>
                {rows.map((row) => (
                  <PrTableRow
                    key={row.pr.url}
                    row={row}
                    onOpen={() => openWorkspace(row.project, row.workspace)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

import type { NeedsYouCardContext } from "../../../lib/home-dashboard-studio";
import styles from "./NeedsYouCards.module.css";

/** Named failing checks shown before "+N more"; a card stays two lines tall. */
const CHECK_NAMES_SHOWN = 2;
/** Blocks in the finished card's diff bar. */
const DIFF_BLOCKS = 10;

type CardContextProps = {
  context: NeedsYouCardContext;
};

/** Added/removed blocks out of `DIFF_BLOCKS`, at least one each for a non-zero side. */
function diffBlocks(added: number, removed: number): { added: number; removed: number } {
  const total = added + removed;
  if (total === 0) return { added: 0, removed: 0 };
  let a = Math.round((added / total) * DIFF_BLOCKS);
  if (added > 0 && a === 0) a = 1;
  if (removed > 0 && a === DIFF_BLOCKS) a = DIFF_BLOCKS - 1;
  return { added: a, removed: DIFF_BLOCKS - a };
}

/**
 * A Needs you card's mono inset (ADR-198 §2): what the card is about, in
 * enough detail to act on without opening the workspace first.
 */
export function CardContext(props: CardContextProps) {
  const { context } = props;

  return <div className={styles.context}>{renderContext(context)}</div>;
}

function renderContext(context: NeedsYouCardContext) {
  switch (context.kind) {
    case "input":
      return <span className={styles.dim}>Waiting for your answer in its terminal.</span>;
    case "error":
      return context.paneTitle ? (
        <>
          <span className={styles.err}>✕ error</span>{" "}
          <span className={styles.strong}>{context.paneTitle}</span>
        </>
      ) : (
        <span className={styles.dim}>The agent stopped with an error.</span>
      );
    case "checks": {
      const shown = context.failing.slice(0, CHECK_NAMES_SHOWN);
      const more = context.failingCount - shown.length;
      const running = Math.max(0, context.total - context.passing - context.failingCount);
      return (
        <>
          {shown.map((check, i) => (
            <div key={`${check.name}-${i}`} className={`${styles.err} ${styles.truncate}`}>
              ✕ {check.name}
            </div>
          ))}
          {more > 0 && (
            <div className={styles.err}>
              {shown.length > 0 ? `+${more} more` : `✕ ${more} failing`}
            </div>
          )}
          <div className={styles.dim}>
            {context.passing} passed · {context.failingCount} failed · {running} running
          </div>
        </>
      );
    }
    case "conflicts":
      return (
        <>
          <span className={styles.err}>✕ Merge conflicts</span>{" "}
          <span className={styles.dim}>with the base branch</span>
        </>
      );
    case "changes-requested":
      return <span className={styles.strong}>A reviewer requested changes.</span>;
    case "threads":
      return (
        <span className={styles.strong}>
          {context.count} unresolved review thread{context.count === 1 ? "" : "s"}
        </span>
      );
    case "finished": {
      if (!context.diff) {
        return <span className={styles.dim}>Finished its turn. Review what it did.</span>;
      }
      const { added, removed } = context.diff;
      const blocks = diffBlocks(added, removed);
      return (
        <>
          <span className={styles.ok}>+{added}</span>{" "}
          <span className={styles.err}>−{removed}</span>{" "}
          <span className={styles.dim}>lines changed</span>
          <div className={styles.diffbar} aria-hidden>
            {Array.from({ length: DIFF_BLOCKS }, (_, i) => (
              <i
                key={i}
                className={
                  i < blocks.added ? styles.add : i < blocks.added + blocks.removed ? styles.del : undefined
                }
              />
            ))}
          </div>
        </>
      );
    }
    case "ready":
      return (
        <>
          <div>
            {context.approved ? (
              <span className={styles.ok}>✓ Approved</span>
            ) : (
              <span className={styles.dim}>No review required</span>
            )}
          </div>
          <div>
            {context.checksTotal > 0 ? (
              <span className={styles.ok}>
                ✓ {context.checksPassing}/{context.checksTotal} checks
              </span>
            ) : (
              <span className={styles.dim}>No checks</span>
            )}{" "}
            <span className={styles.dim}>· no conflicts</span>
          </div>
        </>
      );
  }
}

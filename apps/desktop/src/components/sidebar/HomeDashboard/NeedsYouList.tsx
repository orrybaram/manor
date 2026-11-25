import { useState } from "react";
import type { NeedsYouCard } from "../../../lib/home-dashboard-studio";
import { useSnoozeStore } from "../../../store/snooze-store";
import { AnimatedCount } from "../../ui/AnimatedCount/AnimatedCount";
import { Button } from "../../ui/Button/Button";
import { NeedsYouRow } from "./NeedsYouRow";
import { needsYouTitle } from "./needs-you-labels";
import { useDashboardAnimate } from "./useDashboardAnimate";
import { useSelectWorkspace } from "./useSelectWorkspace";
import styles from "./NeedsYouList.module.css";

/** Rows shown before the "+N more" row (density cap). */
const VISIBLE_COUNT = 5;

type NeedsYouListProps = {
  /** Visible items, snoozed ones already dropped, in `needsYouItems` tier order. */
  cards: readonly NeedsYouCard[];
};

/**
 * The Needs you section: one aligned row per item, each saying why it
 * needs the user, with one primary action and a snooze.
 */
export function NeedsYouList(props: NeedsYouListProps) {
  const { cards } = props;

  const snooze = useSnoozeStore((s) => s.snooze);
  const selectWorkspace = useSelectWorkspace();
  const [expanded, setExpanded] = useState(false);
  const animateBody = useDashboardAnimate();
  const animateRows = useDashboardAnimate<HTMLUListElement>();

  const shown = expanded ? cards : cards.slice(0, VISIBLE_COUNT);
  const hidden = cards.length - shown.length;

  return (
    <section className={styles.section} aria-label="Needs you">
      <h2 className={styles.heading}>
        Needs you
        {cards.length > 0 && <AnimatedCount value={cards.length} className={styles.count} />}
      </h2>
      <div ref={animateBody}>
        {cards.length === 0 ? (
          <p className={styles.empty}>Nothing needs you right now.</p>
        ) : (
          <>
            <ul ref={animateRows} className={styles.rows}>
              {shown.map((card) => (
                <NeedsYouRow
                  key={card.key}
                  card={card}
                  onOpenWorkspace={selectWorkspace}
                  onSnooze={(key) => snooze(key)}
                />
              ))}
            </ul>
            {hidden > 0 && (
              <Button variant="ghost" size="sm" className={styles.more} onClick={() => setExpanded(true)}>
                +{hidden} more · {needsYouTitle(cards[VISIBLE_COUNT])}
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

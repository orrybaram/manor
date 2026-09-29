import { useState } from "react";
import type { NeedsYouCard as NeedsYouCardData } from "../../../lib/home-dashboard-studio";
import { useSnoozeStore } from "../../../store/snooze-store";
import { Button } from "../../ui/Button/Button";
import { NeedsYouCard } from "./NeedsYouCard";
import { needsYouTitle } from "./needs-you-labels";
import { Panel } from "./Panel";
import { useSelectWorkspace } from "./useSelectWorkspace";
import styles from "./NeedsYouCards.module.css";

/** Cards shown before the "+N more" tile (ADR-198 Consequences: density caps). */
const VISIBLE_COUNT = 5;

type NeedsYouCardsProps = {
  /** Visible cards, snoozed ones already dropped, in `needsYouItems` tier order. */
  cards: readonly NeedsYouCardData[];
};

/** The Needs you panel (ADR-198 §1.4): a grid of action cards. */
export function NeedsYouCards(props: NeedsYouCardsProps) {
  const { cards } = props;

  const snooze = useSnoozeStore((s) => s.snooze);
  const selectWorkspace = useSelectWorkspace();
  const [expanded, setExpanded] = useState(false);

  const shown = expanded ? cards : cards.slice(0, VISIBLE_COUNT);
  const hidden = cards.length - shown.length;

  return (
    <Panel title="Needs you">
      {cards.length === 0 ? (
        <p className={styles.empty}>Nothing needs you right now.</p>
      ) : (
        <div className={styles.cards}>
          {shown.map((card) => (
            <NeedsYouCard
              key={card.key}
              card={card}
              onOpenWorkspace={selectWorkspace}
              onSnooze={(key) => snooze(key)}
            />
          ))}
          {hidden > 0 && (
            <Button variant="ghost" className={styles.more} onClick={() => setExpanded(true)}>
              +{hidden} more · {needsYouTitle(cards[VISIBLE_COUNT])}
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}

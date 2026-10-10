// TEMPORARY: a floating button for trying out the unlock toast (ADR-212).
// Delete this file, its CSS module and the <ToastTester /> line in App.tsx.
import * as Popover from "@radix-ui/react-popover";
import {
  BADGE_META,
  BADGE_SECTIONS,
  TIER_LABEL,
  TIER_ORDER,
  type BadgeTier,
} from "../../lib/badges";
import { Button } from "../ui/Button/Button";
import { useUnlockQueue, type UnlockItem } from "./useBadgeUnlocks";
import styles from "./ToastTester.module.css";

const TIERS = (Object.keys(TIER_ORDER) as BadgeTier[]).sort(
  (a, b) => TIER_ORDER[a] - TIER_ORDER[b],
);

function play(items: UnlockItem[]): void {
  useUnlockQueue.getState().enqueue(items);
}

function randomBadges(n: number): UnlockItem[] {
  const pool = [...BADGE_META].sort(() => Math.random() - 0.5);
  return pool.slice(0, n).map((b) => ({ kind: "badge", id: b.id }));
}

export function ToastTester() {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="secondary" className={styles.trigger}>
          Test toasts
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.panel}
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
        >
          <div className={styles.group}>
            <span className={styles.heading}>Quick</span>
            <div className={styles.row}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => play(randomBadges(1))}
              >
                Random badge
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => play(randomBadges(3))}
              >
                Burst of 3
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  play(
                    TIERS.map((tier) => ({
                      kind: "badge",
                      id: BADGE_META.find((b) => b.tier === tier)!.id,
                    })),
                  )
                }
              >
                One per tier
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  play([
                    ...randomBadges(1),
                    { kind: "complete", section: "staff" },
                  ])
                }
              >
                Badge + track complete
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => useUnlockQueue.getState().clear()}
              >
                Clear queue
              </Button>
            </div>
          </div>

          <div className={styles.group}>
            <span className={styles.heading}>Track complete</span>
            <div className={styles.row}>
              {BADGE_SECTIONS.map((s) => (
                <Button
                  key={s.id}
                  variant="ghost"
                  size="sm"
                  onClick={() => play([{ kind: "complete", section: s.id }])}
                >
                  {s.name}
                </Button>
              ))}
            </div>
          </div>

          {TIERS.map((tier) => (
            <div key={tier} className={styles.group}>
              <span className={styles.heading}>{TIER_LABEL[tier]}</span>
              <div className={styles.row}>
                {BADGE_META.filter((b) => b.tier === tier).map((b) => (
                  <Button
                    key={b.id}
                    variant="ghost"
                    size="sm"
                    onClick={() => play([{ kind: "badge", id: b.id }])}
                  >
                    {`${b.icon} ${b.title}`}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

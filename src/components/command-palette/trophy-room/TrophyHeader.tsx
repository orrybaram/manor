import * as Popover from "@radix-ui/react-popover";
import BadgeIcon from "lucide-react/dist/esm/icons/badge";
import Check from "lucide-react/dist/esm/icons/check";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import type { StatsSummary } from "../../../electron.d";
import {
  BADGE_META,
  TIER_LABEL,
  TIER_ORDER,
  earnedTitles,
  tierTally,
  type BadgeTier,
} from "../../../lib/badges";
import { usePreferencesStore } from "../../../store/preferences-store";
import { Button } from "../../ui/Button/Button";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { onMenuListKeyDown } from "../../tasks/task-menus";
import { displayedTitle } from "./trophy-data";
import styles from "./TrophyRoom.module.css";

const TIERS = (Object.keys(TIER_ORDER) as BadgeTier[]).sort(
  (a, b) => TIER_ORDER[a] - TIER_ORDER[b],
);

type TrophyHeaderProps = {
  summary: StatsSummary;
};

/**
 * Your title on the left (with a picker over every title you have earned),
 * the overall score on the right: earned / total, a bar split by tier, and
 * the per-tier tally.
 */
export function TrophyHeader(props: TrophyHeaderProps) {
  const { summary } = props;

  const chosen = usePreferencesStore((s) => s.preferences.achievementTitle);
  const setPreference = usePreferencesStore((s) => s.set);

  const titles = earnedTitles(summary);
  const shown = displayedTitle(summary, chosen);
  const tally = tierTally(summary);
  const total = BADGE_META.length;
  const earned = TIERS.reduce((n, tier) => n + tally[tier].got, 0);
  const gildedCount = titles.filter((t) => t.gilded).length;

  return (
    <header className={styles.header}>
      <div className={styles.titleBlock}>
        <span className={styles.eyebrow}>Title</span>
        {shown ? (
          <span
            className={styles.title}
            data-gilded={shown.gilded || undefined}
          >
            {shown.gilded && <BadgeIcon size={14} aria-hidden="true" />}
            {shown.gilded ? `${shown.title} · gilded` : shown.title}
            <Popover.Root>
              <Tooltip label="Change title" side="top">
                <Popover.Trigger asChild>
                  <Button
                    variant="ghost"
                    className={styles.titleEdit}
                    aria-label="Change title"
                  >
                    <Pencil size={12} />
                  </Button>
                </Popover.Trigger>
              </Tooltip>
              <Popover.Portal>
                <Popover.Content
                  className={styles.titleMenu}
                  side="bottom"
                  align="start"
                  sideOffset={6}
                  collisionPadding={8}
                >
                  <div
                    className={styles.titleMenuList}
                    role="group"
                    aria-label="Earned titles"
                    onKeyDown={onMenuListKeyDown}
                  >
                    {titles.map((t) => {
                      const active = t.title === shown.title;
                      return (
                        <Popover.Close asChild key={t.section}>
                          <Button
                            variant="ghost"
                            className={styles.titleMenuItem}
                            aria-pressed={active}
                            data-menu-item
                            onClick={() =>
                              setPreference("achievementTitle", t.title)
                            }
                          >
                            <span
                              className={styles.titleMenuLabel}
                              data-gilded={t.gilded || undefined}
                            >
                              {t.gilded ? `${t.title} · gilded` : t.title}
                            </span>
                            {active && <Check size={13} />}
                          </Button>
                        </Popover.Close>
                      );
                    })}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </span>
        ) : (
          <span className={`${styles.title} ${styles.titleEmpty}`}>
            No title yet · seal a track
          </span>
        )}
      </div>

      <div className={styles.score}>
        <div className={styles.scoreLine}>
          <span className={styles.scoreEarned}>{earned}</span>
          <span className={styles.scoreTotal}>{`/ ${total}`}</span>
          <span className={styles.scoreTitles}>
            {`${titles.length} ${titles.length === 1 ? "title" : "titles"} · ${gildedCount} gilded`}
          </span>
        </div>
        <div
          className={styles.tierBar}
          role="img"
          aria-label={`${earned} of ${total} badges earned`}
        >
          {TIERS.map((tier) => (
            <span
              key={tier}
              className={styles.tierSegment}
              data-tier={tier}
              style={{ width: `${(tally[tier].got / total) * 100}%` }}
            />
          ))}
        </div>
        <div className={styles.tally}>
          {TIERS.map((tier) => (
            <span key={tier} className={styles.tallyItem}>
              <span
                className={styles.tallyDot}
                data-tier={tier}
                aria-hidden="true"
              >
                {tier === "platinum" ? "◆" : "●"}
              </span>
              {`${tally[tier].got}/${tally[tier].of}`}
              <span className="sr-only">{` ${TIER_LABEL[tier]}`}</span>
              {tier === "platinum" && <span aria-hidden="true"> platinum</span>}
            </span>
          ))}
        </div>
      </div>
    </header>
  );
}

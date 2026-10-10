import * as Popover from "@radix-ui/react-popover";
import Check from "lucide-react/dist/esm/icons/check";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import type { StatsSummary } from "../../../electron.d";
import {
  BADGE_META,
  TIER_LABEL,
  STARTER_TITLES,
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
import { useGitHubLogin } from "./useGitHubLogin";
import styles from "./TrophyRoom.module.css";

const TIERS = (Object.keys(TIER_ORDER) as BadgeTier[]).sort(
  (a, b) => TIER_ORDER[a] - TIER_ORDER[b],
);

type TitleGroupProps = {
  label: string;
  titles: readonly string[];
  shown: string;
  onPick: (title: string) => void;
};

/** One labelled run of titles in the picker. */
function TitleGroup(props: TitleGroupProps) {
  const { label, titles, shown, onPick } = props;
  return (
    <div className={styles.titleMenuGroup} role="group" aria-label={label}>
      <span className={styles.titleMenuHeading} aria-hidden="true">
        {label}
      </span>
      {titles.map((title) => {
        const active = title === shown;
        return (
          <Popover.Close asChild key={title}>
            <Button
              variant="ghost"
              className={styles.titleMenuItem}
              aria-pressed={active}
              data-menu-item
              onClick={() => onPick(title)}
            >
              <span className={styles.titleMenuLabel}>{title}</span>
              {active && <Check size={13} />}
            </Button>
          </Popover.Close>
        );
      })}
    </div>
  );
}

type TrophyHeaderProps = {
  summary: StatsSummary;
};

/**
 * Who you are on the left — your GitHub login large, your title small under
 * it with a picker over every title you have earned plus the starter titles —
 * and the overall score on the right:
 * earned / total, a bar split by tier, and the per-tier tally.
 */
export function TrophyHeader(props: TrophyHeaderProps) {
  const { summary } = props;

  const chosen = usePreferencesStore((s) => s.preferences.achievementTitle);
  const setPreference = usePreferencesStore((s) => s.set);
  const login = useGitHubLogin();

  const titles = earnedTitles(summary);
  const shown = displayedTitle(titles, chosen);
  const pick = (title: string) => setPreference("achievementTitle", title);
  const tally = tierTally(summary);
  const total = BADGE_META.length;
  const earned = TIERS.reduce((n, tier) => n + tally[tier].got, 0);

  const titleLine = (
    <span className={login ? styles.title : `${styles.name} ${styles.title}`}>
      {shown}
      <Popover.Root>
        <Tooltip label="Change title" side="top">
          <Popover.Trigger asChild>
            <Button
              variant="ghost"
              className={styles.titleEdit}
              aria-label="Change title"
            >
              <Pencil size={login ? 11 : 12} />
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
            <div className={styles.titleMenuList} onKeyDown={onMenuListKeyDown}>
              {titles.length > 0 && (
                <TitleGroup
                  label="Earned"
                  titles={titles.map((t) => t.title)}
                  shown={shown}
                  onPick={pick}
                />
              )}
              <TitleGroup
                label="Starter"
                titles={STARTER_TITLES}
                shown={shown}
                onPick={pick}
              />
              <p className={styles.titleMenuHint}>
                Complete a track to earn its title.
              </p>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </span>
  );

  return (
    <header className={styles.header}>
      {/* Your login leads with the title under it; with no login the title
          leads alone rather than under an empty line. */}
      <div className={styles.titleBlock}>
        {login && <span className={styles.name}>{`@${login}`}</span>}
        {titleLine}
      </div>

      <div className={styles.score}>
        <div className={styles.scoreLine}>
          <span className={styles.scoreEarned}>{earned}</span>
          <span className={styles.scoreTotal}>{`/ ${total}`}</span>
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

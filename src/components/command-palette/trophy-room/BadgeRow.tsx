import type { CSSProperties } from "react";
import Lock from "lucide-react/dist/esm/icons/lock";
import { Button } from "../../ui/Button/Button";
import { TIER_LABEL, type BadgeMeta } from "../../../lib/badges";
import { formatAwarded, type BadgeEntry } from "./trophy-data";
import styles from "./TrophyRoom.module.css";

/** What the medal face shows. */
type MedalState = "earned" | "locked" | "secret" | "padlocked";

type MedalProps = {
  badge: BadgeMeta;
  state: MedalState;
};

/**
 * A badge's medal: its emoji with the `--badge-color` glow once earned, a
 * dashed ring around a dimmed emoji while locked, `?` for an unrevealed
 * secret, and a padlock for a gild badge still behind the seal.
 */
export function Medal(props: MedalProps) {
  const { badge, state } = props;

  return (
    <span
      className={styles.medal}
      data-state={state}
      style={{ "--badge-color": badge.color } as CSSProperties}
      aria-hidden="true"
    >
      {state === "secret" ? (
        "?"
      ) : state === "padlocked" ? (
        <Lock size={13} />
      ) : (
        <span className={styles.medalIcon}>{badge.icon}</span>
      )}
    </span>
  );
}

type ProgressBarProps = {
  /** 0–1. */
  ratio: number;
  label: string;
  /** Seal (purple) or gild (gold) fill; otherwise `tier` picks the tint. */
  tone?: "seal" | "gild";
  tier?: BadgeMeta["tier"];
};

export function ProgressBar(props: ProgressBarProps) {
  const { ratio, label, tone, tier } = props;

  const pct = Math.round(ratio * 100);

  return (
    <span
      className={styles.bar}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span
        className={styles.barFill}
        data-tone={tone}
        data-tier={tier}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

const SECRET_DESCRIPTION =
  "A hidden badge. Reveal it to see how to earn it — only you will see it.";

type BadgeRowProps = {
  entry: BadgeEntry;
  /** An unrevealed secret: `???`, a `?` medal, no tier or progress. */
  hidden?: boolean;
  /** A gild badge before its track is sealed: dimmed, padlock medal. */
  padlocked?: boolean;
  onReveal?: (id: string) => void;
};

/** One badge in a track's list. */
export function BadgeRow(props: BadgeRowProps) {
  const { entry, hidden = false, padlocked = false, onReveal } = props;

  const { badge, awardedAt } = entry;
  const earned = awardedAt !== null;
  const state: MedalState = earned
    ? "earned"
    : hidden
      ? "secret"
      : padlocked
        ? "padlocked"
        : "locked";
  const showBar = state === "locked" && entry.current > 0;

  return (
    <div className={styles.row} data-state={state}>
      <Medal badge={badge} state={state} />

      <div className={styles.rowBody}>
        <div className={styles.rowHead}>
          <span className={styles.rowName}>{hidden ? "???" : badge.title}</span>
          <span
            className={styles.tier}
            data-tier={hidden ? undefined : badge.tier}
          >
            {hidden ? "Secret" : TIER_LABEL[badge.tier]}
          </span>
        </div>
        <span className={styles.rowDesc}>
          {hidden ? SECRET_DESCRIPTION : badge.description}
        </span>
        {showBar && (
          <span className={styles.rowProgress}>
            <ProgressBar
              ratio={entry.ratio}
              label={`${badge.title} progress`}
              tier={badge.tier}
            />
            <span className={styles.count}>
              {`${entry.current.toLocaleString()} / ${entry.target.toLocaleString()}`}
            </span>
          </span>
        )}
      </div>

      {earned && (
        <span className={styles.rowWhen}>{formatAwarded(awardedAt)}</span>
      )}
      {hidden && onReveal && (
        <Button
          variant="secondary"
          size="sm"
          className={styles.reveal}
          onClick={() => onReveal(badge.id)}
        >
          Reveal
        </Button>
      )}
    </div>
  );
}

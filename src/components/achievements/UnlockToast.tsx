import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/Button/Button";
import {
  BADGE_META,
  BADGE_SECTIONS,
  TIER_LABEL,
  type BadgeSection,
  type BadgeTier,
} from "../../lib/badges";
import { useStatsStore } from "../../store/stats-store";
import { requestPaletteView } from "../../utils/palette-request";
import {
  unlockKey,
  useBadgeUnlocks,
  useUnlockQueue,
  type UnlockItem,
} from "./useBadgeUnlocks";
import styles from "./UnlockToast.module.css";

interface ToastView {
  eyebrow: string;
  name: string;
  icon: string;
  tier: BadgeTier;
  tierLabel: string;
  section: BadgeSection;
}

function describe(item: UnlockItem): ToastView | null {
  if (item.kind === "badge") {
    const badge = BADGE_META.find((b) => b.id === item.id);
    if (!badge) return null;
    return {
      eyebrow: "ACHIEVEMENT UNLOCKED",
      name: badge.title,
      icon: badge.icon,
      tier: badge.tier,
      tierLabel: TIER_LABEL[badge.tier].toUpperCase(),
      section: badge.section,
    };
  }
  const section = BADGE_SECTIONS.find((s) => s.id === item.section);
  if (!section) return null;
  const gilded = item.kind === "gild";
  return {
    eyebrow: gilded ? "TRACK GILDED" : "TRACK SEALED",
    name: section.title,
    icon: gilded ? "\u{1F451}" : "\u{1F396}️",
    tier: gilded ? "gold" : "silver",
    tierLabel: gilded ? "GILDED" : "SEALED",
    section: item.section,
  };
}

function Toast({ item, view }: { item: UnlockItem; view: ToastView }) {
  const dismiss = useUnlockQueue((s) => s.dismiss);

  const open = () => {
    useStatsStore.getState().focusTrack(view.section);
    requestPaletteView("stats");
    dismiss();
  };

  return (
    <div
      className={styles.toast}
      role="status"
      data-tier={view.tier}
      data-kind={item.kind}
    >
      <Button
        variant="ghost"
        className={styles.pill}
        onClick={open}
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.animationName === styles.leave || e.animationName === styles.hold) {
            dismiss();
          }
        }}
        aria-label={`${view.eyebrow}: ${view.name}`}
      >
        <span className={styles.medal} aria-hidden="true">
          <span className={styles.emoji}>{view.icon}</span>
        </span>
        <span className={styles.text}>
          <span className={styles.eyebrow}>{view.eyebrow}</span>
          <span className={styles.name}>{view.name}</span>
        </span>
        <span className={styles.tier}>{view.tierLabel}</span>
      </Button>
    </div>
  );
}

/** Bottom-center pill announcing badge, seal and gild unlocks, one at a time. */
export function UnlockToast() {
  useBadgeUnlocks();
  const head = useUnlockQueue((s) => s.queue[0]);
  if (!head) return null;
  const view = describe(head);
  // Unknown id (catalogue drift): skip it rather than stall the queue.
  if (!view) return <Skip />;
  return <Toast key={unlockKey(head)} item={head} view={view} />;
}

function Skip() {
  const dismiss = useUnlockQueue((s) => s.dismiss);
  useMountEffect(() => dismiss());
  return null;
}

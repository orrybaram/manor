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
  /** Read to screen readers; shown on screen only for a completed track. */
  eyebrow: string;
  name: string;
  detail: string;
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
      eyebrow: "Achievement unlocked",
      name: badge.title,
      detail: badge.description,
      icon: badge.icon,
      tier: badge.tier,
      tierLabel: TIER_LABEL[badge.tier],
      section: badge.section,
    };
  }
  const section = BADGE_SECTIONS.find((s) => s.id === item.section);
  if (!section) return null;
  return {
    eyebrow: "Track complete",
    name: section.title,
    detail: `Every ${section.name} badge earned. The title is yours.`,
    icon: "\u{1F396}️",
    tier: "gold",
    tierLabel: "Title",
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
      aria-label={`${view.eyebrow}: ${view.name}`}
      data-tier={view.tier}
      data-kind={item.kind}
    >
      <div
        className={styles.card}
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget) return;
          if (
            e.animationName === styles.leave ||
            e.animationName === styles.hold
          ) {
            dismiss();
          }
        }}
      >
        <span className={styles.medal} aria-hidden="true">
          <span className={styles.emoji}>{view.icon}</span>
        </span>
        {/* Clips the copy while the card is still a ring round the medal. */}
        <span className={styles.body}>
          <span className={styles.text}>
            <span className={styles.eyebrow}>
              <span className={styles.tier}>{view.tierLabel}</span>
              {item.kind === "complete" && ` · ${view.eyebrow}`}
            </span>
            <span className={styles.name}>{view.name}</span>
            <span className={styles.detail}>{view.detail}</span>
          </span>
          <Button
            variant="secondary"
            size="sm"
            className={styles.cta}
            onClick={open}
          >
            View details
          </Button>
        </span>
      </div>
    </div>
  );
}

/**
 * Badge and track-complete unlocks, one at a time: the medal pops in at the
 * centre of the window and pulses, then the card expands out of it.
 */
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

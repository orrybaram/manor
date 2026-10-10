import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { StatsSummary } from "../../../electron.d";
import type { BadgeSection } from "../../../lib/badges";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useStatsStore } from "../../../store/stats-store";
import { Button } from "../../ui/Button/Button";
import { BadgesTab } from "./BadgesTab";
import { StatsTab } from "./StatsTab";
import { TrophyHeader } from "./TrophyHeader";
import type { TrackSelection } from "./trophy-data";
import styles from "./TrophyRoom.module.css";

type Tab = "badges" | "stats";

const TABS: { id: Tab; label: string }[] = [
  { id: "stats", label: "Stats" },
  { id: "badges", label: "Badges" },
];

/**
 * Keys cmdk's root handles itself — it moves its own selection on arrows and
 * `preventDefault`s Enter, which would stop a focused button from clicking.
 * The room has no cmdk items, so it keeps these to itself.
 */
const CMDK_KEYS = new Set(["Enter", "ArrowUp", "ArrowDown", "Home", "End"]);

function keepKeysFromCmdk(e: KeyboardEvent<HTMLElement>): void {
  if (CMDK_KEYS.has(e.key)) e.stopPropagation();
}

type TrophyRoomProps = {
  summary: StatsSummary;
  /**
   * Track to open on, from `useStatsStore().focusTrack` (ADR-212). Read once
   * at mount; key the room on `focusSeq` to re-open it on a new track.
   */
  initialTrack: BadgeSection | null;
};

/** The stats view as a trophy room (ADR-212): header, then Stats | Badges. */
export function TrophyRoom(props: TrophyRoomProps) {
  const { summary, initialTrack } = props;

  // Opens on Stats, unless a toast asked for a particular track.
  const [tab, setTab] = useState<Tab>(initialTrack ? "badges" : "stats");
  const [track, setTrack] = useState<TrackSelection>(initialTrack ?? "summary");
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const idPrefix = useId();

  // The focus request is one-shot: once the room has opened on it, a later
  // visit to the stats view starts back at Summary.
  useMountEffect(() => {
    useStatsStore.getState().clearFocusTrack();
  });

  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const at = TABS.findIndex((t) => t.id === tab);
    const step = e.key === "ArrowRight" ? 1 : -1;
    const next = TABS[(at + step + TABS.length) % TABS.length].id;
    setTab(next);
    tabRefs.current.get(next)?.focus();
  };

  return (
    <div className={styles.room} onKeyDown={keepKeysFromCmdk}>
      <TrophyHeader summary={summary} />

      <div
        className={styles.tabs}
        role="tablist"
        aria-label="Trophy room sections"
        onKeyDown={onTabKeyDown}
      >
        {TABS.map((t) => (
          <Button
            key={t.id}
            ref={(el) => {
              if (el) tabRefs.current.set(t.id, el);
              else tabRefs.current.delete(t.id);
            }}
            variant="ghost"
            className={styles.tab}
            role="tab"
            id={`${idPrefix}-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${idPrefix}-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </Button>
        ))}
      </div>

      <div
        className={styles.panel}
        data-tab={tab}
        role="tabpanel"
        id={`${idPrefix}-panel-${tab}`}
        aria-labelledby={`${idPrefix}-tab-${tab}`}
      >
        {tab === "badges" ? (
          <BadgesTab summary={summary} selected={track} onSelect={setTrack} />
        ) : (
          <StatsTab summary={summary} />
        )}
      </div>
    </div>
  );
}

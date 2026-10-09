import { useMemo } from "react";
import type { StatsSummary } from "../../../electron.d";
import { BADGE_META, BADGE_SECTIONS, trackState } from "../../../lib/badges";
import { usePreferencesStore } from "../../../store/preferences-store";
import { Button } from "../../ui/Button/Button";
import { onMenuListKeyDown } from "../../tasks/task-menus";
import { SummaryPane } from "./SummaryPane";
import { TrackPane } from "./TrackPane";
import type { TrackSelection } from "./trophy-data";
import styles from "./TrophyRoom.module.css";

type SidebarItem = {
  id: TrackSelection;
  name: string;
  count: string;
  status?: "complete";
};

type TrackSidebarProps = {
  summary: StatsSummary;
  selected: TrackSelection;
  onSelect: (track: TrackSelection) => void;
};

/**
 * Summary, then every track with its `n/m` — or "complete" once it is.
 * Up / Down move between items.
 */
function TrackSidebar(props: TrackSidebarProps) {
  const { summary, selected, onSelect } = props;

  const earned = BADGE_META.filter((b) => summary.badges[b.id]).length;
  const items: SidebarItem[] = [
    { id: "summary", name: "Summary", count: `${earned}/${BADGE_META.length}` },
    ...BADGE_SECTIONS.map((section) => {
      const state = trackState(section, summary);
      const status: SidebarItem["status"] = state.complete
        ? "complete"
        : undefined;
      return {
        id: section.id,
        name: section.name,
        count: status ?? `${state.earned}/${state.total}`,
        status,
      };
    }),
  ];

  return (
    <nav
      className={styles.sidebar}
      aria-label="Tracks"
      onKeyDown={onMenuListKeyDown}
    >
      {items.map((item) => (
        <Button
          key={item.id}
          variant="ghost"
          className={styles.sidebarItem}
          aria-current={item.id === selected ? "true" : undefined}
          data-menu-item
          onClick={() => onSelect(item.id)}
        >
          <span className={styles.sidebarName}>{item.name}</span>
          <span className={styles.sidebarCount} data-status={item.status}>
            {item.count}
          </span>
        </Button>
      ))}
    </nav>
  );
}

type BadgesTabProps = {
  summary: StatsSummary;
  selected: TrackSelection;
  onSelect: (track: TrackSelection) => void;
};

/**
 * Track sidebar on the left, the selected track (or Summary) on the right.
 * The two panes flex-wrap, so a narrow palette stacks the sidebar on top.
 */
export function BadgesTab(props: BadgesTabProps) {
  const { summary, selected, onSelect } = props;

  const revealedBadges = usePreferencesStore(
    (s) => s.preferences.revealedBadges,
  );
  const setPreference = usePreferencesStore((s) => s.set);
  const revealed = useMemo(() => new Set(revealedBadges), [revealedBadges]);

  const reveal = (id: string) => {
    if (revealed.has(id)) return;
    setPreference("revealedBadges", [...revealedBadges, id]);
  };

  const section = BADGE_SECTIONS.find((s) => s.id === selected);

  return (
    <div className={styles.badgesTab}>
      <TrackSidebar summary={summary} selected={selected} onSelect={onSelect} />
      {section ? (
        <TrackPane
          section={section}
          summary={summary}
          revealed={revealed}
          onReveal={reveal}
        />
      ) : (
        <SummaryPane summary={summary} onSelectTrack={onSelect} />
      )}
    </div>
  );
}

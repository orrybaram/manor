import { useMemo } from "react";
import { useAgentStore } from "../../../store/agent-store";
import { useAppStore } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import {
  laneSegments,
  lanePriority,
  useAgentActivityStore,
} from "../../../store/agent-activity-store";
import { Panel } from "./Panel";
import { TimelineLane } from "./TimelineLane";
import { formatClock } from "./format";
import { STATUS_COLOR, timelineWindow } from "./timeline-model";
import styles from "./ActivityTimeline.module.css";

const MAX_LANES = 6;
const TICKS = 7;
const GRID_STEP_MS = 30 * 60 * 1000;

const LEGEND = [
  { label: "Working", color: STATUS_COLOR.working },
  { label: "Thinking", color: STATUS_COLOR.thinking },
  { label: "Waiting on you", color: STATUS_COLOR.requires_input },
  { label: "Finished", color: STATUS_COLOR.responded },
];

type ActivityTimelineProps = {
  /** Home's shared clock; the window slides with it. */
  now: number;
};

/**
 * The Agent activity panel (ADR-198 §1.5): a lane per recent agent pane over
 * the recorder's window, with the status history as coloured segments.
 */
export function ActivityTimeline(props: ActivityTimelineProps) {
  const { now } = props;

  const transitions = useAgentActivityStore((s) => s.transitions);
  const startedAt = useAgentActivityStore((s) => s.startedAt);
  const agents = useAgentStore((s) => s.agents);
  const paneTitle = useAppStore((s) => s.paneTitle);
  const projects = useProjectStore((s) => s.projects);

  const win = timelineWindow(now, startedAt);

  const lanes = useMemo(
    () =>
      lanePriority(transitions)
        .map((paneId) => ({
          paneId,
          transitions: transitions[paneId],
          segments: laneSegments(transitions[paneId], win.start, now),
        }))
        // A pane whose only activity fell outside the window has nothing to draw.
        .filter((lane) => lane.segments.length > 0)
        .slice(0, MAX_LANES),
    [transitions, win.start, now],
  );

  const ticks = Array.from({ length: TICKS }, (_, i) => {
    if (i === TICKS - 1) return "now";
    const at = win.start + (win.span * i) / (TICKS - 1);
    if (win.partial) return formatClock(at);
    const minutesAgo = Math.round((now - at) / 60_000);
    return minutesAgo % 60 === 0 ? `${minutesAgo / 60}h ago` : `${minutesAgo}m ago`;
  });

  const legend = (
    <div className={styles.legend}>
      {LEGEND.map((item) => (
        <span key={item.label} className={styles.legendItem}>
          <i style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );

  return (
    <Panel
      title="Agent activity"
      sub={win.partial ? `Since ${formatClock(startedAt)}` : "Last 3 hours"}
      right={legend}
    >
      {lanes.length === 0 ? (
        <p className={styles.empty}>No agent activity yet. Start one with ⌘N.</p>
      ) : (
        <div className={styles.timeline}>
          {lanes.map((lane) => {
            const agent = agents.find((a) => a.paneId === lane.paneId);
            const project = agent ? projects.find((p) => p.id === agent.projectId) : undefined;
            return (
              <TimelineLane
                key={lane.paneId}
                name={agent?.name || paneTitle[lane.paneId] || "Agent"}
                agent={agent}
                projectColor={project?.color ?? null}
                transitions={lane.transitions}
                segments={lane.segments}
                now={now}
                windowStart={win.start}
                windowSpan={win.span}
                gridStep={(GRID_STEP_MS / win.span) * 100}
              />
            );
          })}
          <div className={styles.axis}>
            <span />
            <span className={styles.ticks}>
              {ticks.map((label, i) => (
                <span key={i}>{label}</span>
              ))}
            </span>
            <span />
          </div>
        </div>
      )}
    </Panel>
  );
}

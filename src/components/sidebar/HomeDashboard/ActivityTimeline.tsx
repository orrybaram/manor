import { useMemo } from "react";
import { useAgentStore } from "../../../store/agent-store";
import { useProjectStore } from "../../../store/project-store";
import {
  laneSegments,
  lanePriority,
  useAgentActivityStore,
} from "../../../store/agent-activity-store";
import { Panel } from "./Panel";
import { useDashboardAnimate } from "./useDashboardAnimate";
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

  const snapshot = useAgentActivityStore((s) => s.snapshot);
  const agents = useAgentStore((s) => s.agents);
  const projects = useProjectStore((s) => s.projects);

  const animateBody = useDashboardAnimate();
  const animateLanes = useDashboardAnimate();

  // Ticket 3 replaces this: the window start is the first recorded session.
  const startedAt = snapshot?.sessions[0]?.start ?? now;
  const win = timelineWindow(now, startedAt);

  const lanes = useMemo(() => {
    const recorded = snapshot?.agents ?? {};
    const sessions = snapshot?.sessions ?? [];
    return (
      lanePriority(recorded, win.start, now)
        .map((agentId) => ({
          agentId,
          meta: recorded[agentId].meta,
          transitions: recorded[agentId].transitions,
          segments: laneSegments(
            recorded[agentId].transitions,
            win.start,
            now,
            sessions,
          ),
        }))
        // An Agent whose only activity fell in a closed gap has nothing to draw.
        .filter((lane) => lane.segments.length > 0)
        .slice(0, MAX_LANES)
    );
  }, [snapshot, win.start, now]);

  const ticks = Array.from({ length: TICKS }, (_, i) => {
    if (i === TICKS - 1) return "now";
    const at = win.start + (win.span * i) / (TICKS - 1);
    if (win.partial) return formatClock(at);
    const minutesAgo = Math.round((now - at) / 60_000);
    return minutesAgo % 60 === 0
      ? `${minutesAgo / 60}h ago`
      : `${minutesAgo}m ago`;
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
      <div ref={animateBody}>
        {lanes.length === 0 ? (
          <p className={styles.empty}>
            No agent activity yet. Start one with ⌘N.
          </p>
        ) : (
          <div ref={animateLanes} className={styles.timeline}>
            {lanes.map((lane) => {
              const agent = agents.find((a) => a.id === lane.agentId);
              const project = agent
                ? projects.find((p) => p.id === agent.projectId)
                : undefined;
              return (
                <TimelineLane
                  key={lane.agentId}
                  name={lane.meta.name || agent?.name || "Agent"}
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
      </div>
    </Panel>
  );
}

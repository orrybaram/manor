import { useMemo, type CSSProperties } from "react";
import { useAgentStore } from "../../../store/agent-store";
import { useProjectStore } from "../../../store/project-store";
import {
  ACTIVITY_WINDOW_MS,
  closedGaps,
  laneSegments,
  liveSessions,
  lanePriority,
  useAgentActivityStore,
} from "../../../store/agent-activity-store";
import { Panel } from "./Panel";
import { useDashboardAnimate } from "./useDashboardAnimate";
import { TimelineLane, type TimelineGap } from "./TimelineLane";
import { STATUS_COLOR } from "./timeline-model";
import styles from "./ActivityTimeline.module.css";

const MAX_LANES = 6;
const GRID_STEP_MS = 30 * 60 * 1000;

/** Axis labels across the fixed 3-hour window, oldest first. */
const TICKS = [
  "3h ago",
  "2h 30m ago",
  "2h ago",
  "1h 30m ago",
  "1h ago",
  "30m ago",
  "now",
];

const LEGEND_BARS = [
  { label: "Working", color: STATUS_COLOR.working },
  { label: "Thinking", color: STATUS_COLOR.thinking },
  { label: "Waiting on you", color: STATUS_COLOR.requires_input },
];

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop();

type ActivityTimelineProps = {
  /** Home's shared clock; the window slides with it. */
  now: number;
};

/**
 * The Agent activity panel (ADR-198 §1.5, ADR-199 §4): a lane per recently
 * active Agent over the last 3 hours, drawn from main's persisted history —
 * status segments, finished/errored markers, and "Manor closed" gaps.
 */
export function ActivityTimeline(props: ActivityTimelineProps) {
  const { now } = props;

  const snapshot = useAgentActivityStore((s) => s.snapshot);
  const agents = useAgentStore((s) => s.agents);
  const projects = useProjectStore((s) => s.projects);

  const animateBody = useDashboardAnimate();
  const animateLanes = useDashboardAnimate();

  const windowStart = now - ACTIVITY_WINDOW_MS;
  const sessions = useMemo(
    () => liveSessions(snapshot?.sessions ?? [], now),
    [snapshot, now],
  );

  // Only gaps *between* recorded sessions are "Manor closed". The span
  // before the first session is history that was never recorded, so it is
  // left as bare track rather than hatched (ADR-199 §4).
  const gaps = useMemo<TimelineGap[]>(() => {
    const firstStart = sessions[0]?.start ?? now;
    return closedGaps(sessions, windowStart, now).filter(
      (gap) => gap.from >= firstStart,
    );
  }, [sessions, windowStart, now]);

  const lanes = useMemo(() => {
    const recorded = snapshot?.agents ?? {};
    return (
      lanePriority(recorded, windowStart, now)
        .map((agentId) => ({
          agentId,
          meta: recorded[agentId].meta,
          transitions: recorded[agentId].transitions,
          segments: laneSegments(
            recorded[agentId].transitions,
            windowStart,
            now,
            sessions,
          ),
        }))
        // An Agent whose only activity fell in a closed gap has nothing to draw.
        .filter((lane) => lane.segments.length > 0)
        .slice(0, MAX_LANES)
    );
  }, [snapshot, sessions, windowStart, now]);

  const legend = (
    <div className={styles.legend}>
      {LEGEND_BARS.map((item) => (
        <span key={item.label} className={styles.legendItem}>
          <i style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
      <span className={styles.legendItem}>
        <i
          className={styles.legendRing}
          style={{ "--c": STATUS_COLOR.responded } as CSSProperties}
        />
        Finished
      </span>
    </div>
  );

  return (
    <Panel title="Agent activity" sub="Last 3 hours" right={legend}>
      <div ref={animateBody}>
        {lanes.length === 0 ? (
          <p className={styles.empty}>No agent activity in the last 3 hours.</p>
        ) : (
          <div ref={animateLanes} className={styles.timeline}>
            {lanes.map((lane) => {
              const agent = agents.find((a) => a.id === lane.agentId);
              const project = projects.find(
                (p) => p.id === lane.meta.projectId,
              );
              const workspace = project?.workspaces.find(
                (w) => w.path === lane.meta.workspacePath,
              );
              const name =
                lane.meta.name ||
                workspace?.name ||
                workspace?.branch ||
                (lane.meta.workspacePath
                  ? basename(lane.meta.workspacePath)
                  : undefined) ||
                "Agent";
              return (
                <TimelineLane
                  key={lane.agentId}
                  name={name}
                  agent={agent}
                  project={
                    project && {
                      name: project.name,
                      color: project.color ?? null,
                    }
                  }
                  gaps={gaps}
                  transitions={lane.transitions}
                  segments={lane.segments}
                  now={now}
                  windowStart={windowStart}
                  windowSpan={ACTIVITY_WINDOW_MS}
                  gridStep={(GRID_STEP_MS / ACTIVITY_WINDOW_MS) * 100}
                />
              );
            })}
            <div className={styles.axis}>
              <span />
              <span className={styles.ticks}>
                {TICKS.map((label, i) => (
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

import type { CSSProperties } from "react";
import type { AgentActivityTransition, AgentInfo } from "../../../electron.d";
import {
  laneMarkers,
  type LaneSegment,
} from "../../../store/agent-activity-store";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import { navigateToAgent } from "../../../utils/agent-navigation";
import { Button } from "../../ui/Button/Button";
import { formatAge, formatClock } from "./format";
import { isWaitStatus, pct, STATUS_COLOR, STATUS_LABEL } from "./timeline-model";
import styles from "./ActivityTimeline.module.css";

/** A span inside the window when Manor wasn't running, so nothing was recorded. */
export type TimelineGap = { from: number; to: number };

type TimelineLaneProps = {
  name: string;
  agent: AgentInfo | undefined;
  /** The agent's project (chip title and colour token), when known. */
  project: { name: string; color: string | null } | undefined;
  /** Spans where Manor was closed, drawn behind the segments. */
  gaps: TimelineGap[];
  transitions: AgentActivityTransition[];
  segments: LaneSegment[];
  now: number;
  windowStart: number;
  windowSpan: number;
  /** Percent of the track between 30-minute gridlines. */
  gridStep: number;
};

/** One agent's row: name, its coloured track and its current state. */
export function TimelineLane(props: TimelineLaneProps) {
  const { name, agent, project, gaps, transitions, segments, now, windowStart, windowSpan, gridStep } = props;

  const current = transitions[transitions.length - 1];
  const stateColor = current ? STATUS_COLOR[current.status] : STATUS_COLOR.idle;
  const stateText = current ? stateLabel(current, now) : "";
  const markers = laneMarkers(transitions, windowStart, now);

  const rowContent = (
    <>
      <span className={styles.name}>
        {project && (
          <span className={styles.proj} style={projectColorStyle(project.color)} title={project.name} />
        )}
        <span className={styles.nameText}>{name}</span>
      </span>
      <span className={styles.track} style={{ "--step": `${gridStep}%` } as CSSProperties}>
        {gaps.map((gap) => {
          const left = pct(gap.from, windowStart, windowSpan);
          const width = pct(gap.to, windowStart, windowSpan) - left;
          return (
            <span
              key={`gap-${gap.from}`}
              className={styles.gap}
              style={{ left: `${left}%`, width: `${width}%` }}
              title="Manor closed"
            />
          );
        })}
        {segments.map((seg) => {
          const left = pct(seg.from, windowStart, windowSpan);
          const width = pct(seg.to, windowStart, windowSpan) - left;
          const live = seg.to >= now;
          const classes = [
            styles.seg,
            isWaitStatus(seg.status) ? styles.wait : "",
            live ? styles.live : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <span
              key={`${seg.status}-${seg.from}`}
              className={classes}
              style={{ "--c": STATUS_COLOR[seg.status], left: `${left}%`, width: `${width}%` } as CSSProperties}
              title={`${STATUS_LABEL[seg.status]} · ${formatClock(seg.from)} → ${live ? "now" : formatClock(seg.to)}`}
            />
          );
        })}
        {markers.map((m) => {
          const status = m.kind === "error" ? "error" : "responded";
          return (
            <span
              key={`mark-${m.kind}-${m.at}`}
              className={`${styles.mark} ${m.kind === "error" ? styles.markErr : ""}`}
              style={{ "--c": STATUS_COLOR[status], left: `${pct(m.at, windowStart, windowSpan)}%` } as CSSProperties}
              title={`${m.kind === "error" ? "Errored" : "Finished"} · ${formatClock(m.at)}`}
            />
          );
        })}
      </span>
      <span className={styles.state} style={{ "--c": stateColor } as CSSProperties}>
        {stateText}
      </span>
    </>
  );

  if (!agent) return <div className={styles.row}>{rowContent}</div>;
  return (
    <Button
      variant="ghost"
      className={`${styles.row} ${styles.rowButton}`}
      onClick={() => navigateToAgent(agent)}
      aria-label={`Open ${name}`}
    >
      {rowContent}
    </Button>
  );
}

/** The state column: how long an active/waiting state has lasted, how long ago it finished, else its name. */
function stateLabel(current: AgentActivityTransition, now: number): string {
  switch (current.status) {
    case "idle":
      return "idle";
    case "error":
      return "error";
    case "responded":
      return `${formatAge(now - current.at)} ago`;
    default:
      return formatAge(now - current.at);
  }
}

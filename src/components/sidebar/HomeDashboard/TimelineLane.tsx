import type { CSSProperties } from "react";
import type { AgentInfo } from "../../../electron.d";
import type { AgentActivityTransition } from "../../../electron.d";
import type { LaneSegment } from "../../../store/agent-activity-store";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import { navigateToAgent } from "../../../utils/agent-navigation";
import { Button } from "../../ui/Button/Button";
import { formatAge, formatClock } from "./format";
import { isWaitStatus, pct, STATUS_COLOR, STATUS_LABEL } from "./timeline-model";
import styles from "./ActivityTimeline.module.css";

type TimelineLaneProps = {
  name: string;
  agent: AgentInfo | undefined;
  /** The agent's project colour token, when its project is known. */
  projectColor: string | null;
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
  const { name, agent, projectColor, transitions, segments, now, windowStart, windowSpan, gridStep } = props;

  const current = transitions[transitions.length - 1];
  const stateColor = current ? STATUS_COLOR[current.status] : STATUS_COLOR.idle;
  const stateText = current ? stateLabel(current, now) : "";
  const chipName = agent?.projectName;

  const rowContent = (
    <>
      <span className={styles.name}>
        {chipName && (
          <span className={styles.proj} style={projectColorStyle(projectColor)} title={chipName} />
        )}
        <span className={styles.nameText}>{name}</span>
      </span>
      <span className={styles.track} style={{ "--step": `${gridStep}%` } as CSSProperties}>
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
        {transitions
          .filter(
            (t) =>
              (t.status === "responded" || t.status === "error") &&
              t.at >= windowStart &&
              t.at <= now,
          )
          .map((t) => (
            <span
              key={`mark-${t.status}-${t.at}`}
              className={`${styles.mark} ${t.status === "error" ? styles.markErr : ""}`}
              style={{ "--c": STATUS_COLOR[t.status], left: `${pct(t.at, windowStart, windowSpan)}%` } as CSSProperties}
              title={`${t.status === "error" ? "Errored" : "Finished"} · ${formatClock(t.at)}`}
            />
          ))}
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

/** The state column: how long an active/waiting state has lasted, else its name. */
function stateLabel(current: AgentActivityTransition, now: number): string {
  switch (current.status) {
    case "idle":
      return "idle";
    case "error":
      return "error";
    case "responded":
      return "done";
    default:
      return formatAge(now - current.at);
  }
}

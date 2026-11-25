import { useMemo, type CSSProperties } from "react";
import type { AgentActivityTransition, AgentStatus } from "../../../electron.d";
import { runningAgents } from "../../../lib/home-dashboard";
import { useAgentStore } from "../../../store/agent-store";
import { useAppStore } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import {
  ACTIVITY_WINDOW_MS,
  laneSegments,
  lanePriority,
  liveSessions,
  useAgentActivityStore,
} from "../../../store/agent-activity-store";
import { resolveAgentTitle, useCleanPaneTitles } from "../../../hooks/useAgentDisplay";
import { navigateToAgent } from "../../../utils/agent-navigation";
import { AnimatedCount } from "../../ui/AnimatedCount/AnimatedCount";
import { Button } from "../../ui/Button/Button";
import { formatAge, formatClock } from "./format";
import { pct, STATUS_COLOR, STATUS_LABEL } from "./timeline-model";
import { useDashboardAnimate } from "./useDashboardAnimate";
import styles from "./DashboardRail.module.css";

/** Running agents listed before "+N more". */
const MAX_RUNNING = 5;
/** Activity lanes drawn under the running list. */
const MAX_LANES = 5;

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop();

const isRunning = (status: AgentStatus) => status === "working" || status === "thinking";

/**
 * When the agent's current run began: the earliest of the unbroken
 * working/thinking transitions at the end of its history. Null when the
 * history doesn't end in a run (not recorded yet).
 */
function runStart(transitions: readonly AgentActivityTransition[] | undefined): number | null {
  if (!transitions) return null;
  let start: number | null = null;
  for (let i = transitions.length - 1; i >= 0; i--) {
    if (!isRunning(transitions[i].status)) break;
    start = transitions[i].at;
  }
  return start;
}

type RailAgentsProps = {
  /** Home's shared clock; elapsed times and the window slide with it. */
  now: number;
};

/**
 * The rail's Agents working section: how many agents are running, each one
 * with how long it has been at it (click to go to it), and a thin lane per
 * recently active agent over the last 3 hours.
 */
export function RailAgents(props: RailAgentsProps) {
  const { now } = props;

  const agents = useAgentStore((s) => s.agents);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
  const paneTitle = useCleanPaneTitles();
  const projects = useProjectStore((s) => s.projects);
  const snapshot = useAgentActivityStore((s) => s.snapshot);
  const animateRows = useDashboardAnimate<HTMLUListElement>();

  const running = useMemo(
    () =>
      runningAgents(agents, paneAgentStatus)
        .map(({ agent, status }) => ({
          agent,
          status,
          title: resolveAgentTitle(agent, (agent.paneId && paneTitle[agent.paneId]) || null),
          since: runStart(snapshot?.agents[agent.id]?.transitions),
        }))
        // Longest-running first.
        .sort((a, b) => (a.since ?? now) - (b.since ?? now)),
    [agents, paneAgentStatus, paneTitle, snapshot, now],
  );

  const windowStart = now - ACTIVITY_WINDOW_MS;
  const lanes = useMemo(() => {
    const recorded = snapshot?.agents ?? {};
    const sessions = liveSessions(snapshot?.sessions ?? [], now);
    return lanePriority(recorded, windowStart, now)
      .map((agentId) => {
        const { meta, transitions } = recorded[agentId];
        const workspace = projects
          .find((p) => p.id === meta.projectId)
          ?.workspaces.find((w) => w.path === meta.workspacePath);
        const name =
          meta.name ||
          workspace?.name ||
          workspace?.branch ||
          (meta.workspacePath ? basename(meta.workspacePath) : undefined) ||
          "Agent";
        return {
          agentId,
          name,
          segments: laneSegments(transitions, windowStart, now, sessions),
        };
      })
      .filter((lane) => lane.segments.length > 0)
      .slice(0, MAX_LANES);
  }, [snapshot, projects, windowStart, now]);

  const shown = running.slice(0, MAX_RUNNING);
  const hidden = running.length - shown.length;

  return (
    <section className={styles.section} aria-label="Agents working">
      <h2 className={styles.label}>
        Agents working
        <AnimatedCount value={running.length} className={`${styles.labelCount} ${styles.green}`} />
      </h2>
      <ul ref={animateRows} className={styles.list}>
        {shown.map(({ agent, status, title, since }) => (
          <li key={agent.id}>
            <Button
              variant="ghost"
              className={styles.agentRow}
              onClick={() => navigateToAgent(agent)}
              aria-label={`Open ${title}`}
              title={`${STATUS_LABEL[status]}${since != null ? ` since ${formatClock(since)}` : ""}`}
            >
              <i className={styles.dot} style={{ "--c": STATUS_COLOR[status] } as CSSProperties} />
              <span className={styles.rowText}>{title}</span>
              {since != null && <span className={styles.meta}>{formatAge(now - since)}</span>}
            </Button>
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className={styles.note}>+{hidden} more</p>}
      {lanes.length === 0 ? (
        running.length === 0 && <p className={styles.note}>No agent activity in the last 3 hours.</p>
      ) : (
        <div className={styles.lanes} aria-label="Agent activity, last 3 hours" role="group">
          {lanes.map((lane) => (
            <div key={lane.agentId} className={styles.lane}>
              <span className={styles.laneName} title={lane.name}>
                {lane.name}
              </span>
              <span className={styles.track}>
                {lane.segments.map((seg) => {
                  const left = pct(seg.from, windowStart, ACTIVITY_WINDOW_MS);
                  const width = pct(seg.to, windowStart, ACTIVITY_WINDOW_MS) - left;
                  const live = seg.to >= now;
                  return (
                    <i
                      key={`${seg.status}-${seg.from}`}
                      style={{ "--c": STATUS_COLOR[seg.status], left: `${left}%`, width: `${width}%` } as CSSProperties}
                      title={`${STATUS_LABEL[seg.status]} · ${formatClock(seg.from)} → ${live ? "now" : formatClock(seg.to)}`}
                    />
                  );
                })}
              </span>
            </div>
          ))}
          <div className={styles.laneAxis} aria-hidden="true">
            <span>3h ago</span>
            <span>now</span>
          </div>
        </div>
      )}
    </section>
  );
}

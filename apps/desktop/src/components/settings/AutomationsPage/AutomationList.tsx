import CalendarClock from "lucide-react/dist/esm/icons/calendar-clock";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import type { AutomationView } from "../../../lib/automation-views";
import { CUSTOM_SCHEDULE, describeCron, timezoneLabel } from "../../../lib/cron-describe";
import { useProjectStore } from "../../../store/project-store";
import { AGENT_KIND_LABEL, lastRunText, relativeWhen } from "./automation-text";
import { RunStatus } from "./RunHistory";
import type { AutomationHost, HostListState } from "./useAutomations";
import styles from "./AutomationsPage.module.css";

type AutomationListProps = {
  hosts: AutomationHost[];
  lists: Record<string, HostListState>;
  onOpen: (hostId: string, id: string) => void;
};

/** Why a host's automations aren't listed, or null when they are. */
function hostLine(host: AutomationHost, state: HostListState | undefined): string | null {
  switch (state?.kind) {
    case "asleep":
      return `${host.name} is asleep. Its automations show when it's back.`;
    case "unreachable":
      return `Can't reach ${host.name}`;
    case "unsupported":
      return `${host.name} has no Manor host server yet, so it can't run automations`;
    case "loading":
      // Connecting: asked once it is up.
      return "Loading…";
    default:
      return null;
  }
}

/**
 * The automations of every host, a group per host in the Hosts page's
 * order, each a card: name, then schedule, project and agent; next run and
 * last run on the right. A host with none is left out; one that can't be
 * read says so. A card is a button that opens the automation's page.
 */
export function AutomationList(props: AutomationListProps) {
  const { hosts, lists, onOpen } = props;
  const projects = useProjectStore((s) => s.projects);

  const groups = hosts.flatMap((host) => {
    const state = lists[host.hostId];
    const automations = state?.kind === "ready" ? state.automations : [];
    const line = hostLine(host, state);
    return automations.length > 0 || line ? [{ host, automations, line }] : [];
  });
  const count = groups.reduce((n, g) => n + g.automations.length, 0);
  const loading = hosts.some((h) => (lists[h.hostId]?.kind ?? "loading") === "loading");

  if (count === 0 && groups.length === 0) {
    return (
      <div className={styles.placeholder} data-testid="automations-empty">
        {loading
          ? "Loading…"
          : "No automations yet. An automation starts an agent on a schedule — triage PRs each weekday morning, check CI every hour — in a new workspace or one you reuse."}
      </div>
    );
  }

  return (
    <div className={styles.table} data-testid="automations-list">
      {count === 0 && (
        <div className={styles.groupLine}>
          No automations yet. An automation starts an agent on a schedule, in a new workspace or one
          you reuse.
        </div>
      )}
      {groups.map(({ host, automations, line }) => (
        <div
          key={host.hostId}
          role="group"
          aria-labelledby={`automations-host-title-${host.hostId}`}
          data-testid={`automations-host-${host.hostId}`}
        >
          <div className={styles.groupTitle} id={`automations-host-title-${host.hostId}`}>
            {host.name}
            {host.local && <span className={styles.groupNote}> · runs only while Manor is open</span>}
          </div>
          {line && <div className={styles.groupLine}>{line}</div>}
          {automations.length > 0 && (
            <div className={styles.cards}>
              {automations.map((a) => (
                <Row
                  key={a.id}
                  automation={a}
                  projectName={projects.find((p) => p.id === a.projectId)?.name ?? "Missing project"}
                  onOpen={() => onOpen(host.hostId, a.id)}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Row(props: { automation: AutomationView; projectName: string; onOpen: () => void }) {
  const { automation: a, projectName, onOpen } = props;
  const last = lastRunText(a);
  const next = a.nextRunAt ?? a.nextRuns[0] ?? null;
  const tz = a.schedule.timezone;
  const description = describeCron(a.schedule.cron);
  // Upcoming times read in the schedule's zone; the pill's tooltip names it.
  const zone = `${timezoneLabel(tz)} time`;

  // Spans throughout: a button holds only phrasing content.
  return (
    <button
      type="button"
      className={`${styles.row} ${a.enabled ? "" : styles.paused}`}
      data-testid={`automations-row-${a.id}`}
      onClick={onOpen}
    >
      <span className={styles.badge} aria-hidden>
        <CalendarClock size={15} />
      </span>
      <span className={styles.cellName}>
        <span className={styles.name}>{a.name}</span>
        <span className={styles.sub}>
          {description === CUSTOM_SCHEDULE ? (
            <span className={styles.mono}>{a.schedule.cron}</span>
          ) : (
            description
          )}{" "}
          · {projectName} · {AGENT_KIND_LABEL[a.agentKind]}
        </span>
      </span>
      <span className={styles.cellWhen}>
        {!a.enabled ? (
          <span className={styles.pill}>Paused</span>
        ) : next ? (
          <span className={styles.pill} title={zone}>
            {relativeWhen(next, new Date(), tz)}
          </span>
        ) : null}
        {last ? <RunStatus status={last} /> : <span className={styles.never}>Never run</span>}
      </span>
      <span className={styles.chevron} aria-hidden>
        <ChevronRight size={13} />
      </span>
    </button>
  );
}

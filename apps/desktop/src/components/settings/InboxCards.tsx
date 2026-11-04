import { useState } from "react";

import { useMountEffect } from "../../hooks/useMountEffect";
import { INBOX_TYPES, type InboxSourceId, type InboxSourceStatus, type InboxStatus } from "../../lib/inbox";
import { usePreferencesStore } from "../../store/preferences-store";
import { Switch } from "../ui/Switch/Switch";
import { SectionTitle } from "./SectionTitle";
import styles from "./SettingsModal/SettingsModal.module.css";

const STATUS_REFRESH_MS = 15_000;

const SOURCES: { id: InboxSourceId; name: string; unit: string; signedOut: string; none: string }[] = [
  {
    id: "github",
    name: "GitHub",
    unit: "repo",
    signedOut: "Not signed in. Run gh auth login on this computer, then these start on their own.",
    none: "None of your projects has a GitHub origin, so nothing will arrive.",
  },
  {
    id: "linear",
    name: "Linear",
    unit: "team",
    signedOut: "Not connected. Add your Linear key in Settings › Integrations.",
    none: "No teams linked. Link one in a project's settings to get these.",
  },
];

function ago(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} hr ago`;
}

/** The card's status line, and whether it needs the user to do something. */
export function inboxStatusLine(
  source: { unit: string; signedOut: string; none: string },
  status: InboxSourceStatus | undefined,
  now: number,
): { text: string; warn: boolean } {
  switch (status?.state) {
    case "signed-out":
      return { text: source.signedOut, warn: true };
    case "error":
      return {
        text: status.checkedAt
          ? `Couldn't check. Trying again soon. Last worked ${ago(status.checkedAt, now)}.`
          : "Couldn't check. Trying again soon.",
        warn: true,
      };
    case "ok": {
      if (status.covered === 0) return { text: source.none, warn: true };
      const covered = `${status.covered} ${source.unit}${status.covered === 1 ? "" : "s"} from your projects`;
      return {
        text: [status.account, covered, `checked ${ago(status.checkedAt, now)}`].filter(Boolean).join(" · "),
        warn: false,
      };
    }
    default:
      return { text: "Checking…", warn: false };
  }
}

/** Settings › Notifications: a card per **Inbox**, its status and its types. */
export function InboxCards() {
  const { preferences, set } = usePreferencesStore();
  const [status, setStatus] = useState<InboxStatus | null>(null);
  const [expanded, setExpanded] = useState<Partial<Record<InboxSourceId, boolean>>>({});

  useMountEffect(() => {
    let live = true;
    const refresh = () => {
      void window.electronAPI.notifications
        .inboxStatus()
        .then((next) => {
          if (live) setStatus(next);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, STATUS_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  });

  const now = Date.now();
  return (
    <>
      {SOURCES.map((source) => {
        const types = INBOX_TYPES.filter((t) => t.source === source.id);
        const main = types.filter((t) => t.defaultOn);
        const more = types.filter((t) => !t.defaultOn);
        // A type left on stays in view even when the rest fold away.
        const shownMore = expanded[source.id] ? more : more.filter((t) => preferences[t.preference]);
        const folded = more.length - shownMore.length;
        const line = inboxStatusLine(source, status?.[source.id], now);
        return (
          <div key={source.id} className={styles.inboxCard} data-testid={`inbox-card-${source.id}`}>
            <SectionTitle id={`notifications-inbox-${source.id}`}>{source.name}</SectionTitle>
            <div className={styles.inboxStatus} data-warn={line.warn}>
              {line.text}
            </div>
            <div>
              {[...main, ...shownMore].map((type) => (
                <label key={type.kind} className={styles.notifRow}>
                  <span>{type.label}</span>
                  <Switch
                    checked={preferences[type.preference]}
                    onCheckedChange={(checked) => set(type.preference, checked)}
                  />
                </label>
              ))}
            </div>
            {(folded > 0 || expanded[source.id]) && (
              <button
                type="button"
                className={styles.inboxMore}
                aria-expanded={!!expanded[source.id]}
                onClick={() => setExpanded((e) => ({ ...e, [source.id]: !e[source.id] }))}
              >
                {expanded[source.id] ? "Fewer types" : `More types (${folded})`}
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

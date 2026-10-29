import { useRef, useState } from "react";
import { UNAVAILABLE_HOST_CODE } from "../../../../electron/bridge/types";
import type { AutomationDetail, AutomationView } from "../../../lib/automation-views";
import { hostName } from "../../../lib/hosts";
import { groupHostsByProfile } from "../../../lib/host-groups";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useHostProfileStore } from "../../../store/host-profile-store";
import { useHostStore, type HostStatusInfo } from "../../../store/host-store";

/** A host the page lists automations for, as the renderer names it. */
export interface AutomationHost {
  hostId: string;
  name: string;
  /** This computer: its automations fire only while Manor is open. */
  local: boolean;
  status: HostStatusInfo["status"];
}

/**
 * Every host, in the Hosts page's order: this computer, then each
 * profile's hosts, then the rest.
 */
export function useAutomationHosts(): AutomationHost[] {
  const hosts = useHostStore((s) => s.hosts);
  const profiles = useHostProfileStore((s) => s.profiles);
  return automationHosts(hosts, profiles);
}

function currentHosts(): AutomationHost[] {
  return automationHosts(useHostStore.getState().hosts, useHostProfileStore.getState().profiles);
}

function automationHosts(
  hosts: HostStatusInfo[],
  profiles: { id: string }[],
): AutomationHost[] {
  const localInfo = hosts.find((h) => h.spec === null);
  const remote = hosts.filter((h) => h.spec !== null);
  const { groups, rest } = groupHostsByProfile(remote, profiles);
  const ordered = [...groups.flatMap((g) => g.hosts), ...rest];
  return [
    {
      hostId: localInfo?.hostId ?? "local",
      name: "This Mac",
      local: true,
      status: "connected",
    },
    ...ordered.map((h) => ({
      hostId: h.hostId,
      name: hostName(h),
      local: false,
      status: h.status,
    })),
  ];
}

/**
 * What one host's list is: read, or why it can't be. A host asleep is never
 * asked (a read must not wake it); one away is not asked either.
 */
export type HostListState =
  | { kind: "loading" }
  | { kind: "ready"; automations: AutomationView[] }
  | { kind: "asleep" }
  | { kind: "unreachable" }
  /** Its automations need a Manor host server, and it has none. */
  | { kind: "unsupported" };

export function isNoHostServer(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e?.code === UNAVAILABLE_HOST_CODE) return true;
  return typeof e?.message === "string" && e.message.includes("has no Manor host server");
}

/** The message of a refused write, for the page to show inline. */
export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // A bridge error carries main's wrapper: keep only what main said.
  return message.replace(/^Error invoking remote method '[^']*': (Error: )?/, "");
}

/** How long a burst of a run's agent status changes settles before it is re-read. */
const STATUS_SETTLE_MS = 800;

function shouldAsk(host: AutomationHost): boolean {
  return host.local || host.status === "connected";
}

function settled(host: AutomationHost): HostListState | null {
  if (shouldAsk(host)) return null;
  if (host.status === "sleeping") return { kind: "asleep" };
  // Asked once it is up: the host store's change re-reads it.
  if (host.status === "connecting" || host.status === "reconnecting") return { kind: "loading" };
  return { kind: "unreachable" };
}

/** A trailing debounce: `run` once `ms` pass without another `poke`. */
function debounced(ms: number, run: () => void): { poke: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    poke: () => {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        run();
      }, ms);
    },
    cancel,
  };
}

/**
 * Each host's automations, kept current: re-read when a host's store
 * changes (`automations.onChanged`), when a host comes up, and — since a
 * run's status is its Agent's — a beat after the agent of a listed last run
 * changes status. `paused` (another view covers the list) stops that last.
 */
export function useAutomationLists(opts: { paused?: boolean } = {}): Record<string, HostListState> {
  const [lists, setLists] = useState<Record<string, HostListState>>({});
  const paused = opts.paused ?? false;
  const view = useRef({ lists, paused });
  const reloadAll = useRef<() => void>(() => {});
  // Back from under another view: the runs' statuses it skipped are re-read.
  if (view.current.paused && !paused) queueMicrotask(() => reloadAll.current());
  view.current = { lists, paused };

  useMountEffect(() => {
    let live = true;
    const asked = new Map<string, number>();
    const lastStatus = new Map<string, string>();

    const load = (host: AutomationHost) => {
      const stateNow = settled(host);
      if (stateNow) {
        setLists((prev) => ({ ...prev, [host.hostId]: stateNow }));
        return;
      }
      const ticket = (asked.get(host.hostId) ?? 0) + 1;
      asked.set(host.hostId, ticket);
      window.electronAPI.automations.list(host.hostId).then(
        (automations) => {
          if (!live || asked.get(host.hostId) !== ticket) return;
          setLists((prev) => ({ ...prev, [host.hostId]: { kind: "ready", automations } }));
        },
        (err: unknown) => {
          if (!live || asked.get(host.hostId) !== ticket) return;
          const next: HostListState = isNoHostServer(err)
            ? { kind: "unsupported" }
            : { kind: "unreachable" };
          setLists((prev) => ({ ...prev, [host.hostId]: next }));
        },
      );
    };

    const loadAll = () => {
      for (const host of currentHosts()) {
        lastStatus.set(host.hostId, host.status);
        load(host);
      }
    };
    loadAll();
    reloadAll.current = () => {
      if (live) loadAll();
    };

    // A host that comes up, goes to sleep, or joins is read again.
    const offHosts = useHostStore.subscribe(() => {
      if (!live) return;
      for (const host of currentHosts()) {
        if (lastStatus.get(host.hostId) === host.status) continue;
        lastStatus.set(host.hostId, host.status);
        load(host);
      }
    });

    const offChanged = window.electronAPI.automations.onChanged((info) => {
      const host = currentHosts().find((h) => h.hostId === info.hostId);
      if (host) load(host);
      // A host id the page doesn't know (a phone's own name for it): read all.
      else loadAll();
    });

    // Only the hosts listing a last run in the pane whose agent changed.
    const stale = new Set<string>();
    const reread = debounced(STATUS_SETTLE_MS, () => {
      if (!live) return;
      for (const host of currentHosts()) if (stale.has(host.hostId) && shouldAsk(host)) load(host);
      stale.clear();
    });
    const offStatus = window.electronAPI.agents.onStatus((update) => {
      if (view.current.paused) return;
      const hostIds = hostsShowingPane(view.current.lists, update.paneId);
      if (hostIds.length === 0) return;
      for (const hostId of hostIds) stale.add(hostId);
      reread.poke();
    });

    return () => {
      live = false;
      reread.cancel();
      offHosts();
      offChanged();
      offStatus();
    };
  });

  return lists;
}

/** The hosts whose list shows a last run in `paneId`. */
function hostsShowingPane(lists: Record<string, HostListState>, paneId: string): string[] {
  return Object.entries(lists).flatMap(([hostId, state]) =>
    state.kind === "ready" && state.automations.some((a) => a.lastRun?.paneId === paneId)
      ? [hostId]
      : [],
  );
}

/**
 * One automation with its runs, kept current the same way. `null` while
 * loading; `missing` once the host says it has no such automation.
 * `onMissing`, when given, is called instead when the first read finds it
 * missing or fails (a stale link to it).
 */
export function useAutomationDetail(
  hostId: string,
  id: string,
  onMissing?: () => void,
): {
  detail: AutomationDetail | null | "missing";
  setDetail: (detail: AutomationDetail) => void;
  reload: () => void;
} {
  const [detail, setDetail] = useState<AutomationDetail | null | "missing">(null);
  const reloadRef = useRef<() => void>(() => {});
  const shown = useRef<AutomationDetail | null | "missing">(null);
  shown.current = detail;
  const missingRef = useRef(onMissing);
  missingRef.current = onMissing;

  useMountEffect(() => {
    let live = true;
    let ticket = 0;
    let first = true;
    const load = () => {
      const mine = ++ticket;
      const isFirst = first;
      first = false;
      window.electronAPI.automations.get(hostId, id).then(
        (next) => {
          if (!live || mine !== ticket) return;
          if (!next && isFirst && missingRef.current) missingRef.current();
          else setDetail(next ?? "missing");
        },
        () => {
          // Away for a moment: keep what is shown.
          if (live && isFirst && missingRef.current) missingRef.current();
        },
      );
    };
    reloadRef.current = load;
    load();
    const offChanged = window.electronAPI.automations.onChanged((info) => {
      if (info.automationId === id) load();
    });
    // Only a status change of one of its runs' agents.
    const reread = debounced(STATUS_SETTLE_MS, () => {
      if (live) load();
    });
    const offStatus = window.electronAPI.agents.onStatus((update) => {
      const now = shown.current;
      if (now && now !== "missing" && now.runs.some((r) => r.paneId === update.paneId)) reread.poke();
    });
    return () => {
      live = false;
      reread.cancel();
      offChanged();
      offStatus();
    };
  });

  return { detail, setDetail, reload: () => reloadRef.current() };
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { useHostStore, selectHost, type HostStatusInfo } from "../store/host-store";
import {
  directReachability,
  useDirectReachability,
  useSelected,
  useServerHostName,
  useViaReachability,
  viaReachability,
  type Reachability,
} from "../bridge/server-set";
import { describeHost, sourcedHost, type HostDisplay } from "../lib/host-status";
import { LOCAL_HOST_ID } from "../lib/hosts";

/**
 * How a remote host looks right now, or undefined for this machine or a
 * host main hasn't reported. Ticks once a second while a reconnect is
 * scheduled so the countdown stays live; otherwise it only re-renders when
 * the host's status changes, or this page's own bridge to it does, or the
 * servers that list it do (`sourcedHost`). A host this page
 * reaches through a relay room goes by `useServerHostName`, not its room id.
 */
export function useHostDisplay(hostId: string | null | undefined): HostDisplay | undefined {
  const remoteHostId = hostId && hostId !== LOCAL_HOST_ID ? hostId : null;
  const reported = useHostStore(selectHost(remoteHostId));
  const direct = useDirectReachability(remoteHostId);
  const via = useViaReachability(remoteHostId);
  const serverName = useServerHostName(remoteHostId);
  const sourced = sourcedHost(reported, direct, via);
  const host = sourced && serverName ? { ...sourced, label: serverName } : sourced;
  const [now, setNow] = useState(() => Date.now());

  const counting = host?.status === "reconnecting" && host.retryAt !== undefined;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);

  return remoteHostId ? describeHost(host, now) : undefined;
}

/**
 * Main's host list as this page sees it (`sourcedHost`), live: a host main
 * failed to reach that this page holds its own connected bridge to reads
 * connected. What a host picker disables by, so a phone paired to a host
 * directly can pick it while the desktop's ssh to it is down.
 */
export function useSourcedHosts(): readonly HostStatusInfo[] {
  const hosts = useHostStore((s) => s.hosts);
  // As one string, so the selector's value is equal while nothing moved.
  const reach = useSelected(
    useCallback(
      () =>
        hosts
          .map((h) => `${directReachability(h.hostId) ?? ""},${viaReachability(h.hostId) ?? ""}`)
          .join("\n"),
      [hosts],
    ),
  );
  return useMemo(() => {
    const pairs = reach.split("\n").map((line) => line.split(",") as [string, string]);
    return hosts.map((host, i) => {
      const [direct, via] = pairs[i] ?? ["", ""];
      const sourced = sourcedHost(
        host,
        (direct || undefined) as Reachability | undefined,
        (via || undefined) as Reachability | undefined,
      );
      return sourced ?? host;
    });
  }, [hosts, reach]);
}

import { useEffect, useState } from "react";
import { useHostStore, selectHost } from "../store/host-store";
import { describeHost, type HostDisplay } from "../lib/host-status";
import { LOCAL_HOST_ID } from "../lib/hosts";

/**
 * How a remote host looks right now, or undefined for this machine or a
 * host main hasn't reported. Ticks once a second while a reconnect is
 * scheduled so the countdown stays live; otherwise it only re-renders when
 * the host's status changes.
 */
export function useHostDisplay(hostId: string | null | undefined): HostDisplay | undefined {
  const remoteHostId = hostId && hostId !== LOCAL_HOST_ID ? hostId : null;
  const host = useHostStore(selectHost(remoteHostId));
  const [now, setNow] = useState(() => Date.now());

  const counting = host?.status === "reconnecting" && host.retryAt !== undefined;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);

  return remoteHostId ? describeHost(host, now) : undefined;
}

import { useCallback, useMemo } from "react";

import { isHostAway, useSelected } from "../bridge/server-set";
import { useHostStore } from "../store/host-store";

/**
 * Whether host `hostId` is away (`isHostAway`), live: by main's host list and
 * this page's own servers. This machine (a missing id) never is.
 */
export function useHostAway(hostId: string | null | undefined): boolean {
  const hosts = useHostStore((s) => s.hosts);
  return useSelected(useCallback(() => isHostAway(hostId, hosts), [hostId, hosts]));
}

/**
 * Which of `hostIds` are away now (`isHostAway`), live: a linked group's
 * sections and its host state read the same answer.
 */
export function useAwayHosts(
  hostIds: readonly (string | null | undefined)[],
): ReadonlySet<string> {
  const hosts = useHostStore((s) => s.hosts);
  // As one string, so the selector's value is equal while nothing moved.
  const key = hostIds.filter((id): id is string => !!id).join("\n");
  const away = useSelected(
    useCallback(
      () =>
        key
          .split("\n")
          .filter((id) => id && isHostAway(id, hosts))
          .join("\n"),
      [key, hosts],
    ),
  );
  return useMemo(() => new Set(away ? away.split("\n") : []), [away]);
}
